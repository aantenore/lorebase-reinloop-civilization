import { t, type I18nKey } from '../../i18n';
import { h, uiRoot } from '../dom';
import { getPref, setPref } from '../prefs';
import { panels } from '../panels';
import { mountGodConversations } from './godConversations';
import { mountGodLaws } from './godLaws';
import { mountGodMinds } from './godMinds';
import { mountGodObservatory } from './godObservatory';
import { mountGodProposals } from './godProposals';

/** One god-mode tab: its body plus visibility hooks (fetch on show, stop timers on hide). */
export interface GodTab {
  el: HTMLElement;
  show(): void;
  hide(): void;
}

const TABS: { id: string; label: I18nKey; mount: () => GodTab }[] = [
  { id: 'laws', label: 'god.tab.laws', mount: mountGodLaws },
  { id: 'minds', label: 'god.tab.minds', mount: mountGodMinds },
  { id: 'convos', label: 'god.tab.convos', mount: mountGodConversations },
  { id: 'props', label: 'god.tab.props', mount: mountGodProposals },
  { id: 'obs', label: 'god.tab.obs', mount: mountGodObservatory },
];

/** Shared tab switcher, so other tabs can jump (e.g. a conversation line opens a mind). */
export const godNav = { open: (_id: string) => {} };

/**
 * God mode: an omniscient observer/admin drawer over a dimmed (still interactive) world.
 * Registered as panel `god` (key G); controls freeze the player body while it is open.
 */
export function mountGodMode(): void {
  const dim = h('div', { class: 'god-dim hidden' });
  const tabBar = h('div', { class: 'god-tabs' });
  const body = h('div', { class: 'god-body' });
  const collapseBtn = h('button', { class: 'btn god-collapse' });
  const el = h(
    'div',
    { class: 'px panel god hidden' },
    h('div', { class: 'god-head' }, h('div', { class: 'px-title' }, t('god.title')), collapseBtn, h('button', { class: 'btn', title: t('god.close'), onclick: () => panels.set('god', false) }, 'X')),
    h('div', { class: 'note god-sub' }, t('god.subtitle')),
    tabBar,
    body,
  );
  uiRoot().append(dim, el);

  const tabs = new Map<string, GodTab>();
  let active = getPref('god.tab', 'laws');
  if (!TABS.some((x) => x.id === active)) active = 'laws';
  let collapsed = getPref('god.collapsed', false);

  const tabOf = (id: string): GodTab => {
    let tab = tabs.get(id);
    if (!tab) {
      tab = TABS.find((x) => x.id === id)!.mount();
      tabs.set(id, tab);
      body.append(tab.el);
    }
    return tab;
  };

  const select = (id: string) => {
    if (tabs.get(active) && active !== id) tabs.get(active)!.hide();
    active = id;
    setPref('god.tab', id);
    for (const b of tabBar.children) b.classList.toggle('on', (b as HTMLElement).dataset.tab === id);
    for (const [tid, tab] of tabs) tab.el.classList.toggle('hidden', tid !== id);
    const tab = tabOf(id);
    tab.el.classList.remove('hidden');
    if (panels.isOpen('god') && !collapsed) tab.show();
  };
  godNav.open = (id: string) => {
    if (collapsed) setCollapsed(false);
    select(id);
  };

  const setCollapsed = (c: boolean) => {
    collapsed = c;
    setPref('god.collapsed', c);
    el.classList.toggle('collapsed', c);
    collapseBtn.textContent = c ? t('god.expand') : t('god.collapse');
    if (c) tabs.get(active)?.hide();
    else if (panels.isOpen('god')) tabOf(active).show();
  };
  collapseBtn.onclick = () => setCollapsed(!collapsed);

  for (const tb of TABS) tabBar.append(h('button', { class: 'btn', 'data-tab': tb.id, onclick: () => godNav.open(tb.id) }, t(tb.label)));

  panels.register({ id: 'god', key: 'g', defaultOpen: false, el, onOpen: () => select(active) });
  panels.onChange((id, open) => {
    if (id !== 'god') return;
    dim.classList.toggle('hidden', !open);
    document.documentElement.classList.toggle('god-on', open);
    if (!open) tabs.get(active)?.hide();
  });
  setCollapsed(collapsed);
  // restored open state: onOpen is not called by register
  if (panels.isOpen('god')) {
    dim.classList.remove('hidden');
    document.documentElement.classList.add('god-on');
    select(active);
  }
}
