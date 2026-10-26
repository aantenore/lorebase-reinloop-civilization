// Shared knowledge kept in this process (tests, offline runs): nothing survives a restart. The
// live world, drafts and other scopes are record maps; a scope starts as a copy of the live
// world and records the changes made on it, which an accepted proposal replays onto the live
// world as one revision. Every live revision is kept in the history and reported to watchers.
// Consultations read the live world only.
import { randomUUID } from 'node:crypto';
import type {
  Change, ConsultTool, HistoryEntry, Knowledge, KnowledgeConsult, KnowledgeInfo, KnowledgeRecord, Proposal, ProposalStatus, RecordSet, Revision,
  Verdict, Watch, WatchHandlers, WriteOptions,
} from '../../../ports/knowledge.ts';

export interface MemoryKnowledgeConfig {
  /** Name of the knowledge space and of the live world (as other adapters would name them). */
  space: string;
  live: string;
  /** Revisions kept in the history. */
  historyMax: number;
}

/** What the knowledge holds at start: changes for the live world, then for named scopes (copies of the live world). */
export interface MemorySeed {
  live: Change[][];
  scopes?: Record<string, Change[][]>;
}

type Records = Map<string, Map<string, Record<string, unknown>>>;

interface Stored extends Proposal {
  reviews: Array<{ verdict: Verdict; note: string }>;
}

interface RecordVersion {
  revision: string;
  at: string;
  message: string;
  values: Record<string, unknown> | null;
}

const copy = (r: Records): Records => new Map([...r].map(([k, m]) => [k, new Map([...m].map(([key, v]) => [key, structuredClone(v)]))]));

export class MemoryKnowledge implements Knowledge {
  readonly info: KnowledgeInfo;
  readonly consult: KnowledgeConsult;
  private readonly cfg: MemoryKnowledgeConfig;
  private readonly scopes = new Map<string, Records>();
  /** Changes made on each scope other than the live world since it was copied. */
  private readonly logs = new Map<string, Change[]>();
  private readonly proposals_ = new Map<string, Stored>();
  private readonly log: Array<Revision & { keys: Record<string, string[]> }> = [];
  private readonly versions = new Map<string, RecordVersion[]>();
  private readonly watchers = new Set<{ kinds: Set<string>; handlers: WatchHandlers }>();
  private head = '';
  private ids = 0;

  constructor(cfg: MemoryKnowledgeConfig, seed: MemorySeed = { live: [] }) {
    this.cfg = cfg;
    this.info = { adapter: 'memory', location: 'memory://', space: cfg.space, live: cfg.live };
    this.scopes.set(cfg.live, new Map());
    for (const batch of seed.live) this.commit(batch, 'Seed', 'seed');
    for (const [scope, batches] of Object.entries(seed.scopes ?? {})) {
      this.scopes.set(scope, copy(this.live));
      this.logs.set(scope, []);
      for (const batch of batches) for (const c of batch) this.apply(this.scopes.get(scope)!, c);
    }
    this.consult = new MemoryConsult(this);
  }

  private get live(): Records {
    return this.scopes.get(this.cfg.live)!;
  }

  private scopeOf(scope?: string): Records {
    const s = this.scopes.get(scope ?? this.cfg.live);
    if (!s) throw new Error(`unknown scope "${scope}"`);
    return s;
  }

  private apply(records: Records, c: Change): void {
    const kind = records.get(c.kind) ?? new Map<string, Record<string, unknown>>();
    records.set(c.kind, kind);
    const have = kind.get(c.key);
    if (c.action === 'delete') {
      if (!have) throw new Error(`${c.kind}/${c.key} does not exist`);
      kind.delete(c.key);
    } else if (c.action === 'create') {
      if (have) throw new Error(`${c.kind}/${c.key} already exists`);
      kind.set(c.key, structuredClone(c.values));
    } else if (c.action === 'update') {
      if (!have) throw new Error(`${c.kind}/${c.key} does not exist`);
      kind.set(c.key, { ...have, ...structuredClone(c.values) });
    } else kind.set(c.key, structuredClone(c.values));
  }

