import { config } from '../../config';
import { t } from '../../i18n';
import type { LorebaseLogEntry, ObservatorySummary, ProposalInfo } from '../../net/protocol';
import { session } from '../../net/session';
import { store } from '../../state/store';
import { h } from '../dom';
import type { GodTab } from './godMode';
import { fmtBytes, focusEntity, kvTable, lorebaseLink } from './godShared';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Overview of the three systems: Lorebase (world truth), private memory, agent decision loop. */
export function mountGodObservatory(): GodTab {
  let timer: number | null = null;
  const cards = h('div', { class: 'god-cards' });
  const logBox = h('div');
  const propBox = h('div');
  const el = h(
    'div',
    { class: 'god-tab god-col' },
    h('div', { class: 'god-row' }, h('button', { class: 'btn', onclick: () => void refresh() }, t('god.refresh')), lorebaseLink()),
    h('div', { class: 'scroll' }, cards, h('div', { class: 'god-cards' }, h('div', { class: 'px god-card' }, h('div', { class: 'section-title' }, t('god.obs.log')), logBox), h('div', { class: 'px god-card' }, h('div', { class: 'section-title' }, t('god.obs.proposals')), propBox))),
  );

  const card = (title: string, ...body: (Node | null)[]) => h('div', { class: 'px god-card' }, h('div', { class: 'section-title' }, title), ...body);
  const unavailable = (e: unknown) => h('div', { class: 'note err' }, t('god.obs.unavailable', { err: errText(e) }));

  const renderSummary = (s: ObservatorySummary) => {
    const { perAgent, dbBytes, ...mnemoRest } = s.mnemo ?? {};
    const agents = [...(perAgent ?? [])].sort((a, b) => b.count - a.count);
    cards.replaceChildren(
      card(t('god.obs.lorebase'), kvTable(s.lorebase as Record<string, unknown>)),
      card(
        t('god.obs.mnemo'),
        kvTable({ ...mnemoRest, ...(dbBytes !== undefined ? { db: fmtBytes(dbBytes) } : {}) }),
        agents.length ? h('div', { class: 'section-title' }, t('god.obs.perAgent')) : null,
        agents.length
          ? h(
              'div',
              { class: 'god-table' },
              ...agents.map((a) =>
                h(
                  'div',
                  { class: 'god-tr', onclick: () => focusEntity(a.agentId) },
                  h('span', {}, a.name),
                  h('span', { title: t('god.obs.count') }, String(a.count)),
                  h('span', { class: 'fid', title: `${t('god.obs.avgFid')} ${Math.round(a.avgFidelity * 100)}%` }, h('i', { style: `width:${Math.max(0, Math.min(1, a.avgFidelity)) * 100}%` })),
                  h('span', { class: 'muted', title: t('god.obs.gists') }, `${a.gists} ${t('god.obs.gists')}`),
                ),
              ),
            )
          : null,
      ),
      card(t('god.obs.reinloop'), kvTable(s.reinloop as Record<string, unknown>)),
    );
  };

  const renderLog = (entries: LorebaseLogEntry[]) =>
    logBox.replaceChildren(
      ...(entries.length
        ? entries.map((e) =>
            h('div', { class: 'god-logrow' }, h('code', {}, e.revision.slice(0, 7)), h('span', {}, e.message), h('span', { class: 'muted' }, [e.kinds.join(', '), e.time ? new Date(e.time).toLocaleTimeString() : ''].filter(Boolean).join(' · '))),
          )
        : [h('div', { class: 'note' }, t('god.obs.noLog'))]),
    );

  const renderProposals = (list: ProposalInfo[]) =>
    propBox.replaceChildren(
      ...(list.length
        ? list.map((p) => h('div', { class: 'god-logrow' }, h('code', {}, p.id), h('span', {}, p.title), h('span', { class: 'muted' }, [`⎇ ${p.branch}`, p.author, p.status].filter(Boolean).join(' · '))))
        : [h('div', { class: 'note' }, t('god.obs.noProposals'))]),
    );

  const refresh = async () => {
    const tr = session.transport;
    if (!tr) return;
    const [sum, log, props] = await Promise.allSettled([
      tr.getJson<ObservatorySummary>('/observatory/summary'),
      tr.getJson<LorebaseLogEntry[]>(`/observatory/log?limit=${config.god.observatoryLogLimit}`),
      tr.getJson<ProposalInfo[]>('/observatory/proposals?status=open'),
    ]);
    if (sum.status === 'fulfilled') renderSummary(sum.value);
    else cards.replaceChildren(unavailable(sum.reason));
    if (log.status === 'fulfilled') renderLog(Array.isArray(log.value) ? log.value : []);
    else logBox.replaceChildren(unavailable(log.reason));
    if (props.status === 'fulfilled') renderProposals(Array.isArray(props.value) ? props.value : []);
    else propBox.replaceChildren(unavailable(props.reason));
  };

  // a law change is a new Lorebase revision: refresh right away when visible
  store.on('rules_changed', () => timer !== null && void refresh());

  return {
    el,
    show: () => {
      void refresh();
      if (timer === null) timer = window.setInterval(() => void refresh(), config.god.observatoryRefreshMs);
    },
    hide: () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    },
  };
}
