// The agents' faculties: a mind connected to the shared knowledge of the world (read-only
// consultations of the live world; drafts and the hidden catalog stay out of reach, the adapter
// pins that) and a private memory (remember/recall).
// All agents share one identity towards the knowledge, so consultations go through a small cache
// that also coalesces identical concurrent calls.
import { defineTool, type Tool } from 'reinloop';
import type { Translate } from '../i18n.ts';
import type { ConsultTool, KnowledgeConsult } from '../ports/knowledge.ts';
import { type Memory, memoryKey } from '../ports/memory.ts';
import type { BrainConfig } from './config.ts';

export interface ConsultEvent {
  tool: string;
  query: string;
}

/** Per-decision state: how many consultations are left, and who to tell about them. */
export interface ConsultBudget {
  left: number;
  onConsult(ev: ConsultEvent): void;
}

/** Short human summary of a tool call's arguments, for the `consult` event. */
export function querySummary(args: Record<string, unknown>, max = 120): string {
  const pick = args.query ?? args.question ?? args.ref ?? args.records ?? args.kinds ?? args.kind ?? args.since ?? args.from_revision;
  const text = typeof pick === 'string' ? pick : pick === undefined ? '' : JSON.stringify(pick);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class Brain {
  calls = 0;
  cacheHits = 0;
  private readonly cache = new Map<string, { at: number; value: Promise<{ content: string; isError: boolean }> }>();
  private readonly cfg: BrainConfig;
  private readonly t: Translate;
  private readonly memory: Memory;
  private readonly consult: KnowledgeConsult;

  constructor(cfg: BrainConfig, t: Translate, memory: Memory, consult: KnowledgeConsult) {
    this.cfg = cfg;
    this.t = t;
    this.memory = memory;
    this.consult = consult;
  }

  get connected(): boolean {
    return this.consult.connected;
  }

  /** Connects the consultations (an adapter that fails keeps retrying in the background). */
  connect(): Promise<void> {
    return this.consult.connect();
  }

  close(): Promise<void> {
    return this.consult.close();
  }

  /** Forget cached reads (the world's knowledge changed). */
  invalidate(): void {
    this.cache.clear();
  }

  private call(tool: ConsultTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: string; isError: boolean }> {
    const key = `${tool.name}:${JSON.stringify(args)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cfg.cacheMs) {
      this.cacheHits++;
      return hit.value;
    }
    this.calls++;
    const value = tool.call(args, signal).then((r) => ({ ...r, content: r.content.slice(0, this.cfg.outputMaxChars) }));
    this.cache.set(key, { at: Date.now(), value });
    value.then((r) => r.isError && this.cache.delete(key), () => this.cache.delete(key));
    return value;
  }

  /** Consultations of the shared knowledge for one decision, bounded by `budget`. Empty while unavailable. */
  knowledgeTools(budget: ConsultBudget): Tool[] {
    if (!this.consult.connected) return [];
    return this.consult.tools().map((tool) => {
      const custom = this.t(`rt.knowledge.${tool.name}`);
      return defineTool({
        name: tool.name,
        description: custom === `rt.knowledge.${tool.name}` ? (tool.description ?? tool.name) : custom,
        schema: tool.schema,
        risk: 'read',
        run: async (raw, ctx) => {
          if (budget.left <= 0) return { content: this.t('rt.act.noMoreConsults'), isError: true };
          budget.left--;
          const args = { ...((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>) };
          budget.onConsult({ tool: tool.name, query: querySummary(args) });
          try {
            return await this.call(tool, args, ctx.signal);
          } catch (err) {
            return { content: `[unavailable] ${err instanceof Error ? err.message : String(err)}`, isError: true };
          }
        },
      });
    });
  }

  /** The private memory of one person (by name, so it survives restarts): never shared. */
  memoryTools(name: string, at: () => { day: number; minute: number }, ingest: { importance: number; emotion: number }): Tool[] {
    if (!this.memory.enabled) return [];
    const agent = memoryKey(name);
    return [
      defineTool<{ text: string; importance?: number }>({
        name: 'remember',
        description: this.t('rt.tools.remember'),
        schema: { type: 'object', properties: { text: { type: 'string' }, importance: { type: 'number', description: this.t('rt.tools.rememberImportance') } }, required: ['text'] },
        run: async ({ text, importance }) => {
          const imp = Number.isFinite(Number(importance)) ? Math.max(0, Math.min(1, Number(importance))) : ingest.importance;
          const m = await this.memory.remember(agent, String(text ?? ''), { importance: imp, emotion: ingest.emotion, at: at(), source: 'agent' });
          return m ? this.t('rt.act.remembered') : { content: this.t('rt.act.memoryUnavailable'), isError: true };
        },
      }),
      defineTool<{ query: string }>({
        name: 'recall',
        description: this.t('rt.tools.recall'),
        risk: 'read',
        schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        run: async ({ query }) => {
          const hits = await this.memory.recall(agent, String(query ?? ''));
          if (!hits) return { content: this.t('rt.act.memoryUnavailable'), isError: true };
          return hits.length ? hits.map((m) => this.t('rt.act.recallLine', { day: m.createdAt.day, text: m.text, vivid: this.t(m.fidelity >= 0.5 ? 'rt.act.vivid' : 'rt.act.faded') })).join('\n') : this.t('rt.act.recallNone');
        },
      }),
    ];
  }
}
