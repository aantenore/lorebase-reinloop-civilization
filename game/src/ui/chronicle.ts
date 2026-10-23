import { t } from '../i18n';
import { store } from '../state/store';
import { fmtClock, h, uiRoot } from './dom';
import { panels } from './panels';

/** Log of world events, newest first. */
export function mountChronicle(): void {
  const list = h('div', { class: 'scroll chron' });
  const el = h('div', { class: 'px panel chronicle hidden' }, h('button', { class: 'btn x-btn', onclick: () => panels.set('chronicle', false) }, 'X'), h('div', { class: 'px-title' }, t('hud.chronicle')), list);
  uiRoot().append(el);
  panels.register({ id: 'chronicle', key: 'j', defaultOpen: false, el, onOpen: () => render() });
  const render = () => {
    list.replaceChildren(
      ...[...store.chronicle].reverse().map((c) =>
        h('div', { class: `ev ev-${c.kind}` }, h('span', { class: 'when' }, `${t('hud.day', { n: c.day })} ${fmtClock(c.minute)}`), h('span', {}, c.text)),
      ),
    );
  };
  store.on('world_event', () => panels.isOpen('chronicle') && render());
}
