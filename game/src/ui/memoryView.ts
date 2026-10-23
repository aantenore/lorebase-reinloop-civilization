import { t } from '../i18n';
import type { Memory, MemoryList, MemoryMsg } from '../net/protocol';
import { session } from '../net/session';
import { store } from '../state/store';
import { fmtClock, h } from './dom';

/** Exit animations last this long before the node is removed (keep in sync with styles.css). */
const DISSOLVE_MS = 1600;
const MERGE_MS = 900;

/**
 * Private memory of one agent (reinloop). Kept as a persistent DOM block so live changes animate:
 * text fades with fidelity (opacity, blur, letter spacing), new memories ink in, merged ones fold
 * into a gist, forgotten ones dissolve.
 */
export class MemoryView {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private status: HTMLElement;
  private agentId: string | null = null;
  private rows = new Map<string, HTMLElement>();
  private loadSeq = 0;
  private state: 'loading' | 'ok' | 'fail' = 'ok';

  constructor() {
    this.list = h('div', { class: 'mem-list' });
    this.status = h('div', { class: 'note' });
    this.el = h('div', { class: 'mem' }, h('div', { class: 'section-title' }, t('insp.memory')), h('div', { class: 'note mem-note' }, t('insp.memoryNote')), this.status, this.list);
    store.on('memory', (m) => this.onEvent(m));
    store.on('memories', ({ agentId }) => agentId === this.agentId && this.renderAll());
  }

  /** Show the memories of `id` (null hides the block). Fetches them once per selection. */
  setAgent(id: string | null): void {
    const e = id ? store.entities.get(id) : undefined;
    const has = !!e && e.kind === 'agent';
    this.el.classList.toggle('hidden', !has);
    if (!has) {
      this.agentId = null;
      return;
    }
    if (this.agentId === id) return;
    this.agentId = id;
    this.list.replaceChildren();
    this.rows.clear();
    this.renderAll();
    void this.load(id!);
  }

  private async load(id: string): Promise<void> {
    const seq = ++this.loadSeq;
    const tr = session.transport;
    if (!tr) return;
    this.state = 'loading';
    this.renderAll();
    try {
      const res = await tr.getJson<MemoryList | Memory[]>(`/agents/${encodeURIComponent(id)}/memories`);
      if (seq !== this.loadSeq) return;
      this.state = 'ok';
      store.setMemories(id, Array.isArray(res) ? res : (res.memories ?? []));
    } catch {
      if (seq !== this.loadSeq) return;
      this.state = 'fail';
      this.renderAll();
    }
  }

  private sorted(): Memory[] {
    const mem = this.agentId ? store.memories.get(this.agentId) : undefined;
    return [...(mem?.values() ?? [])].sort((a, b) => b.createdAt.day - a.createdAt.day || b.createdAt.minute - a.createdAt.minute);
  }

  private renderAll(): void {
    const list = this.sorted();
    this.status.textContent = list.length ? '' : t(this.state === 'loading' ? 'insp.memLoading' : this.state === 'fail' ? 'insp.memUnavailable' : 'insp.memEmpty');
    const keep = new Set(list.map((m) => m.id));
    for (const [id, row] of this.rows) {
      if (!keep.has(id) && !row.classList.contains('leaving')) {
        row.remove();
        this.rows.delete(id);
      }
    }
    list.forEach((m, i) => {
      const row = this.rows.get(m.id) ?? this.makeRow(m);
      this.paint(row, m);
      const at = this.list.children[i];
      if (at !== row) this.list.insertBefore(row, at ?? null);
    });
  }

  private makeRow(m: Memory): HTMLElement {
    const row = h('div', { class: 'memory', 'data-id': m.id }, h('div', { class: 'm-text' }), h('div', { class: 'm-meta' }));
    this.rows.set(m.id, row);
    return row;
  }

  /** Apply fidelity styling and metadata. */
  private paint(row: HTMLElement, m: Memory): void {
    const f = Math.max(0, Math.min(1, m.fidelity));
    row.style.setProperty('--fid', f.toFixed(3));
    row.classList.toggle('gist', m.kind === 'gist');
    const text = row.querySelector('.m-text') as HTMLElement;
    if (text.textContent !== m.text) text.textContent = m.text;
    const meta = row.querySelector('.m-meta') as HTMLElement;
    const sig = `${f.toFixed(2)}|${m.kind}|${m.recalls}|${m.emotion}|${m.importance}`;
    if (meta.dataset.sig === sig) return;
    meta.dataset.sig = sig;
    const emo = typeof m.emotion === 'number' ? (m.emotion > 0.15 ? '+' : m.emotion < -0.15 ? '−' : '·') : m.emotion;
    const parts: (Node | null)[] = [
      m.kind === 'gist' ? h('span', { class: 'badge gist' }, t('mem.gist')) : null,
      h('span', { class: 'fid', title: `${t('mem.fidelity')} ${Math.round(f * 100)}%` }, h('i', { style: `width:${f * 100}%` })),
      emo ? h('span', { class: 'emo' }, String(emo)) : null,
      h('span', { class: 'imp', title: `importance ${m.importance}` }, '●'.repeat(Math.max(1, Math.min(3, Math.round(m.importance * 3))))),
      m.recalls ? h('span', { class: 'muted' }, t('mem.recalls', { n: m.recalls })) : null,
      h('span', { class: 'muted when' }, `g${m.createdAt.day} ${fmtClock(m.createdAt.minute)}`),
    ];
    meta.replaceChildren(...parts.filter((p): p is Node => !!p));
  }

  /** Re-trigger a one-shot CSS animation class. */
  private flash(row: HTMLElement, cls: string, label?: string): void {
    row.classList.remove(cls);
    void row.offsetWidth;
    row.classList.add(cls);
    if (label) row.dataset.fx = label;
    setTimeout(() => row.classList.remove(cls), 1800);
  }

  private onEvent(msg: MemoryMsg): void {
    if (msg.agentId !== this.agentId) return;
    const { memory: m, action } = msg;
    if (action === 'forgotten') {
      const row = this.rows.get(m.id);
      if (!row) return;
      this.paint(row, m);
      row.dataset.fx = t('mem.forgotten');
      row.classList.add('leaving', 'dissolve');
      setTimeout(() => {
        row.remove();
        if (this.rows.get(m.id) === row) this.rows.delete(m.id);
      }, DISSOLVE_MS);
      return;
    }
    if (action === 'merged') {
      const folded = (msg.mergedFrom ?? []).map((id) => this.rows.get(id)).filter((r): r is HTMLElement => !!r);
      for (const r of folded) {
        r.classList.add('leaving', 'fold');
        setTimeout(() => {
          r.remove();
          const id = r.dataset.id!;
          if (this.rows.get(id) === r) this.rows.delete(id);
        }, MERGE_MS);
      }
      setTimeout(() => {
        this.renderAll();
        const row = this.rows.get(m.id);
        if (row) this.flash(row, 'merged', t('mem.merged'));
      }, folded.length ? MERGE_MS * 0.6 : 0);
      return;
    }
    const isNew = !this.rows.has(m.id);
    this.renderAll();
    const row = this.rows.get(m.id);
    if (!row) return;
    if (action === 'added' || isNew) this.flash(row, 'added', t('mem.added'));
    else if (action === 'blurred') this.flash(row, 'blurred', t('mem.blurred'));
    else if (action === 'recalled') this.flash(row, 'recalled', t('mem.recalled'));
  }
}
