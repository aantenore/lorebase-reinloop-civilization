import { roleLabel, t, type I18nKey } from '../i18n';
import type { Family, Person, SocietyResponse } from '../net/protocol';
import { session } from '../net/session';
import { familyColor, scoreColor } from '../render/palette';
import { store } from '../state/store';
import { h, throttle, uiRoot } from './dom';
import { focusEntity, segmented } from './god/godShared';
import { tierBadge } from './inspector';
import { panels } from './panels';

const NS = 'http://www.w3.org/2000/svg';
function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: (Node | string | null)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) if (c !== null) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}

type View = 'rank' | 'tree' | 'opinions';
type SortCol = 'rank' | 'name' | 'role' | 'tier' | 'family' | 'esteem' | 'fame' | 'age';

const GOD_PANEL = 'god';
const PANEL = 'society';
const STAGE_ORDER = { child: 0, adult: 1, elder: 2 } as const;
const TIER_ORDER: Record<string, number> = { opus: 0, sonnet: 1, haiku: 2, human: 3 };

export const ageLabel = (stage: string | undefined) => (stage ? t(`age.${stage}` as I18nKey) : '');
const pct = (v: number) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
const clip = (txt: string, n: number) => (txt.length > n ? `${txt.slice(0, n - 1)}…` : txt);

/** Navigation hook used by the inspector (family link). */
export const societyNav = { openFamily: (_id: string) => {} };

/** Esteem bar (0-1). */
export function esteemBar(v: number): HTMLElement {
  return h('span', { class: 'esteem-bar', title: `${t('soc.esteem')} ${pct(v)}` }, h('i', { style: `width:${pct(v)}` }));
}

/**
 * Society panel: ranking of esteem and fame, dynasties across generations and, in god mode,
 * the opinion graph of who esteems whom.
 */
export function mountSociety(): void {
  const viewHost = h('div', { class: 'soc-views' });
  const note = h('div', { class: 'note' });
  const body = h('div', { class: 'scroll soc-body' });
  const el = h(
    'div',
    { class: 'px panel soc hidden' },
    h('button', { class: 'btn x-btn', onclick: () => panels.set(PANEL, false) }, 'X'),
    h('div', { class: 'px-title' }, t('soc.title')),
    h('div', { class: 'note' }, t('soc.subtitle')),
    viewHost,
    note,
    body,
  );
  uiRoot().append(el);

  let view: View = 'rank';
  let sort: { col: SortCol; dir: 1 | -1 } = { col: 'rank', dir: 1 };
  let stale = true;
  let focusFamily: string | null = null;

  const godOn = () => panels.isOpen(GOD_PANEL);
  const renderTabs = () => {
    if (view === 'opinions' && !godOn()) view = 'rank';
    const opts: { value: View; label: string }[] = [
      { value: 'rank', label: t('soc.view.rank') },
      { value: 'tree', label: t('soc.view.tree') },
    ];
    if (godOn()) opts.push({ value: 'opinions', label: t('soc.view.opinions') });
    viewHost.replaceChildren(segmented(opts, view, (v) => ((view = v), render())));
  };

  const load = async () => {
    const tr = session.transport;
    if (!tr || !stale) return;
    if (!store.societyKnown) note.textContent = t('soc.loading');
    try {
      store.setSociety(await tr.getJson<SocietyResponse>('/society'));
      stale = false;
      note.textContent = '';
    } catch {
      note.textContent = store.societyKnown ? '' : t('soc.unavailable');
    }
  };

  const render = () => {
    renderTabs();
    const prev = body.scrollTop;
    if (view === 'rank') body.replaceChildren(rankingTable(sort, (col) => {
      sort = sort.col === col ? { col, dir: (sort.dir * -1) as 1 | -1 } : { col, dir: col === 'esteem' || col === 'fame' ? -1 : 1 };
      render();
    }));
    else if (view === 'tree') body.replaceChildren(dynasties());
    else body.replaceChildren(opinionGraph());
    body.scrollTop = prev;
    if (view === 'tree' && focusFamily) {
      body.querySelector(`[data-family="${CSS.escape(focusFamily)}"]`)?.scrollIntoView({ block: 'start' });
      focusFamily = null;
    }
  };

  societyNav.openFamily = (id: string) => {
    view = 'tree';
    focusFamily = id;
    if (panels.isOpen(PANEL)) render();
    else panels.set(PANEL, true);
  };

  panels.register({ id: PANEL, key: 'o', defaultOpen: false, el, slot: 'center', onOpen: () => (render(), void load()) });
  const schedule = throttle(() => panels.isOpen(PANEL) && render(), 500);
  store.on('society', schedule);
  store.on('entity_delta', ({ e, prevAlive }) => prevAlive !== e.alive && schedule());
  store.on('hello', () => {
    stale = true;
    if (panels.isOpen(PANEL)) void load();
  });
  panels.onChange((id) => id === GOD_PANEL && panels.isOpen(PANEL) && render());
}

