import { roleLabel, t, type I18nKey } from '../i18n';
import type { Group, PlanStep } from '../net/protocol';
import { drawPortrait } from '../render/portrait';
import { store, type EntityState, type Plan } from '../state/store';
import { bus } from './bus';
import { fmtClock, h, throttle, uiRoot } from './dom';
import { bagText, inventoryChips, toolRows } from './inventory';
import { familyColor } from '../render/palette';
import { ageLabel, esteemBar, societyNav } from './society';
import { MemoryView } from './memoryView';
import { panels } from './panels';

export function tierBadge(tier: string): HTMLElement {
  return h('span', { class: `tier tier-${tier}` }, t(`tier.${tier}` as I18nKey));
}

export function patternLabel(g: Group): string {
  return t(`pattern.${g.pattern}` as I18nKey);
}

/** Ordered step list with done / active states; `who` adds the member name column (group plans). */
export function stepList(steps: PlanStep[], current: number, withWho: boolean): HTMLElement {
  const ol = h('ol', { class: 'steps' });
  steps.forEach((s, i) => {
    const who = withWho ? (s.args?.who as string | undefined) : undefined;
    ol.append(
      h(
        'li',
        { class: i < current ? 'done' : i === current ? 'active' : '' },
        h('span', {}, s.label || s.action),
        withWho ? h('span', { class: 'who' }, who ? store.name(who) : t('group.anyone')) : null,
      ),
    );
  });
  return ol;
}

export function progress(plan: Plan): HTMLElement {
  const n = plan.steps.length;
  const pct = n ? Math.min(100, (plan.current / n) * 100) : 0;
  return h('div', {}, h('div', { class: 'progress' }, h('i', { style: `width:${pct}%` })), h('div', { class: 'note' }, t('insp.step', { i: Math.min(plan.current + 1, n), n })));
}

function bar(label: string, value: number, max: number, color: string): HTMLElement[] {
  const pct = Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100));
  return [h('span', {}, label), h('div', { class: 'bar' }, h('i', { style: `width:${pct}%;background:${color}` })), h('span', { class: 'muted' }, `${Math.round(value)}/${max}`)];
}

