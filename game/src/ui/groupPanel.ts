import { t, type I18nKey } from '../i18n';
import type { Group, GroupDecision } from '../net/protocol';
import { store } from '../state/store';
import { bus } from './bus';
import { h, throttle, uiRoot } from './dom';
import { patternLabel, progress, stepList, tierBadge } from './inspector';
import { panels } from './panels';

/** Groups list plus the focused group's members, decision trace and joint plan. */
export function mountGroupPanel(): void {
  const body = h('div', { class: 'scroll' });
  const el = h('div', { class: 'px panel groups hidden' }, h('button', { class: 'btn x-btn', onclick: () => panels.set('groups', false) }, 'X'), h('div', { class: 'px-title' }, t('hud.groups')), body);
  uiRoot().append(el);
  let focus: string | null = null;
  panels.register({ id: 'groups', key: 'k', defaultOpen: false, el, onOpen: () => render() });
  panels.onChange((id, open) => {
    if (id === 'groups' && !open && focus) bus.emit('group', { id: null });
  });

  const render = () => {
    const groups = [...store.groups.values()];
    const g = focus ? store.groups.get(focus) : undefined;
    const prev = body.scrollTop;
    body.replaceChildren(
      ...groups.map((gr) =>
        h(
          'div',
          { class: `group-row${gr.id === focus ? ' sel' : ''}`, onclick: () => bus.emit('group', { id: gr.id === focus ? null : gr.id }) },
          h('span', { class: 'swatch', style: `background:${gr.color}` }),
          h('span', {}, gr.name),
          h('span', { class: 'pattern', title: t(`patternDesc.${gr.pattern}` as I18nKey) }, patternLabel(gr)),
          h('span', { class: 'muted', style: 'margin-left:auto' }, String(gr.members.length)),
        ),
      ),
      ...(g ? [details(g)] : []),
    );
    body.scrollTop = prev;
  };

  bus.on('group', ({ id }) => {
    focus = id;
    if (id) panels.set('groups', true);
    render();
  });
  const schedule = throttle(() => panels.isOpen('groups') && render(), 400);
  store.on('group', schedule);
  store.on('group_removed', ({ id }) => {
    if (id === focus) bus.emit('group', { id: null });
    schedule();
  });
  store.on('plan', (p) => p.scope === 'group' && schedule());
  store.on('plan_progress', (p) => p.scope === 'group' && schedule());
  store.on('hello', schedule);
}

function details(g: Group): HTMLElement {
  const plan = store.plans.get(g.id);
  return h(
    'div',
    {},
    h('div', { class: 'note', style: 'margin:6px 0' }, t(`patternDesc.${g.pattern}` as I18nKey)),
    h('div', { class: 'section-title' }, t('group.members')),
    ...g.members.map((id) => {
      const e = store.entities.get(id);
      return h(
        'div',
        { class: 'group-row', onclick: () => store.select(id) },
        e ? tierBadge(e.effectiveTier ?? e.tier) : null,
        h('span', {}, store.name(id)),
        g.leader === id ? h('span', { class: 'pattern' }, t('insp.leader')) : null,
        e?.thinking ? h('span', { class: 'thinking-tag' }, t('insp.thinking')) : null,
      );
    }),
    g.lastDecision ? decision(g, g.lastDecision) : null,
    h('div', { class: 'section-title' }, t('group.plan')),
    plan && plan.steps.length
      ? h('div', {}, progress(plan), stepList(plan.steps, plan.current, true), plan.reason ? h('div', { class: 'quote' }, plan.reason) : null)
      : h('div', { class: 'note' }, t('group.noPlan')),
  );
}

function decision(g: Group, d: GroupDecision): HTMLElement {
  const votes = d.trace.filter((x) => x.role === 'voter');
  const tally = new Map<string, number>();
  for (const v of votes) tally.set(v.text, (tally.get(v.text) ?? 0) + 1);
  return h(
    'div',
    {},
    h('div', { class: 'section-title' }, t('group.decision')),
    h('div', { class: 'quote' }, d.summary),
    g.pattern === 'assembly' && tally.size
      ? h('div', { class: 'tally' }, h('span', { class: 'muted' }, `${t('group.votes')}:`), ...[...tally].sort((a, b) => b[1] - a[1]).map(([text, n]) => h('span', {}, `${n} · ${text}`)))
      : null,
    h(
      'div',
      { class: 'trace' },
      ...d.trace.map((x) =>
        h('div', { class: 'row' }, h('span', { class: `role ${x.role}` }, t(`decisionRole.${x.role}` as I18nKey)), h('span', {}, h('b', { style: 'color:var(--gold);font-weight:normal' }, `${store.name(x.member)}: `), x.text)),
      ),
    ),
  );
}