// ------------------------------------------------------------------ ranking

function sortValue(p: Person, col: SortCol): string | number {
  switch (col) {
    case 'rank': return p.rank > 0 ? p.rank : 1e9;
    case 'name': return p.name.toLowerCase();
    case 'role': return roleLabel(p.role);
    case 'tier': return TIER_ORDER[p.tier] ?? 9;
    case 'family': return p.family ? (store.families.get(p.family)?.name ?? p.family) : '~';
    case 'esteem': return p.esteem;
    case 'fame': return p.fame;
    case 'age': return STAGE_ORDER[p.age?.stage ?? 'adult'] * 1e6 + (p.age?.days ?? 0);
  }
}

function livingPeople(): Person[] {
  const ids = new Set([...store.people.keys(), ...store.entities.keys()]);
  return [...ids].map((id) => store.person(id)).filter((p): p is Person => !!p && p.alive);
}

function rankingTable(sort: { col: SortCol; dir: 1 | -1 }, onSort: (c: SortCol) => void): HTMLElement {
  const people = livingPeople().sort((a, b) => {
    const x = sortValue(a, sort.col);
    const y = sortValue(b, sort.col);
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || a.rank - b.rank;
  });
  if (!people.length) return h('div', { class: 'note' }, store.societyKnown ? t('soc.empty') : t('soc.unavailable'));
  const cols: { col: SortCol; label: I18nKey }[] = [
    { col: 'rank', label: 'soc.col.rank' },
    { col: 'name', label: 'soc.col.name' },
    { col: 'role', label: 'soc.col.role' },
    { col: 'tier', label: 'soc.col.tier' },
    { col: 'family', label: 'soc.col.family' },
    { col: 'esteem', label: 'soc.col.esteem' },
    { col: 'fame', label: 'soc.col.fame' },
    { col: 'age', label: 'soc.col.age' },
  ];
  const head = h(
    'div',
    { class: 'soc-tr soc-th' },
    ...cols.map((c) => h('button', { class: `soc-sort${sort.col === c.col ? ' on' : ''}`, onclick: () => onSort(c.col) }, t(c.label), sort.col === c.col ? (sort.dir > 0 ? ' ▲' : ' ▼') : '')),
  );
  const rows = people.map((p) => {
    const fam = p.family ? store.families.get(p.family) : undefined;
    return h(
      'div',
      { class: `soc-tr${p.rank >= 1 && p.rank <= 3 ? ` top top-${p.rank}` : ''}`, onclick: () => focusEntity(p.id) },
      h('span', { class: 'soc-rank' }, p.rank > 0 ? `#${p.rank}` : '–'),
      h('span', { class: 'soc-name' }, p.name),
      h('span', {}, roleLabel(p.role)),
      h('span', {}, tierBadge(p.effectiveTier ?? p.tier)),
      h('span', { class: 'soc-fam' }, p.family ? h('i', { class: 'fam-sw', style: `background:${familyColor(p.family, fam?.color)}` }) : null, fam?.name ?? (p.family ? p.family : t('soc.noFamily'))),
      h('span', {}, esteemBar(p.esteem)),
      h('span', { class: 'soc-num' }, String(Math.round(p.fame))),
      h('span', { class: 'muted' }, ageLabel(p.age?.stage)),
    );
  });
  return h('div', { class: 'soc-table' }, head, ...rows);
}

// ------------------------------------------------------------------ dynasties

interface TreeNode {
  id: string;
  p: Person | undefined;
  gen: number;
  external: boolean;
  x: number;
  y: number;
}

function dynasties(): HTMLElement {
  const fams = [...store.families.values()].sort((a, b) => b.esteem - a.esteem);
  if (!fams.length) return h('div', { class: 'note' }, store.societyKnown ? t('soc.noFamilies') : t('soc.unavailable'));
  return h('div', { class: 'soc-fams' }, ...fams.map(familyCard));
}

function familyCard(f: Family): HTMLElement {
  const color = familyColor(f.id, f.color);
  const total = new Set([...f.members, ...[...store.people.values()].filter((p) => p.family === f.id).map((p) => p.id)]).size;
  return h(
    'div',
    { class: 'px soc-fam-card', 'data-family': f.id, style: `--fam:${color}` },
    h(
      'div',
      { class: 'soc-fam-head' },
      h('i', { class: 'fam-sw', style: `background:${color}` }),
      h('b', {}, f.name),
      h('span', { class: 'muted' }, t('soc.famAlive', { n: f.alive, total })),
      esteemBar(f.esteem),
    ),
    familyTree(f),
  );
}

