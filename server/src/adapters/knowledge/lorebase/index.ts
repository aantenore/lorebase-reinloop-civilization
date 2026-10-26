// Knowledge kept in Lorebase: a Domain (the space), its live branch (the live world), other
// branches (drafts, the hidden catalog), Proposals reviewed and merged into the live branch, and
// the change feed. Writes are Operations: built-in `create_<kind>`/`update_<kind>`/`delete_<kind>`
// and imports by default, or the Operations configured per kind and target (e.g. laws changed
// directly on the live branch through Operations whose review policy is `never`).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  Change, HistoryEntry, Knowledge, KnowledgeInfo, KnowledgeRecord, Proposal, ProposalStatus, RecordSet, Verdict, Watch, WatchHandlers, WriteOptions,
} from '../../../ports/knowledge.ts';
import { LorebaseClient, LorebaseError, type ProposalInfo } from './client.ts';
import { RevisionFeed } from './feed.ts';
import { HeraldConsult, type HeraldConfig } from './herald.ts';

export interface OpSpec {
  op: string;
  /** Parameter carrying the record key (omitted: the key travels in the values). */
  target?: string;
  /** The spec applies only when every changed value is one of these. */
  fields?: string[];
  /** Extra parameters copied from values: { param: valueField }. */
  copy?: Record<string, string>;
}

type OpTable = Record<string, Partial<Record<'create' | 'update' | 'delete', OpSpec[]>>>;

export interface LorebaseConfig {
  url: string;
  domain: string;
  branch: string;
  reconnectMs: number;
  /** Upserts of one kind (`{ kind, rows }`) and of records with links (`{ records }`). */
  importOperation: string;
  importLinkedOperation: string;
  bulkDeleteOperation: string;
  /** Keeper's per-call key cap (keeper.operations.max_bulk_delete_keys). */
  maxBulkDeleteKeys: number;
  /** Operations per kind on the live branch and on any other branch; anything else uses the built-ins. */
  operations: { live: OpTable; draft: OpTable };
  /** Schema applied by ensureSchema (relative to the project root), on a draft merged through a Proposal. */
  schema: { file: string; draftPrefix: string; displayName: string; description: string };
  herald: HeraldConfig;
}

const snake = (kind: string) => kind.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

const proposalOf = (p: ProposalInfo): Proposal => ({
  id: p.id,
  title: p.title,
  description: p.description ?? undefined,
  draft: p.source_ref,
  status: p.status === 'merged' ? 'accepted' : p.status === 'closed' ? 'rejected' : 'open',
  createdAt: p.created_at,
  author: (p as { author?: string }).author,
});

export class LorebaseKnowledge implements Knowledge {
  readonly info: KnowledgeInfo;
  readonly consult: HeraldConsult;
  readonly client: LorebaseClient;
  private readonly cfg: LorebaseConfig;
  private readonly root: string;
  private readonly pollMs: number;

  constructor(cfg: LorebaseConfig, opts: { root: string; pollMs: number }) {
    this.cfg = cfg;
    this.root = opts.root;
    this.pollMs = opts.pollMs;
    this.client = new LorebaseClient(cfg.url, cfg.domain);
    this.consult = new HeraldConsult(cfg.herald, cfg.domain, cfg.branch);
    this.info = { adapter: 'lorebase', location: this.client.url, space: cfg.domain, live: cfg.branch };
  }

  private branchOf(scope?: string): string {
    return scope ?? this.cfg.branch;
  }

  async ready(): Promise<void> {
    await this.client.ready();
  }

  // ---- reading -------------------------------------------------------------------

  async readAll(kind: string, opts: { scope?: string } = {}): Promise<RecordSet> {
    const out = await this.client.listRecords(kind, this.branchOf(opts.scope));
    return { revision: out.revision, items: out.items.map((r) => ({ kind: r.kind ?? kind, key: r.key, values: r.values })) };
  }

  async read(kind: string, key: string, opts: { scope?: string } = {}): Promise<KnowledgeRecord | undefined> {
    try {
      const r = (await this.client.getRecord(kind, key, this.branchOf(opts.scope))).record;
      return r ? { kind, key: r.key ?? key, values: r.values } : undefined;
    } catch (err) {
      if (err instanceof LorebaseError && err.status === 404) return undefined;
      throw err;
    }
  }

