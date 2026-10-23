// Ties store, embedder and rewriter together: add / recall / compact and the compaction timer.
// Only namespaces in `namespaces.fading` fade, get strengthened on recall, are compacted and log
// events; `static` namespaces always report fidelity 1 and are never touched.
import { randomUUID } from 'node:crypto';
import type { MnemoConfig } from './config.ts';
import { planCompaction } from './compaction.ts';
import type { Embedder } from './embed.ts';
import { fidelityAt, initialStability, strengthenOnRecall } from './fading.ts';
import { rerankOrder, type Rewriter, type TextModel } from './llm.ts';
import { bm25Norm, recallScore, recency } from './score.ts';
import type { MemRow, Store } from './store.ts';

export interface Memory {
  id: string;
  text: string;
  fidelity: number;
  importance: number;
  emotion: number;
  kind: 'episodic' | 'gist';
  createdAt: { day: number; minute: number };
  recalls: number;
}

export type MemoryEventAction = 'added' | 'blurred' | 'merged' | 'forgotten' | 'recalled';

export interface MemoryEvent {
  seq: number;
  agentId: string;
  action: MemoryEventAction;
  memory: Memory;
}

export interface AddInput {
  agent: string;
  text: string;
  ns?: string;
  kind?: 'episodic' | 'gist';
  importance?: number;
  emotion?: number;
  at?: { day: number; minute: number };
  source?: string;
  meta?: unknown;
}

export interface ServiceDeps {
  cfg: MnemoConfig;
  store: Store;
  embedder: Embedder;
  rewriter: Rewriter;
  /** Needed only for optional reranking. */
  textModel?: TextModel;
  now?: () => number;
  rng?: () => number;
}

