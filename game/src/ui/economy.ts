import { roleLabel, t } from '../i18n';
import type { EconomyResponse, FlowEdge, Recipe, Tech } from '../net/protocol';
import { session } from '../net/session';
import { roleColors } from '../render/palette';
import { store } from '../state/store';
import { h, throttle, uiRoot } from './dom';
import { bagChips } from './inventory';
import { itemIconUrl } from './itemIcons';
import { panels } from './panels';

const NS = 'http://www.w3.org/2000/svg';

/** Tiny SVG builder (the DOM helper only makes HTML elements). */
function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: (Node | string | null)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) if (c !== null) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}

const roleColor = (r: string) => roleColors(r).shirt[0];
const clip = (txt: string, n: number) => (txt.length > n ? `${txt.slice(0, n - 1)}…` : txt);

/**
 * Economy panel: technology tree (discovered vs unknown), discovered recipes by role, and a live
 * flow diagram between roles that makes the circular dependency visible.
 */
export function mountEconomy(): void {
  const note = h('div', { class: 'note' });
  const tree = h('div', { class: 'econ-tree' });
  const flows = h('div', { class: 'econ-flows' });
  const recipes = h('div', { class: 'econ-recipes' });
  const body = h(
    'div',
    { class: 'scroll econ-body' },
    h('div', { class: 'econ-grid' }, h('section', {}, h('div', { class: 'section-title' }, t('econ.techs')), tree), h('section', {}, h('div', { class: 'section-title' }, t('econ.flows')), flows)),
    h('div', { class: 'section-title' }, t('econ.recipes')),
    recipes,
  );
  const el = h(
    'div',
    { class: 'px panel econ hidden' },
    h('button', { class: 'btn x-btn', onclick: () => panels.set('economy', false) }, 'X'),
    h('div', { class: 'px-title' }, t('econ.title')),
    h('div', { class: 'note' }, t('econ.subtitle')),
    note,
    body,
  );
  uiRoot().append(el);

  let restFlows: FlowEdge[] | null = null;
  let stale = true;

  const load = async () => {
    const tr = session.transport;
    if (!tr || !stale) return;
    if (!store.economy.known) note.textContent = t('econ.loading');
    try {
      const eco = await tr.getJson<EconomyResponse>('/economy');
      stale = false;
      if (eco.flows) restFlows = eco.flows;
      store.setEconomy(eco);
      note.textContent = '';
    } catch {
      note.textContent = store.economy.known ? '' : t('econ.unavailable');
    }
  };

  const render = () => {
    renderTree(tree);
    renderFlows(flows, store.flows?.edges ?? restFlows ?? [], store.flows?.window);
    renderRecipes(recipes);
  };

  panels.register({ id: 'economy', key: 'e', defaultOpen: false, el, slot: 'center', onOpen: () => (render(), void load()) });
  const schedule = throttle(() => panels.isOpen('economy') && render(), 400);
  store.on('economy', schedule);
  store.on('flows', schedule);
  store.on('discovery', () => {
    stale = true;
    if (panels.isOpen('economy')) setTimeout(() => void load(), 600);
  });
}

// ------------------------------------------------------------------ technology tree

