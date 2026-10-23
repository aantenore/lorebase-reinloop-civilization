import { config } from '../../config';
import { t, type I18nKey } from '../../i18n';
import type { ConversationKind, ConversationLine, GameTime } from '../../net/protocol';
import { session } from '../../net/session';
import { store } from '../../state/store';
import { h } from '../dom';
import type { GodTab } from './godMode';
import { fmtAt, focusEntity, isolateKeys } from './godShared';

interface Line extends ConversationLine {
  /** Deliberation role (proposer, critic...), live events only. */
  role?: string;
}

const KINDS: ConversationKind[] = ['speech', 'thought', 'deliberation'];
const now = (): GameTime => ({ day: store.time.day, minute: store.time.minute });

/** Global conversation log: every voice in the world, filterable, with a pausable live tail. */
export function mountGodConversations(): GodTab {
  const filter = { agent: '', with: '', group: '', kind: '' };
  let lines: Line[] = [];
  let paused = false;
  let buffered: Line[] = [];
  let visible = false;
  let liveSeq = 0;
  let loadSeq = 0;
  let state: 'loading' | 'ok' | 'fail' = 'ok';

  const sel = (key: keyof typeof filter, label: I18nKey) => {
    const s = h('select', { class: 'field' }) as HTMLSelectElement;
    s.onchange = () => {
      filter[key] = s.value;
      void load();
    };
    return { s, wrap: h('label', { class: 'god-field' }, h('span', { class: 'law key' }, t(label)), s) };
  };
  const fAgent = sel('agent', 'god.f.agent');
  const fWith = sel('with', 'god.f.with');
  const fGroup = sel('group', 'god.f.group');
  const fKind = sel('kind', 'god.f.kind');
  const pauseBtn = h('button', { class: 'btn' });
  const live = h('span', { class: 'god-live' }, '● ', t('god.live'));
  const note = h('div', { class: 'note' });
  const log = h('div', { class: 'scroll god-log' });
  const el = h(
    'div',
    { class: 'god-tab god-col' },
    h('div', { class: 'god-filters' }, fAgent.wrap, fWith.wrap, fGroup.wrap, fKind.wrap),
    h('div', { class: 'god-row' }, live, pauseBtn, note),
    log,
  );
  isolateKeys(el);

  const fillOptions = () => {
    const people = [...store.entities.values()].filter((e) => e.kind !== 'crowd').sort((a, b) => a.name.localeCompare(b.name));
    const opts = (s: HTMLSelectElement, items: { v: string; l: string }[], cur: string) => {
      s.replaceChildren(h('option', { value: '' }, t('god.f.any')), ...items.map((i) => h('option', { value: i.v, selected: i.v === cur }, i.l)));
    };
    opts(fAgent.s, people.map((e) => ({ v: e.id, l: e.name })), filter.agent);
    opts(fWith.s, people.map((e) => ({ v: e.id, l: e.name })), filter.with);
    opts(fGroup.s, [...store.groups.values()].map((g) => ({ v: g.id, l: g.name })), filter.group);
    opts(fKind.s, KINDS.map((k) => ({ v: k, l: t(`god.kind.${k}` as I18nKey) })), filter.kind);
  };

  const matches = (l: Line): boolean => {
    if (filter.kind && l.kind !== filter.kind) return false;
    if (filter.agent && filter.with) {
      if (!((l.from === filter.agent && l.to === filter.with) || (l.from === filter.with && l.to === filter.agent))) return false;
    } else if (filter.agent && l.from !== filter.agent && l.to !== filter.agent) return false;
    else if (filter.with && l.from !== filter.with && l.to !== filter.with) return false;
    if (filter.group) {
      const g = store.groups.get(filter.group);
      if (l.groupId !== filter.group && !(g && g.members.includes(l.from))) return false;
    }
    return true;
  };

  const row = (l: Line) => {
    const to = l.kind === 'deliberation' ? store.name(l.groupId ?? l.to) : l.to === 'all' ? t('god.toAll') : store.name(l.to);
    return h(
      'div',
      { class: `god-line k-${l.kind}`, title: t('god.focus'), onclick: () => focusEntity(l.from) },
      h('span', { class: 'muted' }, fmtAt(l.at)),
      h('span', { class: 'god-kind' }, t(`god.kind.${l.kind}` as I18nKey)),
      h('span', {}, h('b', {}, store.name(l.from)), l.role ? h('span', { class: 'muted' }, ` [${l.role}]`) : null, ' → ', to, ': ', l.text),
    );
  };

  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 30;
  const renderAll = () => {
    log.replaceChildren(...lines.map(row));
    note.textContent = state === 'loading' ? t('god.loading') : state === 'fail' ? t('god.convUnavailable') : lines.length ? '' : t('god.noLines');
    log.scrollTop = log.scrollHeight;
  };
  const renderPause = () => {
    pauseBtn.textContent = paused ? t('god.resume', { n: buffered.length }) : t('god.pause');
    pauseBtn.classList.toggle('on', paused);
    live.classList.toggle('off', paused);
  };
  pauseBtn.onclick = () => {
    paused = !paused;
    if (!paused) {
      for (const l of buffered.splice(0)) push(l);
    }
    renderPause();
  };

  const trim = () => {
    const max = config.god.conversationLimit * 2;
    if (lines.length > max) {
      lines.splice(0, lines.length - max);
      if (visible) while (log.children.length > max) log.firstElementChild?.remove();
    }
  };
  function push(l: Line) {
    if (!matches(l)) return;
    if (paused) {
      buffered.push(l);
      return renderPause();
    }
    lines.push(l);
    trim();
    if (!visible) return;
    const stick = atBottom();
    log.append(row(l));
    note.textContent = '';
    if (stick) log.scrollTop = log.scrollHeight;
  }

  const load = async () => {
    const seq = ++loadSeq;
    buffered = [];
    state = 'loading';
    renderPause();
    renderAll();
    const q = new URLSearchParams({ limit: String(config.god.conversationLimit) });
    if (filter.agent) q.set('agent', filter.agent);
    if (filter.with) q.set('with', filter.with);
    if (filter.group) q.set('group', filter.group);
    try {
      const res = await session.transport!.getJson<ConversationLine[] | { lines: ConversationLine[] }>(`/conversations?${q}`);
      if (seq !== loadSeq) return;
      lines = (Array.isArray(res) ? res : (res.lines ?? [])).filter(matches);
      state = 'ok';
    } catch {
      if (seq !== loadSeq) return;
      lines = [];
      state = 'fail';
    }
    renderAll();
  };

  store.on('say', (l) => push({ id: `live-${++liveSeq}`, at: now(), from: l.from, to: l.to, text: l.text, kind: l.kind }));
  store.on('deliberation', (d) =>
    push({ id: `live-${++liveSeq}`, at: now(), from: d.member, to: d.groupId, text: d.text, kind: 'deliberation', groupId: d.groupId, role: t(`decisionRole.${d.role}` as I18nKey) }),
  );
  store.on('hello', () => visible && fillOptions());
  renderPause();

  return {
    el,
    show: () => {
      visible = true;
      fillOptions();
      void load();
    },
    hide: () => {
      visible = false;
    },
  };
}
