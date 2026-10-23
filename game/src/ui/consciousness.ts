import { roleLabel, t } from '../i18n';
import type { Consciousness, Insight, InsightList } from '../net/protocol';
import { session } from '../net/session';
import { roleColors } from '../render/palette';
import { store } from '../state/store';
import { h, throttle, uiRoot } from './dom';
import { panels } from './panels';
import { getPref, setPref } from './prefs';

/**
 * Shared consciousness of each social role (Lorebase): accepted insights, proposals waiting for a
 * peer's review, and the archive. Live `insight` events reveal themselves with an animation.
 */
export function mountConsciousness(): void {
  const tabs = h('div', { class: 'tabs' });
  const body = h('div', { class: 'scroll consc-body' });
  const note = h('div', { class: 'note' });
  const el = h(
    'div',
    { class: 'px panel consc hidden' },
    h('button', { class: 'btn x-btn', onclick: () => panels.set('consciousness', false) }, 'X'),
    h('div', { class: 'px-title' }, t('consc.title')),
    h('div', { class: 'note' }, t('consc.subtitle')),
    tabs,
    note,
    body,
  );
  uiRoot().append(el);

  let role: string = getPref('consc.role', '');
  let loaded = false;
  /** Codes revealed since the last render: animated once. */
  const fresh = new Map<string, string>();
  const unseen = new Set<string>();

  const load = async () => {
    const tr = session.transport;
    if (!tr) return;
    note.textContent = loaded ? '' : t('consc.loading');
    try {
      const [acc, list] = await Promise.all([
        tr.getJson<Consciousness>('/consciousness'),
        tr.getJson<InsightList>('/insights').catch(() => ({ pending: [], stored: [] }) as InsightList),
      ]);
      for (const arr of Object.values(acc ?? {})) store.mergeInsights(arr.map((i) => ({ ...i, status: i.status ?? 'accepted' })));
      store.mergeInsights([...(list.stored ?? []), ...(list.pending ?? []).map((i) => ({ ...i, status: 'proposed' as const }))]);
      for (const r of Object.keys(acc ?? {})) knownRoles.add(r);
      note.textContent = '';
    } catch {
      note.textContent = t('consc.unavailable');
    }
    loaded = true;
    render();
  };

  const knownRoles = new Set<string>();
  const roles = (): string[] => {
    const set = new Set<string>([...knownRoles, ...store.roles]);
    for (const i of store.insights.values()) set.add(i.role);
    for (const e of store.entities.values()) if (e.kind === 'agent') set.add(e.role);
    return [...set].filter(Boolean);
  };

  const card = (i: Insight) => {
    const conf = Math.max(0, Math.min(1, i.confidence));
    const cls = `insight st-${i.status}${fresh.has(i.code) ? ` reveal reveal-${fresh.get(i.code)}` : ''}`;
    const meta: (Node | string)[] = [h('span', {}, t('consc.by', { author: i.author || '?' }))];
    if (i.status === 'accepted') meta.push(h('span', { class: 'ok' }, i.reviewer ? t('consc.reviewedBy', { reviewer: i.reviewer }) : t('consc.autoAccepted')));
    if (i.status === 'proposed') meta.push(h('span', { class: 'review' }, t('consc.pending'), h('span', { class: 'dots' })));
    if (i.status === 'rejected') meta.push(h('span', { class: 'bad' }, t('consc.rejected'), i.reviewer ? ` · ${i.reviewer}` : ''));
    if (i.status === 'retired') meta.push(h('span', { class: 'muted' }, t('consc.retired')));
    meta.push(h('span', { class: 'muted' }, t('consc.day', { n: i.day })));
    return h(
      'div',
      { class: cls },
      h('div', { class: 'txt' }, i.text),
      h('div', { class: 'conf', title: `${t('consc.confidence')} ${Math.round(conf * 100)}%` }, h('span', { class: 'lbl' }, t('consc.confidence')), h('div', { class: 'bar' }, h('i', { style: `width:${conf * 100}%` })), h('span', { class: 'muted' }, `${Math.round(conf * 100)}%`)),
      i.evidence ? h('div', { class: 'evidence' }, h('b', {}, `${t('consc.evidence')}: `), i.evidence) : null,
      h('div', { class: 'meta' }, ...meta),
    );
  };

  const render = () => {
    const list = roles();
    if (!list.includes(role)) role = list[0] ?? '';
    tabs.replaceChildren(
      ...list.map((r) => {
        const all = [...store.insights.values()].filter((i) => i.role === r);
        const acc = all.filter((i) => i.status === 'accepted').length;
        const pend = all.filter((i) => i.status === 'proposed').length;
        const color = roleColors(r).shirt[0];
        return h(
          'button',
          { class: `btn tab${r === role ? ' on' : ''}${unseen.has(r) ? ' ping' : ''}`, style: `--role:${color}`, onclick: () => ((role = r), setPref('consc.role', r), unseen.delete(r), render()) },
          h('span', { class: 'role-dot' }),
          roleLabel(r),
          h('span', { class: 'count' }, String(acc)),
          pend ? h('span', { class: 'count pend' }, `+${pend}`) : null,
        );
      }),
    );
    unseen.delete(role);
    const mine = [...store.insights.values()].filter((i) => i.role === role);
    const byDay = (a: Insight, b: Insight) => b.day - a.day || b.confidence - a.confidence;
    const accepted = mine.filter((i) => i.status === 'accepted').sort(byDay);
    const pending = mine.filter((i) => i.status === 'proposed').sort(byDay);
    const archive = mine.filter((i) => i.status === 'rejected' || i.status === 'retired').sort(byDay);
    const prev = body.scrollTop;
    const parts: (Node | null)[] = [
      h('div', { class: 'consc-head', style: `--role:${roleColors(role || 'x').shirt[0]}` }, h('span', { class: 'mind-glyph' }), h('span', {}, t('consc.mind'), ' · ', h('b', {}, roleLabel(role)))),
      pending.length ? h('div', { class: 'section-title' }, t('consc.pendingTitle')) : null,
      ...pending.map(card),
      h('div', { class: 'section-title' }, t('consc.accepted')),
      ...(accepted.length ? accepted.map(card) : [h('div', { class: 'note' }, t('consc.empty'))]),
      archive.length ? h('details', { class: 'archive' }, h('summary', { class: 'section-title' }, `${t('consc.archive')} (${archive.length})`), ...archive.map(card)) : null,
    ];
    body.replaceChildren(...parts.filter((p): p is Node => !!p));
    body.scrollTop = prev;
    fresh.clear();
  };

  panels.register({ id: 'consciousness', key: 'c', defaultOpen: false, el, slot: 'center', onOpen: () => (render(), void load()) });

  const schedule = throttle(() => panels.isOpen('consciousness') && render(), 250);
  store.on('insight', ({ insight, action }) => {
    fresh.set(insight.code, action);
    if (insight.role !== role) unseen.add(insight.role);
    if (action === 'accepted') document.querySelector('[data-panel="consciousness"]')?.classList.add('ping');
    schedule();
  });
  panels.onChange((id, open) => id === 'consciousness' && open && document.querySelector('[data-panel="consciousness"]')?.classList.remove('ping'));
  store.on('hello', schedule);
}
