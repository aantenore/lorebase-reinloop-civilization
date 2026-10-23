import { t } from '../i18n';
import type { Rule, RuleValue } from '../net/protocol';
import { session } from '../net/session';
import { store } from '../state/store';
import { h, uiRoot } from './dom';
import { panels } from './panels';

/**
 * Book of Laws. Edits go to the server (direct or as a proposal); values on screen only
 * change when `rules_changed` arrives.
 */
export function mountLaws(): void {
  const list = h('div', { class: 'scroll' });
  const el = h(
    'div',
    { class: 'px panel laws hidden' },
    h('button', { class: 'btn x-btn', onclick: () => panels.set('laws', false) }, 'X'),
    h('div', { class: 'px-title' }, t('laws.title')),
    h('div', { class: 'note' }, t('laws.subtitle')),
    list,
  );
  uiRoot().append(el);
  panels.register({ id: 'laws', key: 'l', defaultOpen: false, el, onOpen: () => render(), slot: 'center' });

  let editing: string | null = null;
  let mode: 'direct' | 'proposal' = 'direct';
  const notes = new Map<string, { text: string; err?: boolean }>();
  const flashed = new Set<string>();

  const editor = (r: Rule) => {
    const isBool = typeof r.value === 'boolean';
    const isNum = typeof r.value === 'number';
    const val = isBool
      ? (h('select', { class: 'field' }, h('option', { value: 'true', selected: r.value === true }, 'true'), h('option', { value: 'false', selected: r.value === false }, 'false')) as HTMLSelectElement)
      : (h('input', { class: 'field', type: isNum ? 'number' : 'text', step: 'any', value: String(r.value) }) as HTMLInputElement);
    const msg = h('input', { class: 'field', placeholder: t('laws.messagePlaceholder') }) as HTMLInputElement;
    const seg = h(
      'div',
      { class: 'seg' },
      h('button', { class: `btn${mode === 'direct' ? ' on' : ''}`, onclick: () => ((mode = 'direct'), render()) }, t('laws.direct')),
      h('button', { class: `btn${mode === 'proposal' ? ' on' : ''}`, onclick: () => ((mode = 'proposal'), render()) }, t('laws.proposal')),
    );
    const submit = async () => {
      const raw = val.value;
      const value: RuleValue = isBool ? raw === 'true' : isNum ? Number(raw) : raw;
      if (isNum && !Number.isFinite(value as number)) return;
      notes.set(r.key, { text: t('laws.pending') });
      render();
      const err = await (session.transport?.postRule({ key: r.key, value, mode, message: msg.value.trim() }) ?? Promise.resolve('offline'));
      notes.set(r.key, err ? { text: t('laws.error', { err }), err: true } : { text: t('laws.sent') });
      if (!err) editing = null;
      render();
    };
    const form = h(
      'div',
      { class: 'law-edit' },
      h('div', {}, h('div', { class: 'law key' }, t('laws.mode')), seg),
      h('div', {}, h('div', { class: 'law key' }, r.unit || r.key), val),
      h('div', { class: 'full' }, msg),
      h('button', { class: 'btn primary full', onclick: submit }, mode === 'direct' ? t('laws.apply') : t('laws.propose')),
    );
    form.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if ((ev as KeyboardEvent).key === 'Enter') void submit();
    });
    return form;
  };

  const render = () => {
    const byCat = new Map<string, Rule[]>();
    for (const r of store.rules.values()) {
      const arr = byCat.get(r.category) ?? [];
      arr.push(r);
      byCat.set(r.category, arr);
    }
    const prev = list.scrollTop;
    list.replaceChildren();
    if (!byCat.size) list.append(h('div', { class: 'note' }, t('laws.empty')));
    for (const [cat, rules] of byCat) {
      list.append(h('div', { class: 'law-cat' }, cat));
      for (const r of rules) {
        const note = notes.get(r.key);
        const row = h(
          'div',
          { class: `law${flashed.has(r.key) ? ' changed' : ''}`, style: 'cursor:pointer', onclick: () => ((editing = editing === r.key ? null : r.key), render()) },
          h('div', {}, h('div', { class: 'txt' }, r.text), h('div', { class: 'key' }, r.key)),
          h('div', { class: 'val' }, String(r.value), ' ', h('span', { class: 'unit' }, r.unit)),
        );
        list.append(row);
        if (note) list.append(h('div', { class: `note${note.err ? ' err' : ''}`, style: 'padding:0 8px' }, note.text));
        if (editing === r.key) list.append(editor(r));
      }
    }
    list.scrollTop = prev;
  };

  store.on('hello', () => render());
  store.on('rules_changed', ({ changes }) => {
    for (const c of changes) {
      flashed.add(c.key);
      notes.delete(c.key);
      setTimeout(() => {
        flashed.delete(c.key);
        if (panels.isOpen('laws')) render();
      }, 3200);
    }
    if (panels.isOpen('laws')) render();
  });
}
