import { config } from '../config';
import { roleLabel, t } from '../i18n';
import { session } from '../net/session';
import { store } from '../state/store';
import { h, uiRoot } from './dom';
import { getPref, setPref } from './prefs';

/** Join card over the live world: name + role, or just watch. */
export function mountJoin(): { show: () => void } {
  const name = h('input', { class: 'field', maxlength: 24, placeholder: t('join.namePlaceholder'), value: config.presetName || getPref('name', '') }) as HTMLInputElement;
  const roles = h('div', { class: 'roles' });
  const status = h('div', { class: 'note' }, t('join.connecting'));
  let role = getPref('role', '');
  const enter = h('button', { class: 'btn primary' }, t('join.enter'));
  const watch = h('button', { class: 'btn' }, t('join.watch'));
  const card = h(
    'div',
    { class: 'px join' },
    h('h1', {}, t('join.title')),
    h('p', {}, t('join.subtitle')),
    h('div', {}, h('label', {}, t('join.name')), name),
    h('div', {}, h('label', {}, t('join.role')), roles),
    h('div', { class: 'actions' }, watch, enter),
    status,
    h('div', { class: 'note muted' }, t('join.keys')),
  );
  const wrap = h('div', { class: 'join-wrap' }, card);
  uiRoot().append(wrap);

  const renderRoles = () => {
    if (!store.roles.includes(role)) role = store.roles[0] ?? '';
    roles.replaceChildren(
      ...store.roles.map((r) => h('button', { class: `btn${r === role ? ' on' : ''}`, onclick: () => ((role = r), renderRoles()) }, roleLabel(r))),
    );
  };
  const hide = () => wrap.classList.add('hidden');
  const doJoin = () => {
    const n = name.value.trim() || t('join.namePlaceholder').replace(/^\S+\s/, '');
    setPref('name', n);
    setPref('role', role);
    session.send({ type: 'join', name: n, role });
    hide();
  };
  enter.addEventListener('click', doJoin);
  watch.addEventListener('click', hide);
  name.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') doJoin();
  });

  store.on('status', (s) => {
    status.textContent = s === 'mock' ? t('join.mock') : s === 'online' ? t('join.live') : t(`status.${s}`);
  });
  store.on('hello', () => {
    renderRoles();
    if (store.youId) hide();
    else if (config.autoJoin && !wrap.classList.contains('hidden')) doJoin();
  });
  renderRoles();
  setTimeout(() => name.focus(), 50);
  return { show: () => (wrap.classList.remove('hidden'), name.focus()) };
}