function renderTree(host: HTMLElement): void {
  const techs = [...store.economy.techs.values()];
  if (!techs.length) {
    host.replaceChildren(h('div', { class: 'note' }, store.economy.known ? t('econ.noRecipes') : t('econ.unavailable')));
    return;
  }
  const techCodes = new Set(techs.map((x) => x.code));
  // depth along tech -> tech unlock edges (cycle-safe)
  const depth = new Map<string, number>();
  const parentsOf = new Map<string, string[]>();
  for (const tc of techs) for (const u of tc.unlocks) if (techCodes.has(u)) parentsOf.set(u, [...(parentsOf.get(u) ?? []), tc.code]);
  const depthOf = (code: string, seen = new Set<string>()): number => {
    if (depth.has(code)) return depth.get(code)!;
    if (seen.has(code)) return 0;
    seen.add(code);
    const d = Math.max(-1, ...(parentsOf.get(code) ?? []).map((p) => depthOf(p, seen))) + 1;
    depth.set(code, d);
    return d;
  };
  techs.forEach((x) => depthOf(x.code));
  const maxDepth = Math.max(0, ...depth.values());
  const order = [...techs].sort((a, b) => depth.get(a.code)! - depth.get(b.code)! || Number(b.discovered) - Number(a.discovered));

  const COL = 168;
  const TW = 150;
  const TH = 34;
  const RW = 132;
  const RH = 20;
  const ROW = 26;
  const leafX = (maxDepth + 1) * COL + 6;
  const nodes = new Map<string, { x: number; y: number; w: number; h: number }>();
  const leafRow: { code: string; parent: string }[] = [];
  for (const tc of order) for (const u of tc.unlocks) if (!techCodes.has(u) && !leafRow.some((l) => l.code === u)) leafRow.push({ code: u, parent: tc.code });
  leafRow.forEach((l, i) => nodes.set(`r:${l.code}`, { x: leafX, y: 6 + i * ROW, w: RW, h: RH }));
  const colY = new Array(maxDepth + 1).fill(4);
  for (const tc of order) {
    const d = depth.get(tc.code)!;
    const kids = tc.unlocks.map((u) => nodes.get(techCodes.has(u) ? `t:${u}` : `r:${u}`)).filter((n): n is NonNullable<typeof n> => !!n);
    const want = kids.length ? kids.reduce((a, n) => a + n.y + n.h / 2, 0) / kids.length - TH / 2 : colY[d];
    const y = Math.max(want, colY[d]);
    nodes.set(`t:${tc.code}`, { x: d * COL + 4, y, w: TW, h: TH });
    colY[d] = y + TH + 10;
  }
  const height = Math.max(...[...nodes.values()].map((n) => n.y + n.h)) + 8;
  const width = leafX + RW + 6;
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, class: 'tree-svg', width: '100%', preserveAspectRatio: 'xMinYMin meet' });

  for (const tc of order) {
    const a = nodes.get(`t:${tc.code}`)!;
    for (const u of tc.unlocks) {
      const b = nodes.get(techCodes.has(u) ? `t:${u}` : `r:${u}`);
      if (!b) continue;
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      const y2 = b.y + b.h / 2;
      const mx = (x1 + x2) / 2;
      svg.append(s('path', { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, class: `edge${tc.discovered ? ' on' : ''}` }));
    }
  }
  for (const tc of order) svg.append(techNode(tc, nodes.get(`t:${tc.code}`)!));
  for (const l of leafRow) svg.append(recipeNode(l.code, nodes.get(`r:${l.code}`)!));
  const hidden = store.economy.hiddenRecipes;
  host.replaceChildren(svg);
  if (hidden) host.append(h('div', { class: 'note' }, t('econ.hidden', { n: hidden })));
}

function techNode(tc: Tech, n: { x: number; y: number; w: number; h: number }): SVGGElement {
  const known = tc.discovered;
  const sub = known
    ? tc.discoveredBy
      ? t('econ.discoveredBy', { who: tc.discoveredBy, day: tc.discoveredAt?.day ?? '?' })
      : ''
    : t('econ.notYet');
  const g = s(
    'g',
    { class: `tech${known ? ' known' : ' unknown'}`, transform: `translate(${n.x},${n.y})` },
    s('title', {}, known ? `${tc.name}${tc.description ? ` — ${tc.description}` : ''}` : t('econ.unknown')),
    s('rect', { width: n.w, height: n.h, rx: 2 }),
    s('text', { x: 8, y: 14, class: 'tname' }, known ? clip(tc.name, 20) : t('econ.unknown')),
    s('text', { x: 8, y: 27, class: 'tsub' }, clip(sub, 26)),
  );
  return g;
}

function recipeNode(code: string, n: { x: number; y: number; w: number; h: number }): SVGGElement {
  const r = store.economy.recipes.get(code);
  const name = r?.name ?? (store.economy.techs.get(code)?.name || t('econ.unknown'));
  const known = !!r;
  const out = r ? Object.keys(r.outputs)[0] ?? code : code;
  return s(
    'g',
    { class: `rnode${known ? ' known' : ' unknown'}`, transform: `translate(${n.x},${n.y})` },
    s('title', {}, name),
    s('rect', { width: n.w, height: n.h, rx: 2 }),
    known ? s('image', { href: itemIconUrl(out, store.itemName(out)), x: 4, y: 3, width: 14, height: 14, class: 'px-img' }) : null,
    s('text', { x: known ? 22 : 8, y: 14 }, clip(name, 18)),
  );
}

