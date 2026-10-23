// Read-only overview of the three systems behind the world (Lorebase, mnemo, reinloop), for the
// Observatory view. Server-side proxies only, each answer cached for `cacheMs` so a busy view
// never multiplies calls to Keeper or mnemo.
import type { LorebaseClient } from '../lorebase/client.ts';
import type { Mnemo } from './mnemo.ts';

export interface ObservatoryConfig {
  cacheMs: number;
  maxLimit: number;
  /** Kinds whose Records may be listed through the proxy. */
  kinds: string[];
}

/** Model usage per agent, from the end of each reinloop run. */
export interface UsageRow {
  agentId: string;
  name: string;
  model: string;
  tier: string;
  runs: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export class UsageLedger {
  readonly rows = new Map<string, UsageRow>();
  track(who: { id: string; name: string; model: string; tier: string }, res: { status: string; usage?: { inputTokens?: number; outputTokens?: number }; costUsd?: number }): void {
    const row = this.rows.get(who.id) ?? { agentId: who.id, name: who.name, model: who.model, tier: who.tier, runs: 0, failures: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    row.runs++;
    if (!['completed', 'stopped', 'interrupted'].includes(res.status)) row.failures++;
    row.inputTokens += res.usage?.inputTokens ?? 0;
    row.outputTokens += res.usage?.outputTokens ?? 0;
    row.costUsd += res.costUsd ?? 0;
    this.rows.set(who.id, row);
  }
  totalUsd(): number {
    let sum = 0;
    for (const r of this.rows.values()) sum += r.costUsd;
    return sum;
  }
  /** Totals grouped by a key (model or tier). */
  by(key: 'model' | 'tier'): Record<string, { runs: number; inputTokens: number; outputTokens: number; costUsd: number }> {
    const out: Record<string, { runs: number; inputTokens: number; outputTokens: number; costUsd: number }> = {};
    for (const r of this.rows.values()) {
      const o = (out[r[key]] ??= { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
      o.runs += r.runs;
      o.inputTokens += r.inputTokens;
      o.outputTokens += r.outputTokens;
      o.costUsd = Math.round((o.costUsd + r.costUsd) * 1e6) / 1e6;
    }
    return out;
  }
}

type RunUsage = { status: string; usage?: { inputTokens?: number; outputTokens?: number }; costUsd?: number };

/**
 * Splits the usage of a team run among the model runs nested in it, so each member's model is
 * booked with its own cost. A member called again resumes its run and reports cumulative totals:
 * only the increase since its previous end is booked.
 */
export class NestedUsage {
  private readonly modelRuns = new Set<string>();
  private readonly last = new Map<string, { costUsd: number; inputTokens: number; outputTokens: number }>();
  readonly booked = { costUsd: 0, inputTokens: 0, outputTokens: 0 };

  /** Feeds one run event; returns the usage to book when a nested model run ends. */
  onEvent(ev: { type: string; runId: string; parentRunId?: string; data: unknown }): RunUsage | undefined {
    if (ev.type === 'model_request') this.modelRuns.add(ev.runId);
    if (ev.type !== 'run_end' || !ev.parentRunId || !this.modelRuns.has(ev.runId)) return undefined;
    const end = ev.data as RunUsage;
    const now = { costUsd: end.costUsd ?? 0, inputTokens: end.usage?.inputTokens ?? 0, outputTokens: end.usage?.outputTokens ?? 0 };
    const prev = this.last.get(ev.runId) ?? { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    this.last.set(ev.runId, now);
    const d = { costUsd: Math.max(0, now.costUsd - prev.costUsd), inputTokens: Math.max(0, now.inputTokens - prev.inputTokens), outputTokens: Math.max(0, now.outputTokens - prev.outputTokens) };
    this.booked.costUsd += d.costUsd;
    this.booked.inputTokens += d.inputTokens;
    this.booked.outputTokens += d.outputTokens;
    return { status: end.status, usage: { inputTokens: d.inputTokens, outputTokens: d.outputTokens }, costUsd: d.costUsd };
  }

  /** What the whole run cost beyond the nested runs already booked. */
  remainder(res: RunUsage): RunUsage {
    return {
      status: res.status,
      usage: { inputTokens: Math.max(0, (res.usage?.inputTokens ?? 0) - this.booked.inputTokens), outputTokens: Math.max(0, (res.usage?.outputTokens ?? 0) - this.booked.outputTokens) },
      costUsd: Math.max(0, (res.costUsd ?? 0) - this.booked.costUsd),
    };
  }
}

export interface ObservatoryHost {
  client: LorebaseClient;
  mnemo: Mnemo;
  branch: string;
  revision(): string;
  agents(): Array<{ id: string; name: string; key: string }>;
  stats(): Record<string, number>;
  usage: UsageLedger;
}

const usd = (m: Record<string, { costUsd: number }>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.costUsd]));

export class Observatory {
  private readonly host: ObservatoryHost;
  private readonly cfg: ObservatoryConfig;
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(host: ObservatoryHost, cfg: ObservatoryConfig) {
    this.host = host;
    this.cfg = cfg;
  }

  private cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cfg.cacheMs) return hit.value as Promise<T>;
    const value = fn();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  private limit(raw: string | null, fallback: number): number {
    const n = Math.floor(Number(raw));
    return Math.max(1, Math.min(this.cfg.maxLimit, Number.isFinite(n) && n > 0 ? n : fallback));
  }

  private get base(): string {
    return `${this.host.client.url}/api/v1/domains/${encodeURIComponent(this.host.client.domain)}`;
  }

  /** Routes GET /api/observatory/*; undefined when the path is not one of ours. */
  async handle(path: string, q: URLSearchParams): Promise<{ status: number; body: unknown } | undefined> {
    const sub = path.replace(/^\/api\/observatory\/?/, '');
    try {
      if (sub === 'summary') return { status: 200, body: await this.cached('summary', () => this.summary()) };
      if (sub === 'log') {
        const limit = this.limit(q.get('limit'), 50);
        return { status: 200, body: await this.cached(`log:${limit}`, () => this.log(limit)) };
      }
      if (sub === 'proposals') {
        const status = q.get('status') ?? 'open';
        return { status: 200, body: await this.cached(`proposals:${status}`, () => this.host.client.request('GET', `${this.base}/proposals?${new URLSearchParams({ status, limit: String(this.cfg.maxLimit) })}`)) };
      }
      const rec = /^records\/([A-Za-z]+)$/.exec(sub);
      if (rec) {
        const kind = rec[1]!;
        if (!this.cfg.kinds.includes(kind)) return { status: 404, body: { ok: false, error: 'kind not exposed' } };
        const limit = this.limit(q.get('limit'), 100);
        return { status: 200, body: await this.cached(`records:${kind}:${limit}`, async () => (await this.host.client.listRecords(kind, this.host.branch)).items.slice(-limit).map((r) => r.values)) };
      }
      if (sub === 'memories') {
        const limit = this.limit(q.get('limit'), 50);
        const offset = Math.max(0, Math.floor(Number(q.get('offset')) || 0));
        const agents = this.host.agents().slice(offset, offset + limit);
        const body = await this.cached(`memories:${offset}:${limit}`, async () => ({
          offset, total: this.host.agents().length,
          agents: await Promise.all(agents.map(async (a) => ({ agentId: a.id, name: a.name, memories: await this.host.mnemo.list(a.key).catch(() => []) }))),
        }));
        return { status: 200, body };
      }
      return { status: 404, body: { ok: false, error: 'not found' } };
    } catch (err) {
      return { status: 502, body: { ok: false, error: err instanceof Error ? err.message : String(err) } };
    }
  }

  private async log(limit: number): Promise<unknown> {
    const page = await this.host.client.request<{ items: Array<Record<string, unknown>> }>('GET', `${this.base}/branches/${encodeURIComponent(this.host.branch)}/log?limit=${limit}`);
    return page.items.map((r) => ({ revision: r.id, message: r.message, time: r.created_at, author: r.author, origin: (r.origin as { type?: string } | undefined)?.type ?? null, changes: (r.stats as { changes?: number } | undefined)?.changes ?? null }));
  }

  private async summary(): Promise<unknown> {
    const branch = await this.host.client.getBranch(this.host.branch);
    const counts: Record<string, number> = {};
    const c = await this.host.client.request<{ partitions: Array<{ element: string; name: string; count: number }> }>('GET', `${this.base}/revisions/${branch.head}/counts`).catch(() => ({ partitions: [] }));
    for (const p of c.partitions) if (p.element === 'kind' && this.cfg.kinds.includes(p.name)) counts[p.name] = p.count;
    const health = await this.host.mnemo.health().catch(() => undefined);
    const perAgent = await Promise.all(this.host.agents().map(async (a) => {
      const list = await this.host.mnemo.list(a.key).catch(() => []);
      const avg = list.length ? list.reduce((s, m) => s + m.fidelity, 0) / list.length : 0;
      return { agentId: a.id, name: a.name, count: list.length, avgFidelity: Math.round(avg * 1000) / 1000, gists: list.filter((m) => m.kind === 'gist').length };
    }));
    const u = this.host.usage;
    const rows = [...u.rows.values()];
    return {
      lorebase: { url: this.host.client.url, domain: this.host.client.domain, branch: this.host.branch, revision: branch.head, counts },
      mnemo: { connected: !!health, memories: health?.memories ?? null, perAgent, dbBytes: health?.dbBytes ?? null, lastCompaction: health?.lastCompaction ?? null, embedder: health?.embedder ?? null },
      reinloop: {
        ...this.host.stats(),
        runs: rows.reduce((s, r) => s + r.runs, 0),
        tokens: { input: rows.reduce((s, r) => s + r.inputTokens, 0), output: rows.reduce((s, r) => s + r.outputTokens, 0) },
        costUsd: { total: Math.round(rows.reduce((s, r) => s + r.costUsd, 0) * 1e6) / 1e6, byModel: usd(u.by('model')), byTier: usd(u.by('tier')) },
      },
    };
  }
}