  /** Applies changes to the live world as one revision and tells the watchers. */
  private commit(changes: Change[], message: string, author = 'world'): string {
    // All or nothing: the touched kinds are applied on copies (records are never mutated in place).
    const trial: Records = new Map(this.live);
    for (const kind of new Set(changes.map((c) => c.kind))) trial.set(kind, new Map(this.live.get(kind) ?? []));
    for (const c of changes) this.apply(trial, c);
    this.scopes.set(this.cfg.live, trial);
    const revision = randomUUID().replace(/-/g, '');
    const at = new Date().toISOString();
    const kinds: Record<string, number> = {};
    const keys: Record<string, string[]> = {};
    for (const c of changes) {
      kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
      (keys[c.kind] ??= []).push(c.key);
      const id = `${c.kind}/${c.key}`;
      const list = this.versions.get(id) ?? [];
      list.push({ revision, at, message, values: trial.get(c.kind)?.get(c.key) ?? null });
      this.versions.set(id, list.slice(-this.cfg.historyMax));
    }
    const rev = { revision, message, author, at, kinds, keys };
    this.log.push(rev);
    if (this.log.length > this.cfg.historyMax) this.log.splice(0, this.log.length - this.cfg.historyMax);
    this.head = revision;
    for (const w of this.watchers) {
      if (!Object.keys(kinds).some((k) => w.kinds.has(k))) continue;
      const { keys: _keys, ...event } = rev;
      setImmediate(() => w.handlers.onRevision(event));
    }
    return revision;
  }

  async ready(): Promise<void> {}

  // ---- reading -------------------------------------------------------------------

  async readAll(kind: string, opts: { scope?: string } = {}): Promise<RecordSet> {
    const items = [...(this.scopeOf(opts.scope).get(kind) ?? new Map())].map(([key, values]) => ({ kind, key, values: structuredClone(values) }));
    return { revision: this.head, items };
  }

  async read(kind: string, key: string, opts: { scope?: string } = {}): Promise<KnowledgeRecord | undefined> {
    const values = this.scopeOf(opts.scope).get(kind)?.get(key);
    return values ? { kind, key, values: structuredClone(values) } : undefined;
  }

  async hasScope(scope: string): Promise<boolean> {
    return this.scopes.has(scope);
  }

  async history(limit: number): Promise<HistoryEntry[]> {
    return this.log.slice(-limit).reverse().map((r) => ({
      revision: r.revision, message: r.message, time: r.at, author: r.author, origin: null,
      changes: Object.values(r.kinds).reduce((a, b) => a + b, 0), kinds: Object.keys(r.kinds),
    }));
  }

  /** Kinds with records in the live world. */
  kinds(): string[] {
    return [...this.live].filter(([, m]) => m.size).map(([k]) => k).sort();
  }

  /** History of one record of the live world, newest first. */
  recordHistory(kind: string, key: string, limit: number): RecordVersion[] {
    return (this.versions.get(`${kind}/${key}`) ?? []).slice(-limit).reverse();
  }

  async overview(kinds: string[]): Promise<{ revision: string; counts: Record<string, number> }> {
    return { revision: this.head, counts: Object.fromEntries(kinds.map((k) => [k, this.live.get(k)?.size ?? 0])) };
  }

  watch(opts: { kinds: string[]; since(): string }, handlers: WatchHandlers): Watch {
    const w = { kinds: new Set(opts.kinds), handlers };
    this.watchers.add(w);
    setImmediate(() => {
      handlers.onStatus(true, 'in-process knowledge');
      // Anything committed between the caller's read and now.
      if (opts.since() !== this.head) handlers.onRevision();
    });
    return { connected: true, stop: () => this.watchers.delete(w) };
  }

  // ---- writing -------------------------------------------------------------------