  hasScope(scope: string): Promise<boolean> {
    return this.client.getBranch(scope).then(() => true, () => false);
  }

  async history(limit: number): Promise<HistoryEntry[]> {
    const page = await this.client.log(this.cfg.branch, limit);
    return page.items.map((r) => ({
      revision: String(r.id ?? ''),
      message: String(r.message ?? ''),
      time: String(r.created_at ?? ''),
      author: String(r.author ?? ''),
      origin: (r.origin as { type?: string } | undefined)?.type ?? null,
      changes: (r.stats as { changes?: number } | undefined)?.changes ?? null,
      kinds: Object.keys((r.kinds as object | undefined) ?? (r.stats as { kinds?: object } | undefined)?.kinds ?? {}),
    }));
  }

  async overview(kinds: string[]): Promise<{ revision: string; counts: Record<string, number> }> {
    const branch = await this.client.getBranch(this.cfg.branch);
    const counts: Record<string, number> = {};
    const c = await this.client.counts(branch.head).catch(() => ({ partitions: [] }));
    for (const p of c.partitions) if (p.element === 'kind' && kinds.includes(p.name)) counts[p.name] = p.count;
    return { revision: branch.head, counts };
  }

  watch(opts: { kinds: string[]; since(): string }, handlers: WatchHandlers): Watch {
    return new RevisionFeed(this.client, { branch: this.cfg.branch, kinds: opts.kinds, since: opts.since, pollMs: this.pollMs, reconnectMs: this.cfg.reconnectMs }, handlers);
  }

  // ---- writing -------------------------------------------------------------------

  private spec(change: Exclude<Change, { action: 'upsert' }>, live: boolean): OpSpec {
    const table = live ? this.cfg.operations.live : this.cfg.operations.draft;
    const fields = change.action === 'delete' ? [] : Object.keys(change.values);
    const custom = table[change.kind]?.[change.action]?.find((s) => !s.fields || fields.every((f) => s.fields!.includes(f)));
    if (custom) return custom;
    const op = `${change.action}_${snake(change.kind)}`;
    return change.action === 'create' ? { op } : { op, target: 'key' };
  }

  private params(change: Exclude<Change, { action: 'upsert' }>, spec: OpSpec): Record<string, unknown> {
    const values = change.action === 'delete' ? {} : change.values;
    const out: Record<string, unknown> = { ...(spec.target ? { [spec.target]: change.key } : {}), ...values };
    for (const [param, field] of Object.entries(spec.copy ?? {})) out[param] = values[field];
    return out;
  }

  async write(changes: Change[], opts: WriteOptions): Promise<string> {
    const branch = this.branchOf(opts.scope);
    const live = branch === this.cfg.branch;
    let revision = '';
    for (let i = 0; i < changes.length; ) {
      const c = changes[i]!;
      if (c.action === 'upsert') {
        // Consecutive upserts travel in one import (one Revision).
        let j = i;
        while (j < changes.length && changes[j]!.action === 'upsert') j++;
        const batch = changes.slice(i, j) as Array<Extract<Change, { action: 'upsert' }>>;
        i = j;
        const linked = batch.some((x) => x.links && Object.keys(x.links).length);
        const sameKind = batch.every((x) => x.kind === batch[0]!.kind);
        const out = linked || !sameKind
          ? await this.client.execute(this.cfg.importLinkedOperation, { records: batch.map((x) => ({ kind: x.kind, ...x.values, ...(x.links ? { links: x.links } : {}) })) }, { branch, message: opts.message })
          : await this.client.execute(this.cfg.importOperation, { kind: batch[0]!.kind, rows: batch.map((x) => x.values) }, { branch, message: opts.message });
        revision = out.revision ?? out.head;
        continue;
      }
      i++;
      const spec = this.spec(c, live);
      const out = await this.client.execute(spec.op, this.params(c, spec), { branch, message: opts.message });
      revision = out.revision ?? out.head;
    }
    return revision;
  }

