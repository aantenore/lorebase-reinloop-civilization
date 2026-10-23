import { config } from '../../config';
import { t } from '../../i18n';
import type { Rule, RuleCreateRequest, RuleMode, RuleMutationResult, RulePatchRequest, RuleValue } from '../../net/protocol';
import { session } from '../../net/session';
import { store } from '../../state/store';
import { h } from '../dom';
import type { GodTab } from './godMode';
import { isolateKeys, lorebaseLink, segmented } from './godShared';

/** snake_case segments, optionally dotted (`food.per_hunt`). */
const KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

interface Activity {
  id: number;
  key: string;
  state: 'pending' | 'proposal' | 'done' | 'error';
  text: string;
  timer?: number;
}

/** Text typed in a value field -> the most specific law value (number, boolean, text). */
function parseValue(raw: string, like?: RuleValue): RuleValue | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  if (typeof like === 'boolean' || (like === undefined && (s === 'true' || s === 'false'))) return s === 'true';
  if (typeof like === 'number' || (like === undefined && s !== '' && Number.isFinite(Number(s)))) {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return s;
}

/**
 * Full law editor. Every action goes to the server in direct or proposal mode; nothing is applied
 * locally: an action stays pending until `rules_changed` names its key (or times out).
 */
export function mountGodLaws(): GodTab {
  let mode: RuleMode = 'direct';
  let query = '';
  let editing: string | null = null;
  let creating = false;
  let seq = 0;
  const activity: Activity[] = [];
  const flashed = new Set<string>();

  const search = h('input', { class: 'field', placeholder: t('god.search') }) as HTMLInputElement;
  search.oninput = () => ((query = search.value.trim().toLowerCase()), renderList());
  const count = h('span', { class: 'muted' });
  const newBtn = h('button', { class: 'btn primary', onclick: () => ((creating = !creating), renderCreate()) }, `+ ${t('god.newLaw')}`);
  const createBox = h('div');
  const actBox = h('div', { class: 'god-activity' });
  const list = h('div', { class: 'scroll god-laws' });
  const cats = h('datalist', { id: 'god-cats' });
  const el = h(
    'div',
    { class: 'god-tab god-col' },
    h('div', { class: 'god-row' }, h('span', { class: 'law key' }, t('god.mode')), segmented<RuleMode>([{ value: 'direct', label: t('god.direct') }, { value: 'proposal', label: t('god.proposal') }], mode, (v) => (mode = v)), lorebaseLink()),
    h('div', { class: 'god-row' }, search, count, newBtn),
    createBox,
    actBox,
    list,
    cats,
  );
  isolateKeys(el);

  // ---------------------------------------------------------------- server round trip

  const settle = (a: Activity, state: Activity['state'], text: string) => {
    a.state = state;
    a.text = text;
    if (state === 'done' || state === 'error') window.clearTimeout(a.timer);
    renderActivity();
  };

  const run = async (key: string, call: () => Promise<RuleMutationResult>) => {
    const a: Activity = { id: ++seq, key, state: 'pending', text: t('god.pending', { key }) };
    activity.unshift(a);
    activity.splice(8);
    const isProposal = mode === 'proposal';
    const wait = isProposal ? config.god.pendingTimeoutMs * 6 : config.god.pendingTimeoutMs;
    a.timer = window.setTimeout(() => a.state !== 'done' && settle(a, 'error', t('god.timeout', { key, s: Math.round(wait / 1000) })), wait);
    renderActivity();
    try {
      const tr = session.transport;
      if (!tr) throw new Error('offline');
      const res = (await call()) ?? {};
      if (a.state !== 'pending') return; // rules_changed already settled it
      if (isProposal) {
        const branch = res.proposal?.branch ?? res.branch;
        settle(a, 'proposal', t('god.proposed', { key, branch: branch ? ` (⎇ ${branch})` : '' }));
      }
    } catch (e) {
      settle(a, 'error', t('god.err', { key, err: e instanceof Error ? e.message : String(e) }));
    }
  };

  const create = (req: RuleCreateRequest) => run(req.key, () => session.transport!.request<RuleMutationResult>('POST', '/rules', req));
  const patch = (key: string, req: RulePatchRequest) => run(key, () => session.transport!.request<RuleMutationResult>('PATCH', `/rules/${encodeURIComponent(key)}`, req));
  const retire = (key: string, message: string) =>
    run(key, () => session.transport!.request<RuleMutationResult>('DELETE', `/rules/${encodeURIComponent(key)}?mode=${mode}${message ? `&message=${encodeURIComponent(message)}` : ''}`));

  store.on('rules_changed', ({ revision, changes }) => {
    for (const c of changes) {
      for (const a of activity) if (a.key === c.key && (a.state === 'pending' || a.state === 'proposal')) settle(a, 'done', t('god.done', { key: c.key, rev: revision.slice(0, 7) }));
      flashed.add(c.key);
      setTimeout(() => (flashed.delete(c.key), renderList()), 3200);
    }
    renderList();
  });
  store.on('hello', () => renderList());

  // ---------------------------------------------------------------- rendering

  const renderActivity = () => {
    actBox.replaceChildren(
      ...activity.map((a) =>
        h('div', { class: `god-act ${a.state}` }, h('span', {}, a.state === 'pending' || a.state === 'proposal' ? '⧗ ' : a.state === 'done' ? '✓ ' : '✗ ', a.text), a.state === 'done' ? lorebaseLink() : null),
      ),
    );
  };

  const field = (label: string, input: HTMLElement, full = false) => h('label', { class: `god-field${full ? ' full' : ''}` }, h('span', { class: 'law key' }, label), input);

  const renderCreate = () => {
    newBtn.classList.toggle('on', creating);
    if (!creating) return createBox.replaceChildren();
    const key = h('input', { class: 'field', placeholder: 'food.per_hunt' }) as HTMLInputElement;
    const text = h('input', { class: 'field' }) as HTMLInputElement;
    const cat = h('input', { class: 'field', list: 'god-cats' }) as HTMLInputElement;
    const val = h('input', { class: 'field' }) as HTMLInputElement;
    const unit = h('input', { class: 'field' }) as HTMLInputElement;
    const msg = h('input', { class: 'field', placeholder: t('laws.messagePlaceholder') }) as HTMLInputElement;
    const err = h('div', { class: 'note err' });
    const submit = () => {
      const k = key.value.trim();
      if (!KEY_RE.test(k)) return void (err.textContent = t('god.badKey'));
      if (store.rules.has(k)) return void (err.textContent = t('god.keyExists', { key: k }));
      const value = parseValue(val.value);
      void create({
        key: k,
        ...(value !== undefined ? { value } : {}),
        ...(text.value.trim() ? { text: text.value.trim() } : {}),
        ...(cat.value.trim() ? { category: cat.value.trim() } : {}),
        ...(unit.value.trim() ? { unit: unit.value.trim() } : {}),
        mode,
        message: msg.value.trim(),
      });
      creating = false;
      renderCreate();
    };
    const form = h(
      'div',
      { class: 'law-edit god-form' },
      field(t('god.key'), key),
      field(t('god.category'), cat),
      field(t('god.text'), text, true),
      field(t('god.value'), val),
      field(t('god.unit'), unit),
      field(t('god.message'), msg, true),
      err,
      h('button', { class: 'btn primary full', onclick: submit }, t('god.create')),
    );
    form.addEventListener('keydown', (ev) => (ev as KeyboardEvent).key === 'Enter' && submit());
    createBox.replaceChildren(form);
    key.focus();
  };

  const editor = (r: Rule) => {
    const isBool = typeof r.value === 'boolean';
    const val = isBool
      ? (h('select', { class: 'field' }, h('option', { value: 'true', selected: r.value === true }, 'true'), h('option', { value: 'false', selected: r.value === false }, 'false')) as HTMLSelectElement)
      : (h('input', { class: 'field', type: typeof r.value === 'number' ? 'number' : 'text', step: 'any', value: String(r.value) }) as HTMLInputElement);
    const text = h('input', { class: 'field', value: r.text }) as HTMLInputElement;
    const cat = h('input', { class: 'field', list: 'god-cats', value: r.category }) as HTMLInputElement;
    const msg = h('input', { class: 'field', placeholder: t('laws.messagePlaceholder') }) as HTMLInputElement;
    const err = h('div', { class: 'note err' });
    const save = () => {
      const req: RulePatchRequest = { mode, message: msg.value.trim() };
      const value = parseValue(val.value, r.value);
      if (value !== undefined && value !== r.value) req.value = value;
      if (text.value.trim() && text.value.trim() !== r.text) req.text = text.value.trim();
      if (cat.value.trim() && cat.value.trim() !== r.category) req.category = cat.value.trim();
      if (req.value === undefined && req.text === undefined && req.category === undefined) return void (err.textContent = t('god.noChange'));
      void patch(r.key, req);
      editing = null;
      renderList();
    };
    let armed = false;
    const retireBtn = h('button', { class: 'btn danger' }, t('god.retire'));
    retireBtn.onclick = () => {
      if (!armed) {
        armed = true;
        retireBtn.textContent = t('god.retireConfirm', { key: r.key });
        return;
      }
      void retire(r.key, msg.value.trim());
      editing = null;
      renderList();
    };
    const form = h(
      'div',
      { class: 'law-edit god-form' },
      field(r.unit || t('god.value'), val),
      field(t('god.category'), cat),
      field(t('god.text'), text, true),
      field(t('god.message'), msg, true),
      err,
      h('button', { class: 'btn primary', onclick: save }, mode === 'direct' ? t('god.save') : t('laws.propose')),
      retireBtn,
    );
    form.addEventListener('keydown', (ev) => (ev as KeyboardEvent).key === 'Enter' && (ev.target as HTMLElement).tagName === 'INPUT' && save());
    return form;
  };

  const renderList = () => {
    const all = [...store.rules.values()];
    cats.replaceChildren(...[...new Set(all.map((r) => r.category))].map((c) => h('option', { value: c })));
    const shown = all
      .filter((r) => !query || `${r.key} ${r.text} ${r.category} ${r.value}`.toLowerCase().includes(query))
      .sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key));
    count.textContent = t('god.lawsCount', { n: shown.length });
    const prev = list.scrollTop;
    list.replaceChildren();
    if (!shown.length) list.append(h('div', { class: 'note' }, all.length ? t('god.noLaws') : t('laws.empty')));
    let cat = '';
    for (const r of shown) {
      if (r.category !== cat) list.append(h('div', { class: 'law-cat' }, (cat = r.category)));
      list.append(
        h(
          'div',
          { class: `law${flashed.has(r.key) ? ' changed' : ''}${editing === r.key ? ' open' : ''}`, style: 'cursor:pointer', onclick: () => ((editing = editing === r.key ? null : r.key), renderList()) },
          h('div', {}, h('div', { class: 'txt' }, r.text), h('div', { class: 'key' }, r.key)),
          h('div', { class: 'val' }, String(r.value), ' ', h('span', { class: 'unit' }, r.unit)),
        ),
      );
      if (editing === r.key) list.append(editor(r));
    }
    list.scrollTop = prev;
  };

  return {
    el,
    show: () => renderList(),
    hide: () => undefined,
  };
}