// ------------------------------------------------------------------ flows (chord / arc diagram)

/** One closed loop through the role graph, preferring the longest simple cycle (small graphs only). */
function findCycle(adj: Map<string, Set<string>>): string[] {
  let best: string[] = [];
  const nodes = [...adj.keys()];
  const dfs = (start: string, cur: string, path: string[], seen: Set<string>) => {
    for (const nx of adj.get(cur) ?? []) {
      if (nx === start && path.length > best.length - 1 && path.length >= 2) best = [...path, start];
      else if (!seen.has(nx) && nodes.indexOf(nx) > nodes.indexOf(start) && path.length < 8) {
        seen.add(nx);
        dfs(start, nx, [...path, nx], seen);
        seen.delete(nx);
      }
    }
  };
  for (const n of nodes) dfs(n, n, [n], new Set([n]));
  return best;
}

function renderFlows(host: HTMLElement, edges: FlowEdge[], window?: number): void {
  if (!edges.length) {
    host.replaceChildren(h('div', { class: 'note' }, t('econ.noFlows')));
    return;
  }
  const pair = new Map<string, { from: string; to: string; total: number; items: Map<string, number> }>();
  for (const e of edges) {
    if (!(e.amount > 0) || e.fromRole === e.toRole) continue;
    const k = `${e.fromRole}>${e.toRole}`;
    const p = pair.get(k) ?? { from: e.fromRole, to: e.toRole, total: 0, items: new Map() };
    p.total += e.amount;
    p.items.set(e.item, (p.items.get(e.item) ?? 0) + e.amount);
    pair.set(k, p);
  }
  const roles = [...new Set([...pair.values()].flatMap((p) => [p.from, p.to]))].sort();
  const adj = new Map<string, Set<string>>(roles.map((r) => [r, new Set()]));
  for (const p of pair.values()) adj.get(p.from)!.add(p.to);
  const cycle = findCycle(adj);
  const inCycle = new Set<string>();
  for (let i = 0; i + 1 < cycle.length; i++) inCycle.add(`${cycle[i]}>${cycle[i + 1]}`);

  const W = 320;
  const C = W / 2;
  const R = 112;
  const pos = new Map(roles.map((r, i) => {
    const a = -Math.PI / 2 + (i / roles.length) * Math.PI * 2;
    return [r, { x: C + Math.cos(a) * R, y: C + Math.sin(a) * R, a }];
  }));
  const max = Math.max(1, ...[...pair.values()].map((p) => p.total));
  const svg = s('svg', { viewBox: `0 0 ${W} ${W}`, class: 'flow-svg', width: '100%' });
  const defs = s('defs');
  for (const r of roles) {
    defs.append(s('marker', { id: `arr-${cssId(r)}`, viewBox: '0 0 6 6', refX: 5, refY: 3, markerWidth: 4, markerHeight: 4, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L6,3 L0,6 z', fill: roleColor(r) })));
  }
  svg.append(defs);
  svg.append(s('circle', { cx: C, cy: C, r: R, class: 'ring' }));

  const NODE_R = 15;
  for (const p of pair.values()) {
    const a = pos.get(p.from)!;
    const b = pos.get(p.to)!;
    // shorten to the node rims, bend toward the centre, offset so A->B and B->A do not overlap
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const x1 = a.x + ux * NODE_R;
    const y1 = a.y + uy * NODE_R;
    const x2 = b.x - ux * (NODE_R + 3);
    const y2 = b.y - uy * (NODE_R + 3);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const cx = mx + (C - mx) * 0.45 - uy * 16;
    const cy = my + (C - my) * 0.45 + ux * 16;
    const d = `M${x1.toFixed(1)},${y1.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
    const width = 1.5 + (p.total / max) * 6;
    const cyc = inCycle.has(`${p.from}>${p.to}`);
    const tip = `${roleLabel(p.from)} → ${roleLabel(p.to)}: ${[...p.items].map(([it, n]) => `${n} ${store.itemName(it)}`).join(', ')}`;
    const g = s('g', { class: `flow${cyc ? ' cyc' : ''}` }, s('title', {}, tip));
    if (cyc) g.append(s('path', { d, class: 'glow', 'stroke-width': width + 5 }));
    g.append(s('path', { d, class: 'base', stroke: roleColor(p.from), 'stroke-width': width, 'marker-end': `url(#arr-${cssId(p.from)})` }));
    g.append(s('path', { d, class: 'dash', 'stroke-width': Math.max(1, width - 1.5), style: `animation-duration:${(2.6 - (p.total / max) * 1.6).toFixed(2)}s` }));
    // icon of the main item at the curve's midpoint
    const main = [...p.items].sort((m, n) => n[1] - m[1])[0]?.[0];
    if (main) {
      const qx = 0.25 * x1 + 0.5 * cx + 0.25 * x2;
      const qy = 0.25 * y1 + 0.5 * cy + 0.25 * y2;
      g.append(s('image', { href: itemIconUrl(main, store.itemName(main)), x: qx - 6, y: qy - 6, width: 12, height: 12, class: 'px-img' }));
    }
    svg.append(g);
  }
  for (const r of roles) {
    const p = pos.get(r)!;
    const lx = C + Math.cos(p.a) * (R + 26);
    const ly = C + Math.sin(p.a) * (R + 26);
    const anchor = Math.abs(Math.cos(p.a)) < 0.3 ? 'middle' : Math.cos(p.a) > 0 ? 'start' : 'end';
    svg.append(
      s(
        'g',
        { class: `role-node${cycle.includes(r) ? ' cyc' : ''}` },
        s('circle', { cx: p.x, cy: p.y, r: NODE_R, fill: roleColor(r) }),
        s('text', { x: p.x, y: p.y + 4, 'text-anchor': 'middle', class: 'initial' }, roleLabel(r).slice(0, 2).toUpperCase()),
        s('text', { x: lx, y: ly + 4, 'text-anchor': anchor, class: 'rlabel' }, roleLabel(r)),
      ),
    );
  }
  const path = cycle.length ? t('econ.cycle', { path: cycle.map(roleLabel).join(' → ') }) : t('econ.noCycle');
  host.replaceChildren(svg, h('div', { class: `note cycle-note${cycle.length ? ' on' : ''}` }, path), h('div', { class: 'note' }, t('econ.flowsNote', { s: window ?? 30 })));
}

const cssId = (r: string) => r.replace(/[^a-z0-9_-]/gi, '_');

// ------------------------------------------------------------------ recipes

function renderRecipes(host: HTMLElement): void {
  const byRole = new Map<string, Recipe[]>();
  for (const r of store.economy.recipes.values()) byRole.set(r.role, [...(byRole.get(r.role) ?? []), r]);
  if (!byRole.size) {
    host.replaceChildren(h('div', { class: 'note' }, store.economy.known ? t('econ.noRecipes') : t('econ.unavailable')));
    return;
  }
  host.replaceChildren(
    ...[...byRole].map(([role, list]) =>
      h(
        'div',
        { class: 'recipe-role', style: `--role:${roleColor(role)}` },
        h('div', { class: 'rr-head' }, h('span', { class: 'role-dot' }), roleLabel(role)),
        ...list.map((r) =>
          h(
            'div',
            { class: 'recipe' },
            h('span', { class: 'r-in' }, ...bagChips(r.inputs)),
            h('span', { class: 'r-arrow' }, '→'),
            h('span', { class: 'r-out' }, ...bagChips(r.outputs)),
            h('span', { class: 'r-name' }, r.name),
            h('span', { class: 'r-meta muted' }, r.station ? t('econ.station', { s: r.station }) : t('econ.byHand'), r.tech ? ` · ${store.economy.techs.get(r.tech)?.name ?? r.tech}` : ''),
          ),
        ),
      ),
    ),
  );
}