  async propose(p: { draft: string; title: string; description?: string; message: string; changes: Change[] }): Promise<Proposal> {
    const created = !(await this.hasScope(p.draft));
    if (created) await this.client.createBranch(p.draft, this.cfg.branch);
    try {
      if (p.changes.length) await this.write(p.changes, { message: p.message, scope: p.draft });
      const pr = await this.client.createProposal(p.draft, this.cfg.branch, p.title, p.description);
      return { id: pr.id, title: p.title, description: p.description, draft: p.draft, status: 'open', createdAt: new Date().toISOString() };
    } catch (err) {
      if (created) await this.client.deleteBranch(p.draft).catch(() => undefined);
      throw err;
    }
  }

  async review(id: string, verdict: Verdict, note: string): Promise<void> {
    await this.client.review(id, verdict, note);
  }

  async accept(id: string, message: string): Promise<string> {
    const info = await this.client.getProposal(id);
    const merged = await this.client.merge(id, message);
    await this.client.deleteBranch(info.source_ref).catch(() => undefined);
    return merged.revision;
  }

  async reject(id: string, note?: string): Promise<void> {
    const info = await this.client.getProposal(id);
    if (note) await this.client.review(id, 'request_changes', note).catch(() => undefined);
    await this.client.closeProposal(id);
    await this.client.deleteBranch(info.source_ref).catch(() => undefined);
  }

  async proposal(id: string): Promise<Proposal | undefined> {
    try {
      return proposalOf(await this.client.getProposal(id));
    } catch (err) {
      if (err instanceof LorebaseError && err.status === 404) return undefined;
      throw err;
    }
  }

  async proposals(status: ProposalStatus): Promise<Proposal[]> {
    const raw = status === 'accepted' ? 'merged' : status === 'rejected' ? 'closed' : 'open';
    return (await this.client.listProposals(raw)).filter((p) => p.target_ref === this.cfg.branch).map(proposalOf);
  }

  async drafts(prefix: string): Promise<string[]> {
    return (await this.client.listBranches()).map((b) => b.name).filter((n) => n.startsWith(prefix) && n !== this.cfg.branch);
  }

  async discardDraft(draft: string): Promise<void> {
    if (draft === this.cfg.branch) throw new Error('the live world is not a draft');
    await this.client.deleteBranch(draft);
  }

  async removeMany(kind: string, keys: string[], opts: WriteOptions): Promise<number> {
    const branch = this.branchOf(opts.scope);
    const size = Math.max(1, this.cfg.maxBulkDeleteKeys);
    for (let i = 0; i < keys.length; i += size) {
      const batch = keys.slice(i, i + size);
      await this.client.execute(this.cfg.bulkDeleteOperation, { kind, keys: batch, skip_missing: true }, { branch, message: opts.message });
    }
    return keys.length;
  }

  async snapshot(scope: string): Promise<void> {
    if (scope === this.cfg.branch) throw new Error('the live world cannot be replaced by a snapshot');
    await this.client.deleteBranch(scope).catch(() => undefined);
    await this.client.createBranch(scope, this.cfg.branch);
  }

  async ensureSchema(): Promise<number> {
    const s = this.cfg.schema;
    try {
      await this.client.getDomain();
    } catch (err) {
      if (!(err instanceof LorebaseError) || err.status !== 404) throw err;
      await this.client.createDomain(s.displayName, s.description);
      console.log(`created domain "${this.cfg.domain}"`);
    }
    const yaml = readFileSync(resolve(this.root, s.file), 'utf8');
    const draft = `${s.draftPrefix}schema-${Date.now().toString(36)}`;
    await this.client.createBranch(draft, this.cfg.branch);
    try {
      const out = await this.client.applySchema(draft, yaml, 'Apply world schema');
      if (!out.change_count) return 0;
      const pr = await this.client.createProposal(draft, this.cfg.branch, 'World schema', 'Schema of the world.');
      await this.client.review(pr.id, 'approve', 'Schema');
      await this.client.merge(pr.id, 'Apply world schema');
      return out.change_count;
    } finally {
      await this.client.deleteBranch(draft).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.consult.close();
  }
}
