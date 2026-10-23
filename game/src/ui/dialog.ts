import { t } from '../i18n';
import { session } from '../net/session';
import { store } from '../state/store';
import { bus } from './bus';
import { h, uiRoot } from './dom';
import { tierBadge } from './inspector';

/** Bottom dialogue box for talking with one inhabitant; replies stream in. */
export function mountDialog(): void {
  const title = h('div', { class: 'who' });
  const log = h('div', { class: 'log' });
  const input = h('input', { class: 'field', placeholder: t('dialog.placeholder'), maxlength: 280 }) as HTMLInputElement;
  const send = h('button', { class: 'btn primary' }, t('dialog.send'));
  const el = h('div', { class: 'px dialog hidden' }, h('button', { class: 'btn x-btn', onclick: () => bus.emit('dialog', { id: null }) }, 'X'), title, log, h('div', { class: 'row' }, input, send), h('div', { class: 'note' }, t('dialog.close')));
  uiRoot().append(el);
  let target: string | null = null;
  let waiting = false;

  const render = () => {
    if (!target) return;
    const e = store.entities.get(target);
    title.replaceChildren(e ? tierBadge(e.effectiveTier ?? e.tier) : '', h('span', { class: 'px-title' }, t('dialog.with', { name: store.name(target) })));
    const you = store.youId;
    const lines = (store.logs.get(target) ?? []).filter((l) => l.kind === 'speech' && (l.from === you || l.to === you)).slice(-12);
    log.replaceChildren(
      ...lines.map((l) => h('div', { class: `line${l.from === you ? ' me' : ''}` }, h('b', {}, `${l.from === you ? t('dialog.you') : store.name(l.from)}:`), l.text)),
    );
    const streaming = store.streams.get(target);
    if (streaming !== undefined) log.append(h('div', { class: 'line' }, h('b', {}, `${store.name(target)}:`), h('span', { class: 'caret' }, streaming)));
    else if (waiting) log.append(h('div', { class: 'line' }, h('b', {}, `${store.name(target)}:`), h('span', { class: 'caret' }, t('dialog.waiting'))));
    if (!you) log.append(h('div', { class: 'note' }, t('dialog.spectator')));
    log.scrollTop = log.scrollHeight;
  };

  const submit = () => {
    const text = input.value.trim();
    if (!text || !target || !store.youId) return;
    session.send({ type: 'speak', to: target, text });
    // local echo of your own line; the server never sends it back
    store.apply({ type: 'say', from: store.youId, to: target, text, kind: 'speech' });
    input.value = '';
    waiting = true;
    render();
  };
  send.addEventListener('click', submit);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') submit();
    if (ev.key === 'Escape') bus.emit('dialog', { id: null });
    ev.stopPropagation();
  });

  bus.on('dialog', ({ id }) => {
    target = id;
    waiting = false;
    el.classList.toggle('hidden', !id);
    if (id) {
      render();
      setTimeout(() => input.focus(), 0);
    } else input.blur();
  });
  store.on('say_stream', (s) => {
    if (s.from !== target) return;
    if (s.done) waiting = false;
    render();
  });
  store.on('say', (l) => target && (l.from === target || l.to === target) && render());
  store.on('entity_removed', ({ id }) => id === target && bus.emit('dialog', { id: null }));
}