function familyTree(f: Family): Node {
  const members = new Set([...f.members, ...[...store.people.values()].filter((p) => p.family === f.id).map((p) => p.id)]);
  const genMemo = new Map<string, number>();
  const genOf = (id: string, seen = new Set<string>()): number => {
    if (genMemo.has(id)) return genMemo.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const par = (store.person(id)?.parents ?? []).filter((x) => members.has(x));
    const g = par.length ? Math.max(...par.map((x) => genOf(x, seen))) + 1 : 0;
    genMemo.set(id, g);
    return g;
  };
  const nodes = new Map<string, TreeNode>();
  for (const id of members) nodes.set(id, { id, p: store.person(id), gen: genOf(id), external: false, x: 0, y: 0 });
  // parents who married into the family sit beside their partner
  for (const id of members) {
    const n = nodes.get(id)!;
    for (const par of n.p?.parents ?? []) {
      if (members.has(par) || nodes.has(par)) continue;
      nodes.set(par, { id: par, p: store.person(par), gen: Math.max(0, n.gen - 1), external: true, x: 0, y: 0 });
    }
  }
  const NW = 118;
  const NH = 36;
  const GX = 14;
  const GY = 26;
  const rows = new Map<number, TreeNode[]>();
  for (const n of nodes.values()) rows.set(n.gen, [...(rows.get(n.gen) ?? []), n]);
  const gens = [...rows.keys()].sort((a, b) => a - b);
  const width = Math.max(...[...rows.values()].map((r) => r.length)) * (NW + GX) + GX;
  for (const g of gens) {
    const row = rows.get(g)!;
    // keep children under their parents, partners next to each other
    const anchorX = (n: TreeNode) => {
      const ps = (n.p?.parents ?? []).map((x) => nodes.get(x)).filter((x): x is TreeNode => !!x && x.gen < g);
      if (ps.length) return ps.reduce((a, x) => a + x.x, 0) / ps.length;
      const kid = [...nodes.values()].find((k) => k.p?.parents?.includes(n.id));
      const partner = kid?.p?.parents?.find((x) => x !== n.id);
      return partner && !n.external ? -1 : n.external ? 1e6 : 0;
    };
    row.sort((a, b) => anchorX(a) - anchorX(b) || Number(a.external) - Number(b.external) || (a.id === f.founder ? -1 : b.id === f.founder ? 1 : 0));
    const off = (width - row.length * (NW + GX) + GX) / 2;
    row.forEach((n, i) => {
      n.x = off + i * (NW + GX) + NW / 2;
      n.y = 6 + gens.indexOf(g) * (NH + GY);
    });
  }
  const height = gens.length * (NH + GY) - GY + 12;
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, class: 'soc-tree', width: Math.min(width, 900), preserveAspectRatio: 'xMinYMin meet' });
  for (const n of nodes.values()) {
    for (const par of n.p?.parents ?? []) {
      const a = nodes.get(par);
      if (!a || a.gen >= n.gen) continue;
      const y1 = a.y + NH;
      const y2 = n.y;
      const my = (y1 + y2) / 2;
      svg.append(s('path', { d: `M${a.x},${y1} V${my} H${n.x} V${y2}`, class: `soc-edge${a.external ? ' ext' : ''}` }));
    }
  }
  for (const n of nodes.values()) {
    const dead = n.p ? !n.p.alive : true;
    const founder = n.id === f.founder;
    const name = n.p?.name ?? store.personName(n.id);
    const sub = n.p ? `${roleLabel(n.p.role)} · ${dead ? t('soc.dead') : ageLabel(n.p.age?.stage)}` : t('soc.unknownPerson');
    const g = s(
      'g',
      { class: `soc-node${dead ? ' dead' : ''}${n.external ? ' ext' : ''}${founder ? ' founder' : ''}`, transform: `translate(${n.x - NW / 2},${n.y})` },
      s('title', {}, `${name}${founder ? ` — ${t('soc.founder')}` : ''}${n.external ? ` — ${t('soc.marriedIn')}` : ''}`),
      s('rect', { width: NW, height: NH, rx: 2 }),
      s('text', { x: 7, y: 15, class: 'nname' }, clip(`${founder ? '★ ' : ''}${name}${dead ? ' †' : ''}`, 17)),
      s('text', { x: 7, y: 29, class: 'nsub' }, clip(sub, 21)),
    );
    if (store.entities.has(n.id)) g.addEventListener('click', () => focusEntity(n.id));
    svg.append(g);
  }
  return svg;
}