  async write(changes: Change[], opts: WriteOptions): Promise<string> {
    const scope = opts.scope ?? this.cfg.live;
    if (scope !== this.cfg.live) {
      // All or nothing, like a live commit: applied on copies of the touched kinds.
      const records = this.scopeOf(scope);
      const trial: Records = new Map(records);
      for (const kind of new Set(changes.map((c) => c.kind))) trial.set(kind, new Map(records.get(kind) ?? []));
      for (const c of changes) this.apply(trial, c);
      this.scopes.set(scope, trial);
      this.logs.get(scope)?.push(...changes);
      return this.head;
    }
    // Like a backend writing one change per call: upserts together, any other change on its own.
    let revision = this.head;
    for (let i = 0; i < changes.length; ) {
      let j = i + 1;
      if (changes[i]!.action === 'upsert') while (j < changes.length && changes[j]!.action === 'upsert') j++;
      revision = this.commit(changes.slice(i, j), opts.message);
      i = j;
    }
    return revision;
  }

  async propose(p: { draft: string; title: string; description?: string; message: string; changes: Change[] }): Promise<Proposal> {
    const created = !this.scopes.has(p.draft);
    if (created) await this.snapshot(p.draft);
    try {
      await this.write(p.changes, { message: p.message, scope: p.draft });
    } catch (err) {
      if (created) await this.discardDraft(p.draft);
      throw err;
    }
    const proposal: Stored = { id: `p-${(++this.ids).toString(36)}`, title: p.title, description: p.description, draft: p.draft, status: 'open', createdAt: new Date().toISOString(), reviews: [] };
    this.proposals_.set(proposal.id, proposal);
    return this.public(proposal);
  }

  private public(p: Stored): Proposal {
    const { reviews: _reviews, ...out } = p;
    return { ...out };
  }

  private open(id: string): Stored {
    const p = this.proposals_.get(id);
    if (!p) throw new Error(`unknown proposal "${id}"`);
    if (p.status !== 'open') throw new Error(`proposal "${id}" is ${p.status}`);
    return p;
  }

  async review(id: string, verdict: Verdict, note: string): Promise<void> {
    this.open(id).reviews.push({ verdict, note });
  }

  async accept(id: string, message: string): Promise<string> {
    const p = this.open(id);
    const changes = this.logs.get(p.draft) ?? [];
    const revision = changes.length ? this.commit(changes, message) : this.head;
    p.status = 'accepted';
    await this.discardDraft(p.draft);
    return revision;
  }

  async reject(id: string, note?: string): Promise<void> {
    const p = this.open(id);
    if (note) p.reviews.push({ verdict: 'request_changes', note });
    p.status = 'rejected';
    await this.discardDraft(p.draft);
  }

  async proposal(id: string): Promise<Proposal | undefined> {
    const p = this.proposals_.get(id);
    return p && this.public(p);
  }

  async proposals(status: ProposalStatus): Promise<Proposal[]> {
    return [...this.proposals_.values()].filter((p) => p.status === status).map((p) => this.public(p));
  }

  async drafts(prefix: string): Promise<string[]> {
    return [...this.scopes.keys()].filter((s) => s !== this.cfg.live && s.startsWith(prefix));
  }

  async discardDraft(draft: string): Promise<void> {
    if (draft === this.cfg.live) throw new Error('the live world is not a draft');
    this.scopes.delete(draft);
    this.logs.delete(draft);
  }

  async removeMany(kind: string, keys: string[], opts: WriteOptions): Promise<number> {
    const records = this.scopeOf(opts.scope).get(kind);
    const present = keys.filter((k) => records?.has(k));
    if (present.length) await this.write(present.map((key) => ({ action: 'delete', kind, key })), opts);
    return keys.length;
  }

  async snapshot(scope: string): Promise<void> {
    if (scope === this.cfg.live) throw new Error('the live world cannot be replaced by a snapshot');
    this.scopes.set(scope, copy(this.live));
    this.logs.set(scope, []);
  }

  async ensureSchema(): Promise<number> {
    return 0;
  }

  async close(): Promise<void> {
    this.watchers.clear();
  }
}

const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const refOf = (raw: unknown): [string, string] | undefined => {
  const m = /^([A-Za-z]+)\/(.+)$/.exec(String(raw ?? '').trim());
  return m ? [m[1]!, m[2]!] : undefined;
};
const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9_]+/).filter((w) => w.length > 2);

/** Consultations of the live world, answered from the records in this process. */
class MemoryConsult implements KnowledgeConsult {
  readonly connected = true;
  private readonly k: MemoryKnowledge;