/** Card for the selected inhabitant: vitals, group, live plan, thoughts and dialogue. */
export function mountInspector(): void {
  // `dyn` is rebuilt on every refresh; the consult and memory blocks persist so their animations survive
  const dyn = h('div', { class: 'insp-dyn' });
  const consults = h('div', { class: 'consults' });
  const memory = new MemoryView();
  const body = h('div', { class: 'scroll' }, dyn, consults, memory.el);
  const el = h('div', { class: 'px panel inspector hidden' }, h('button', { class: 'btn x-btn', onclick: () => store.select(null) }, 'X'), body);
  uiRoot().append(el);
  panels.register({
    id: 'inspector',
    key: 'i',
    defaultOpen: false,
    el,
    onOpen: () => (store.selectedId ? render() : panels.set('inspector', false, false)),
  });
  el.classList.add('hidden'); // follows the selection, never restored on its own
  const portrait = h('canvas', { class: 'portrait', width: 56, height: 60 });
  let portraitFor = '';
  let scrollKey = '';

  const render = () => {
    const id = store.selectedId;
    const e = id ? store.entities.get(id) : undefined;
    if (!e) return;
    if (portraitFor !== `${e.id}:${e.age?.stage}`) {
      drawPortrait(portrait, e);
      portraitFor = `${e.id}:${e.age?.stage}`;
    }
    const g = e.groupId ? store.groups.get(e.groupId) : undefined;
    const plan = store.plans.get(e.id);
    const groupPlan = g ? store.plans.get(g.id) : undefined;
    const logs = store.logs.get(e.id) ?? [];
    const thoughts = logs.filter((l) => l.kind === 'thought' && l.from === e.id).slice(-3).reverse();
    const talk = logs.filter((l) => l.kind === 'speech').slice(-5).reverse();
    const isYou = e.id === store.youId;

    const prevScroll = body.scrollTop;
    const parts: (Node | null)[] = [
      h(
        'div',
        { class: 'card-head' },
        portrait,
        h(
          'div',
          {},
          h('div', { class: 'name' }, isYou ? `${e.name} (${t('insp.you')})` : e.name),
          h('div', { class: 'sub' }, tierBadge(e.effectiveTier ?? e.tier), roleLabel(e.role), ' · ', t(`kind.${e.kind}` as I18nKey)),
          h('div', { class: 'sub muted' }, `${t('insp.model')}: ${e.model || t('insp.none')}`),
          h('div', { class: 'sub' }, e.alive ? t(`anim.${e.anim}` as I18nKey) : t('insp.dead'), ' ', e.thinking ? h('span', { class: 'thinking-tag' }, t('insp.thinking')) : null),
        ),
      ),
      h(
        'div',
        { class: 'bars' },
        ...bar(t('hud.hp'), e.hp, e.maxHp, 'var(--red)'),
        ...bar(t('hud.hunger'), e.hunger, 100, e.hunger > 70 ? 'var(--red)' : 'var(--bronze)'),
      ),
      h('div', { class: 'sub inv-line' }, `${t('insp.inventory')}: `, ...inventoryChips(e)),
      toolRows(e.tools),
      societySection(e),
      g
        ? h(
            'div',
            { class: 'group-row', onclick: () => (panels.set('groups', true), bus.emit('group', { id: g.id })) },
            h('span', { class: 'swatch', style: `background:${g.color}` }),
            h('span', {}, g.name),
            h('span', { class: 'pattern' }, patternLabel(g)),
            g.leader === e.id ? h('span', { class: 'muted' }, t('insp.leader')) : null,
          )
        : h('div', { class: 'sub muted' }, `${t('insp.group')}: ${t('insp.noGroup')}`),
      planSection(e, plan, groupPlan),
      thoughts.length ? h('div', { class: 'section-title' }, t('insp.thoughts')) : null,
      ...thoughts.map((l) => h('div', { class: 'quote thought' }, l.text)),
      talk.length ? h('div', { class: 'section-title' }, t('insp.dialogue')) : null,
      ...talk.map((l) => h('div', { class: 'quote' }, h('b', {}, `${store.name(l.from)}${l.to !== 'all' ? ` → ${store.name(l.to)}` : ''}:`), ' ', l.text)),
      store.youId && !isYou && e.kind !== 'player' && e.alive
        ? h('button', { class: 'btn primary', onclick: () => bus.emit('dialog', { id: e.id }) }, t('insp.speak'))
        : null,
    ];
    dyn.replaceChildren(...parts.filter((p): p is Node => !!p));
    // keep the active step in view when the plan advances, otherwise preserve the user's scroll
    body.scrollTop = prevScroll;
    const key = `${e.id}:${plan?.createdAt}:${plan?.current}`;
    const active = body.querySelector('.steps li.active') as HTMLElement | null;
    if (key !== scrollKey && active) {
      scrollKey = key;
      const a = active.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      if (a.bottom > b.bottom - 40 || a.top < b.top) body.scrollTop += a.top - b.top - b.height / 3;
    }
  };

  let freshConsult = 0;
  const renderConsults = () => {
    const id = store.selectedId;
    const e = id ? store.entities.get(id) : undefined;
    consults.classList.toggle('hidden', !e || e.kind !== 'agent');
    if (!e || e.kind !== 'agent') return;
    const list = [...(store.consults.get(e.id) ?? [])].reverse();
    consults.replaceChildren(
      h('div', { class: 'section-title' }, t('insp.consulted')),
      h('div', { class: 'note' }, list.length ? t('insp.consultedNote') : t('insp.noConsults')),
      ...list.slice(0, 6).map((c, i) =>
        h(
          'div',
          { class: `consult${i === 0 && freshConsult > Date.now() - 1500 ? ' fresh' : ''}` },
          h('span', { class: 'c-tool' }, c.tool.replace(/^lorebase_/, '')),
          h('span', { class: 'c-q' }, c.query),
          h('span', { class: 'muted c-when' }, fmtClock(c.minute)),
        ),
      ),
    );
  };

  const schedule = throttle(() => panels.isOpen('inspector') && render(), 300);
  store.on('select', ({ id }) => {
    panels.set('inspector', !!id, false);
    memory.setAgent(id);
    renderConsults();
    if (id) render();
  });
  store.on('consult', ({ agentId }) => {
    if (agentId !== store.selectedId) return;
    freshConsult = Date.now();
    renderConsults();
  });
  store.on('any', schedule);
}