// ------------------------------------------------------------------ opinions (god mode)

function opinionGraph(): HTMLElement {
  const ops = [...store.opinions.values()].filter((o) => Math.abs(o.score) >= 0.1);
  if (!ops.length) return h('div', { class: 'note' }, t('soc.noOpinions'));
  const ids = [...new Set(ops.flatMap((o) => [o.from, o.to]))].sort((a, b) => (store.person(a)?.rank ?? 99) - (store.person(b)?.rank ?? 99));
  const W = 420;
  const C = W / 2;
  const R = 160;
  const pos = new Map(ids.map((id, i) => {
    const a = -Math.PI / 2 + (i / ids.length) * Math.PI * 2;
    return [id, { x: C + Math.cos(a) * R, y: C + Math.sin(a) * R, a }];
  }));
  const svg = s('svg', { viewBox: `0 0 ${W} ${W}`, class: 'soc-op-svg', width: '100%' });
  const defs = s('defs');
  for (const [k, c] of [['pos', scoreColor(0.8)], ['neg', scoreColor(-0.8)], ['mid', scoreColor(0)]]) {
    defs.append(s('marker', { id: `op-${k}`, viewBox: '0 0 6 6', refX: 5, refY: 3, markerWidth: 4, markerHeight: 4, orient: 'auto' }, s('path', { d: 'M0,0 L6,3 L0,6 z', fill: c })));
  }
  svg.append(defs);
  const NODE_R = 13;
  for (const o of ops) {
    const a = pos.get(o.from)!;
    const b = pos.get(o.to)!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const x1 = a.x + ux * NODE_R;
    const y1 = a.y + uy * NODE_R;
    const x2 = b.x - ux * (NODE_R + 3);
    const y2 = b.y - uy * (NODE_R + 3);
    const cx = (a.x + b.x) / 2 + (C - (a.x + b.x) / 2) * 0.3 - uy * 14;
    const cy = (a.y + b.y) / 2 + (C - (a.y + b.y) / 2) * 0.3 + ux * 14;
    const mk = o.score > 0.2 ? 'pos' : o.score < -0.2 ? 'neg' : 'mid';
    svg.append(
      s(
        'path',
        { d: `M${x1.toFixed(1)},${y1.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`, class: 'soc-op', stroke: scoreColor(o.score), 'stroke-width': (1 + Math.abs(o.score) * 3).toFixed(1), 'marker-end': `url(#op-${mk})` },
        s('title', {}, `${store.personName(o.from)} → ${store.personName(o.to)}: ${o.score > 0 ? '+' : ''}${o.score.toFixed(2)}${o.reason ? ` · ${o.reason}` : ''}`),
      ),
    );
  }
  for (const id of ids) {
    const p = pos.get(id)!;
    const person = store.person(id);
    const fam = person?.family ? familyColor(person.family, store.families.get(person.family)?.color) : '#5e4466';
    const lx = C + Math.cos(p.a) * (R + 20);
    const ly = C + Math.sin(p.a) * (R + 20);
    const anchor = Math.abs(Math.cos(p.a)) < 0.3 ? 'middle' : Math.cos(p.a) > 0 ? 'start' : 'end';
    const g = s(
      'g',
      { class: 'soc-op-node' },
      s('circle', { cx: p.x, cy: p.y, r: NODE_R, fill: fam }),
      s('text', { x: p.x, y: p.y + 4, 'text-anchor': 'middle', class: 'initial' }, store.personName(id).slice(0, 2).toUpperCase()),
      s('text', { x: lx, y: ly + 4, 'text-anchor': anchor, class: 'rlabel' }, store.personName(id)),
    );
    g.addEventListener('click', () => focusEntity(id));
    svg.append(g);
  }
  const recent = ops.filter((o) => o.reason).slice(-6).reverse();
  return h(
    'div',
    { class: 'soc-op-wrap' },
    svg,
    h('div', { class: 'note' }, t('soc.opinionsNote')),
    recent.length ? h('div', { class: 'section-title' }, t('soc.opinionsRecent')) : null,
    ...recent.map((o) =>
      h(
        'div',
        { class: 'soc-op-line', style: `border-color:${scoreColor(o.score)}` },
        h('b', {}, `${store.personName(o.from)} → ${store.personName(o.to)}`),
        ` ${o.score > 0 ? '+' : ''}${o.score.toFixed(2)} · `,
        h('span', { class: 'muted' }, o.reason ?? ''),
      ),
    ),
  );
}
