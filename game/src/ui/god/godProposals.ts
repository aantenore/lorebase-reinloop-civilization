import { config } from '../../config';
import { t, type I18nKey } from '../../i18n';
import type { LawProposalStatus } from '../../net/protocol';
import { store, type LawProposal } from '../../state/store';
import { h, throttle } from '../dom';
import type { GodTab } from './godMode';
import { focusEntity, segmented } from './godShared';

type Filter = 'all' | LawProposalStatus;
const STATUS_ORDER: Record<LawProposalStatus, number> = { open: 0, merged: 1, rejected: 2 };

/** Review page of the Lorebase UI for one proposal, `<reviewPath>/<proposal id>` (approval happens there, not here). */
function reviewUrl(p: LawProposal): string {
  return `${config.lorebaseUi.base}${config.lorebaseUi.reviewPath}/${encodeURIComponent(p.id)}`;
}

/** Law changes proposed by the agents themselves (`law_proposal`), with their review status. */
export function mountGodProposals(): GodTab {
  let filter: Filter = 'all';
  let visible = false;
  const count = h('span', { class: 'muted' });
  const list = h('div', { class: 'scroll god-props' });
  const el = h(
    'div',
    { class: 'god-tab god-col' },
    h('div', { class: 'note' }, t('god.props.note')),
    h(
      'div',
      { class: 'god-row' },
      segmented<Filter>(
        (['all', 'open', 'merged', 'rejected'] as Filter[]).map((v) => ({ value: v, label: t(`god.props.f.${v}` as I18nKey) })),
        filter,
        (v) => ((filter = v), render()),
      ),
      count,
      h('a', { class: 'btn god-link', href: `${config.lorebaseUi.base}${config.lorebaseUi.reviewPath}`, target: '_blank', rel: 'noopener' }, t('god.props.openReview')),
    ),
    list,
  );

  const render = () => {
    const all = [...store.lawProposals.values()];
    const shown = all.filter((p) => filter === 'all' || p.status === filter).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
    count.textContent = t('god.props.count', { n: all.filter((p) => p.status === 'open').length });
    list.replaceChildren(
      ...(shown.length
        ? shown.map((p) =>
            h(
              'div',
              { class: `px god-prop st-${p.status}` },
              h(
                'div',
                { class: 'god-row' },
                h('span', { class: `prop-st st-${p.status}` }, t(`god.props.st.${p.status}` as I18nKey)),
                h('a', { class: 'insp-link', onclick: () => focusEntity(p.by) }, store.personName(p.by)),
                h('code', {}, `${p.key} = ${String(p.value)}`),
                h('span', { class: 'muted' }, p.category),
              ),
              h('div', { class: 'quote' }, p.text),
              h(
                'div',
                { class: 'god-row' },
                h('span', { class: 'muted' }, `⎇ ${p.branch}`),
                p.status === 'open' ? h('a', { class: 'btn god-link', href: reviewUrl(p), target: '_blank', rel: 'noopener' }, t('god.props.review')) : null,
              ),
            ),
          )
        : [h('div', { class: 'note' }, t('god.props.none'))]),
    );
  };
  const schedule = throttle(() => visible && render(), 300);
  store.on('law_proposal', schedule);
  store.on('hello', schedule);

  return {
    el,
    show: () => ((visible = true), render()),
    hide: () => (visible = false),
  };
}