/** Age, esteem/fame/rank, family and parents, skills, barter offers in progress. */
function societySection(e: EntityState): HTMLElement | null {
  const p = store.person(e.id);
  const skills = [...(store.skills.get(e.id) ?? [])].sort((a, b) => b[1] - a[1]);
  const offers = [...store.offers.values()].filter((o) => o.from === e.id || o.to === e.id).sort((a, b) => b.at - a.at).slice(0, 4);
  if (!p && !skills.length && !offers.length) return null;
  const fam = p?.family ? store.families.get(p.family) : undefined;
  const personLink = (id: string) => {
    const alive = store.entities.get(id)?.alive;
    return h('a', { class: `insp-link${alive ? '' : ' dead'}`, onclick: () => (store.entities.has(id) ? store.select(id) : undefined) }, store.personName(id));
  };
  return h(
    'div',
    { class: 'insp-soc' },
    h('div', { class: 'section-title' }, t('insp.society')),
    p
      ? h(
          'div',
          { class: 'insp-soc-grid' },
          h('span', { class: 'muted' }, t('insp.age')),
          h('span', {}, `${ageLabel(p.age?.stage)} · ${t('insp.days', { n: Math.round(p.age?.days ?? 0) })}`),
          h('span', { class: 'muted' }, t('soc.esteem')),
          h('span', {}, esteemBar(p.esteem), ` ${Math.round(p.esteem * 100)}%`, p.rank > 0 ? h('b', { class: 'insp-rank' }, ` #${p.rank}`) : null),
          h('span', { class: 'muted' }, t('soc.col.fame')),
          h('span', {}, String(Math.round(p.fame))),
          h('span', { class: 'muted' }, t('soc.col.family')),
          h(
            'span',
            {},
            p.family
              ? h('a', { class: 'insp-link', onclick: () => societyNav.openFamily(p.family!) }, h('i', { class: 'fam-sw', style: `background:${familyColor(p.family, fam?.color)}` }), fam?.name ?? p.family)
              : t('soc.noFamily'),
          ),
          p.parents ? h('span', { class: 'muted' }, t('insp.parents')) : null,
          p.parents ? h('span', {}, personLink(p.parents[0]), ' · ', personLink(p.parents[1])) : null,
        )
      : null,
    skills.length ? h('div', { class: 'insp-skills' }, h('span', { class: 'muted' }, `${t('insp.skills')}: `), ...skills.map(([r, lvl]) => h('span', { class: 'skill-chip' }, `${store.economy.recipes.get(r)?.name ?? store.itemName(r)} `, h('b', {}, `${t('insp.level')} ${lvl}`)))) : null,
    offers.length ? h('div', { class: 'muted' }, t('insp.offers')) : null,
    ...offers.map((o) =>
      h(
        'div',
        { class: `insp-offer st-${o.status}` },
        `${o.kind === 'ask' ? '🙏' : '🤝'} ${store.personName(o.from)} → ${store.personName(o.to)}: `,
        o.kind === 'ask' ? t('offer.ask', { want: bagText(o.want) }) : t('offer.bubble', { give: bagText(o.give), want: bagText(o.want) }),
        h('span', { class: 'offer-st' }, t(`offer.st.${o.status}` as I18nKey)),
      ),
    ),
  );
}

function planSection(e: EntityState, plan: Plan | undefined, groupPlan: Plan | undefined): HTMLElement {
  if (plan && plan.steps.length) {
    return h(
      'div',
      {},
      h('div', { class: 'section-title' }, t('insp.plan')),
      progress(plan),
      stepList(plan.steps, plan.current, false),
      plan.reason ? h('div', { class: 'quote' }, h('b', {}, `${t('insp.reason')}:`), ' ', plan.reason) : null,
    );
  }
  const mine = groupPlan?.steps.filter((s) => s.args?.who === e.id) ?? [];
  if (groupPlan && mine.length) {
    return h('div', {}, h('div', { class: 'section-title' }, t('insp.plan')), h('div', { class: 'note' }, t('insp.groupPlan')), stepList(mine, -1, false));
  }
  return h('div', { class: 'note' }, t('insp.noPlan'));
}