const DEFAULT_NS = 'mind';
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export class MnemoService {
  private readonly cfg: MnemoConfig;
  private readonly store: Store;
  private readonly rewriter: Rewriter;
  private readonly textModel: TextModel | undefined;
  private readonly now: () => number;
  private readonly rng: () => number;
  private embedder: Embedder;
  private timer: NodeJS.Timeout | undefined;
  private compacting: Promise<MemoryEvent[]> | undefined;
  private agentCursor = 0;
  private eventsSinceTrim = 0;

  constructor(deps: ServiceDeps) {
    this.cfg = deps.cfg;
    this.store = deps.store;
    this.embedder = deps.embedder;
    this.rewriter = deps.rewriter;
    this.textModel = deps.textModel;
    this.now = deps.now ?? Date.now;
    this.rng = deps.rng ?? Math.random;
  }

  get embedderInfo(): { name: string; dim: number } {
    return { name: this.embedder.name, dim: this.embedder.dim };
  }

  isFading(ns: string): boolean {
    return this.cfg.namespaces.fading.includes(ns);
  }

  isKnownNs(ns: string): boolean {
    return this.isFading(ns) || this.cfg.namespaces.static.includes(ns);
  }

  toMemory(row: MemRow, nowMs = this.now()): Memory {
    return {
      id: row.id,
      text: row.text,
      fidelity: round3(this.isFading(row.ns) ? fidelityAt(row, nowMs) : 1),
      importance: row.importance,
      emotion: row.emotion,
      kind: row.kind,
      createdAt: { day: row.created_day, minute: row.created_minute },
      recalls: row.recalls,
    };
  }

  /** Re-embeds rows written by a different embedder (call at startup, and after embedder changes). */
  async reembedStale(): Promise<number> {
    let n = 0;
    for (;;) {
      const rows = this.store.stale(this.embedder.name, this.cfg.embedder.reembedBatch);
      if (rows.length === 0) return n;
      const vecs = await this.embedder.embed(rows.map((r) => r.text), 'passage');
      rows.forEach((r, i) => this.store.update(r.id, { embedding: vecs[i]!, embedder: this.embedder.name }));
      n += rows.length;
    }
  }

  private logEvent(agent: string, action: MemoryEventAction, memory: Memory): number {
    const seq = this.store.appendEvent(this.now(), agent, action, memory);
    if (++this.eventsSinceTrim >= this.cfg.events.trimEvery) {
      this.eventsSinceTrim = 0;
      this.store.trimEvents(this.cfg.events.maxKept);
    }
    return seq;
  }

  async add(input: AddInput): Promise<Memory> {
    const ns = input.ns ?? DEFAULT_NS;
    const kind = input.kind ?? 'episodic';
    const importance = clamp(input.importance ?? 0.5, 0, 1);
    const emotion = clamp(input.emotion ?? 0, -1, 1);
    const now = this.now();
    const [vec] = await this.embedder.embed([input.text], 'passage');
    const row: MemRow = {
      id: randomUUID(),
      ns,
      agent: input.agent,
      text: input.text,
      kind,
      importance,
      emotion,
      recalls: 0,
      created_day: input.at?.day ?? 0,
      created_minute: input.at?.minute ?? 0,
      created_ms: now,
      anchor_ms: now,
      anchor_fidelity: kind === 'gist' ? this.cfg.fading.gistFidelity : 1,
      stability_ms: initialStability(importance, emotion, this.cfg.fading, kind),
      // A gist is already vague: start it past the last blur level.
      blur_level: kind === 'gist' ? this.cfg.compaction.blurBelow.length : 0,
      pending_blur: 0,
      source: input.source ?? null,
      meta: input.meta === undefined ? null : JSON.stringify(input.meta),
      embedding: vec!,
      embedder: this.embedder.name,
    };
    this.store.add(row);
    const mem = this.toMemory(row, now);
    if (this.isFading(ns)) this.logEvent(input.agent, 'added', mem);
    return mem;
  }

  async recall(input: { agent?: string; query: string; ns?: string; limit?: number }): Promise<Array<Memory & { score: number; ns: string; agent: string }>> {
    const ns = input.ns ?? DEFAULT_NS;
    const fading = this.isFading(ns);
    const now = this.now();
    const rc = this.cfg.recall;
    const [qvec] = await this.embedder.embed([input.query], 'query');
    const cands = this.store.candidates(ns, fading ? input.agent : undefined, input.query, qvec!, rc.candidates);
    const bm = bm25Norm(cands.filter((c) => c.bm25 !== undefined).map((c) => c.bm25!));
    let bi = 0;
    let ranked = cands
      .map((c) => {
        const bm25 = c.bm25 === undefined ? 0 : bm[bi++]!;
        const fidelity = fading ? fidelityAt(c.row, now) : 1;
        const score = recallScore(
          { cosine: Math.max(0, c.cosine), bm25, fidelity, recency: recency(now, c.row.created_ms, rc.recencyHalfLifeHours), importance: c.row.importance },
          rc.weights,
        );
        return { row: c.row, score };
      })
      .sort((a, b) => b.score - a.score);

    if (rc.rerank.enabled && this.textModel && ranked.length >= rc.rerank.minCandidates) {
      const order = await rerankOrder(this.textModel, rc.rerank.model, this.cfg.llm.maxOutputTokens, input.query, ranked.map((r) => r.row.text));
      if (order) {
        const seen = new Set(order);
        ranked = [...order.map((i) => ranked[i]!), ...ranked.filter((_, i) => !seen.has(i))];
      }
    }

    const top = ranked.slice(0, input.limit ?? rc.defaultLimit);
    return top.map(({ row, score }) => {
      const mem = this.toMemory(row, now);
      if (fading) {
        const next = strengthenOnRecall(row, now, this.cfg, this.rng);
        this.store.update(row.id, next);
        this.logEvent(row.agent, 'recalled', mem);
      }
      return { ...mem, score: round3(score), ns: row.ns, agent: row.agent };
    });
  }

  list(agent: string, ns = DEFAULT_NS): Memory[] {
    const now = this.now();
    return this.store.listByAgent(agent, ns).map((r) => this.toMemory(r, now));
  }

  /**
   * One compaction pass (agents default to every agent with fading memories, rotating through
   * at most maxAgentsPerPass). Merged source memories are deleted silently: consumers see the new
   * gist through its `merged` event. Concurrent calls share the running pass.
   */
  compact(agents?: string[]): Promise<MemoryEvent[]> {
    this.compacting ??= this.runCompaction(agents).finally(() => {
      this.compacting = undefined;
    });
    return this.compacting;
  }

  private pickAgents(requested: string[] | undefined): Array<{ ns: string; agent: string }> {
    const all: Array<{ ns: string; agent: string }> = [];
    for (const ns of this.cfg.namespaces.fading) for (const agent of this.store.listAgents(ns)) all.push({ ns, agent });
    const scope = requested ? all.filter((a) => requested.includes(a.agent)) : all;
    const max = this.cfg.compaction.maxAgentsPerPass;
    if (scope.length <= max) return scope;
    const start = this.agentCursor % scope.length;
    this.agentCursor = start + max;
    return Array.from({ length: max }, (_, i) => scope[(start + i) % scope.length]!);
  }

  private async runCompaction(requested: string[] | undefined): Promise<MemoryEvent[]> {
    const out: MemoryEvent[] = [];
    const emit = (agent: string, action: MemoryEventAction, memory: Memory) => out.push({ seq: this.logEvent(agent, action, memory), agentId: agent, action, memory });
    const cc = this.cfg.compaction;
    this.rewriter.beginPass();
    for (const { ns, agent } of this.pickAgents(requested)) {
      const now = this.now();
      const rows = this.store.listByAgent(agent, ns);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const plan = planCompaction(rows, now, cc);

      for (const id of plan.forget) {
        emit(agent, 'forgotten', this.toMemory(byId.get(id)!, now));
        this.store.delete([id]);
      }

      for (const ids of plan.merge) {
        const src = ids.map((id) => byId.get(id)!);
        const text = await this.rewriter.merge(src.map((r) => r.text));
        const [vec] = await this.embedder.embed([text], 'passage');
        const importance = Math.max(...src.map((r) => r.importance));
        const emotion = src.reduce((s, r) => s + r.emotion, 0) / src.length;
        const created = src.reduce((a, b) => (a.created_ms <= b.created_ms ? a : b));
        const gist: MemRow = {
          id: randomUUID(),
          ns,
          agent,
          text,
          kind: 'gist',
          importance,
          emotion,
          recalls: 0,
          created_day: created.created_day,
          created_minute: created.created_minute,
          created_ms: created.created_ms,
          anchor_ms: now,
          anchor_fidelity: this.cfg.fading.gistFidelity,
          stability_ms: initialStability(importance, emotion, this.cfg.fading, 'gist'),
          blur_level: cc.blurBelow.length,
          pending_blur: 0,
          source: 'merge',
          meta: JSON.stringify({ merged: ids.length }),
          embedding: vec!,
          embedder: this.embedder.name,
        };
        this.store.add(gist);
        this.store.delete(ids);
        emit(agent, 'merged', this.toMemory(gist, now));
      }

      if (plan.blur.length > 0) {
        const src = plan.blur.map((id) => byId.get(id)!);
        const texts = await this.rewriter.blur(src.map((r) => r.text));
        const vecs = await this.embedder.embed(texts, 'passage');
        src.forEach((r, i) => {
          this.store.update(r.id, { text: texts[i]!, embedding: vecs[i]!, embedder: this.embedder.name, blur_level: r.blur_level + 1, pending_blur: 0 });
          emit(agent, 'blurred', this.toMemory({ ...r, text: texts[i]! }, now));
        });
      }
    }
    this.store.trimEvents(this.cfg.events.maxKept);
    this.store.enforceCap(this.now());
    return out;
  }

  startTimer(onError: (err: unknown) => void = console.error): void {
    const ms = this.cfg.compaction.intervalMs;
    if (this.timer || ms <= 0) return;
    this.timer = setInterval(() => void this.compact().catch(onError), ms);
    this.timer.unref();
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