  constructor(k: MemoryKnowledge) {
    this.k = k;
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  private async all(kinds?: unknown): Promise<KnowledgeRecord[]> {
    const want = Array.isArray(kinds) && kinds.length ? kinds.map(String) : this.k.kinds();
    const out: KnowledgeRecord[] = [];
    for (const kind of want) out.push(...(await this.k.readAll(kind)).items);
    return out;
  }

  tools(): ConsultTool[] {
    const ok = (content: string) => ({ content, isError: false });
    const fail = (content: string) => ({ content, isError: true });
    const line = (r: KnowledgeRecord) => `${r.kind}/${r.key}: ${Object.entries(r.values).map(([k, v]) => `${k}=${text(v)}`).join('; ')}`;
    const limitOf = (v: unknown, d: number) => Math.max(1, Math.min(50, Math.floor(Number(v)) || d));
    return [
      {
        name: 'conoscenza_cerca',
        schema: { type: 'object', properties: { query: { type: 'string' }, kinds: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' } }, required: ['query'] },
        call: async (a) => {
          const q = words(String(a.query ?? ''));
          if (!q.length) return fail('empty query');
          const hits = (await this.all(a.kinds))
            .map((r) => ({ r, n: words(`${r.key} ${Object.values(r.values).map(text).join(' ')}`).filter((w) => q.includes(w)).length }))
            .filter((h) => h.n > 0)
            .sort((x, y) => y.n - x.n)
            .slice(0, limitOf(a.limit, 10));
          return ok(hits.length ? hits.map((h) => line(h.r)).join('\n') : 'no results');
        },
      },
      {
        name: 'conoscenza_leggi',
        schema: { type: 'object', properties: { ref: { type: 'string', description: 'Kind/key' } }, required: ['ref'] },
        call: async (a) => {
          const ref = refOf(a.ref);
          const r = ref && (await this.k.read(ref[0], ref[1]));
          return r ? ok(line(r)) : fail(`not found: ${String(a.ref ?? '')}`);
        },
      },
      {
        name: 'conoscenza_interroga',
        schema: { type: 'object', properties: { kind: { type: 'string' }, where: { type: 'object' }, limit: { type: 'number' } }, required: ['kind'] },
        call: async (a) => {
          const where = (a.where && typeof a.where === 'object' ? a.where : {}) as Record<string, unknown>;
          const rows = (await this.k.readAll(String(a.kind ?? ''))).items.filter((r) => Object.entries(where).every(([k, v]) => text(r.values[k]) === text(v)));
          return ok(rows.slice(0, limitOf(a.limit, 20)).map(line).join('\n') || 'no results');
        },
      },
      {
        name: 'conoscenza_storia',
        schema: { type: 'object', properties: { ref: { type: 'string', description: 'Kind/key' }, limit: { type: 'number' } }, required: ['ref'] },
        call: async (a) => {
          const ref = refOf(a.ref);
          if (!ref) return fail('ref must be Kind/key');
          const list = this.k.recordHistory(ref[0], ref[1], limitOf(a.limit, 10));
          return ok(list.map((v) => `${v.revision.slice(0, 12)} ${v.at} ${v.message}: ${v.values ? text(v.values) : 'removed'}`).join('\n') || 'no history');
        },
      },
      {
        name: 'conoscenza_cambiamenti',
        schema: { type: 'object', properties: { limit: { type: 'number' } } },
        call: async (a) => ok((await this.k.history(limitOf(a.limit, 10))).map((h) => `${h.revision.slice(0, 12)} ${h.time} ${h.message} (${h.kinds.join(', ')})`).join('\n') || 'no changes'),
      },
      {
        name: 'conoscenza_schema',
        schema: { type: 'object', properties: {} },
        call: async () => {
          const out: string[] = [];
          for (const kind of this.k.kinds()) {
            const fields = new Set<string>();
            for (const r of (await this.k.readAll(kind)).items) for (const f of Object.keys(r.values)) fields.add(f);
            out.push(`${kind}: ${[...fields].join(', ')}`);
          }
          return ok(out.join('\n'));
        },
      },
    ];
  }
}
