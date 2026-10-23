// The agents' faculties: a mind connected to Lorebase through Herald (the Lorebase MCP server,
// read tools only, pinned to the Domain and to the live branch, so the hidden economy branch
// stays out of reach) and a private memory kept by mnemo (remember/recall).
// All agents share one Keeper principal, so calls go through a small cache that also
// coalesces identical concurrent calls; the Domain is pinned server-side.
import { defineTool, McpClient, type McpToolInfo, type Tool } from 'reinloop';
import type { Translate } from '../i18n.ts';
import type { BrainConfig } from './config.ts';
import { memoryKey, type Mnemo } from './mnemo.ts';

export interface ConsultEvent {
  tool: string;
  query: string;
}

/** Per-decision state: how many consultations are left, and who to tell about them. */
export interface ConsultBudget {
  left: number;
  onConsult(ev: ConsultEvent): void;
}

/** A tool schema without the arguments that would leave the pinned branch. */
export function pinnedSchema(schema: Record<string, unknown>, drop: string[]): Record<string, unknown> {
  const props = { ...((schema.properties as Record<string, unknown> | undefined) ?? {}) };
  for (const k of drop) delete props[k];
  const required = Array.isArray(schema.required) ? (schema.required as string[]).filter((k) => !drop.includes(k)) : undefined;
  return { ...schema, properties: props, ...(required ? { required } : {}) };
}

/** Short human summary of a tool call's arguments, for the `consult` event. */
export function querySummary(args: Record<string, unknown>, max = 120): string {
  const pick = args.query ?? args.question ?? args.ref ?? args.records ?? args.kinds ?? args.since ?? args.from_revision;
  const text = typeof pick === 'string' ? pick : pick === undefined ? '' : JSON.stringify(pick);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class Brain {
  connected = false;
  calls = 0;
  cacheHits = 0;
  private client: McpClient | undefined;
  private infos: McpToolInfo[] = [];
  private readonly cache = new Map<string, { at: number; value: Promise<{ content: string; isError: boolean }> }>();
  private readonly cfg: BrainConfig;
  private readonly t: Translate;
  private readonly mnemo: Mnemo;
  private readonly branch: string;
  private retry: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(cfg: BrainConfig, t: Translate, mnemo: Mnemo, branch: string) {
    this.cfg = cfg;
    this.t = t;
    this.mnemo = mnemo;
    this.branch = branch;
  }

  /** Connects to Herald; on failure retries in the background (agents meanwhile have no Lorebase tools). */
  async connect(): Promise<void> {
    if (!this.cfg.mcpUrl || this.stopped) return;
    try {
      // A Lorebase API key when Keeper needs one; locally Herald forwards credential-less calls (HERALD_ALLOW_ANONYMOUS).
      const token = process.env.HERALD_API_KEY;
      this.client = await McpClient.connect('lorebase', { url: this.cfg.mcpUrl, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}), timeoutMs: this.cfg.callTimeoutMs });
      const all = await this.client.listTools();
      // Read tools only, whatever the server offers.
      this.infos = all.filter((i) => this.cfg.tools.includes(i.name) && i.annotations?.readOnlyHint !== false);
      this.connected = true;
      console.log(`[brain] Lorebase MCP connected (${this.cfg.mcpUrl}): ${this.infos.map((i) => i.name).join(', ')}`);
    } catch (err) {
      this.connected = false;
      console.warn(`[brain] Lorebase MCP unavailable at ${this.cfg.mcpUrl} (${err instanceof Error ? err.message : err}); retrying in ${this.cfg.connectRetryMs} ms`);
      this.retry = setTimeout(() => void this.connect(), this.cfg.connectRetryMs);
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    await this.client?.close().catch(() => undefined);
  }

  /** Forget cached reads (the world's knowledge changed). */
  invalidate(): void {
    this.cache.clear();
  }

  private call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: string; isError: boolean }> {
    const key = `${name}:${JSON.stringify(args)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cfg.cacheMs) {
      this.cacheHits++;
      return hit.value;
    }
    this.calls++;
    const value = this.client!.callTool(name, args, signal).then((r) => ({ ...r, content: r.content.slice(0, this.cfg.outputMaxChars) }));
    this.cache.set(key, { at: Date.now(), value });
    value.then((r) => r.isError && this.cache.delete(key), () => this.cache.delete(key));
    return value;
  }

  /** Lorebase read tools for one decision, bounded by `budget`. Empty when Herald is not connected. */
  lorebaseTools(budget: ConsultBudget): Tool[] {
    if (!this.connected || !this.client) return [];
    return this.infos.map((info) => {
      const custom = this.t(`rt.mcp.${info.name}`);
      return defineTool({
        name: info.name,
        description: custom === `rt.mcp.${info.name}` ? (info.description ?? info.name) : custom,
        schema: pinnedSchema((info.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>, this.cfg.branchArgs),
        risk: 'read',
        run: async (raw, ctx) => {
          if (budget.left <= 0) return { content: this.t('rt.act.noMoreConsults'), isError: true };
          budget.left--;
          const args: Record<string, unknown> = { ...((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>), domain: this.cfg.domain };
          // Only the live branch: the hidden economy (undiscovered technologies) lives elsewhere.
          for (const k of this.cfg.branchArgs) delete args[k];
          if (info.inputSchema && 'branch' in ((info.inputSchema as { properties?: object }).properties ?? {})) args.branch = this.branch;
          budget.onConsult({ tool: info.name, query: querySummary(args) });
          try {
            return await this.call(info.name, args, ctx.signal);
          } catch (err) {
            return { content: `[unavailable] ${err instanceof Error ? err.message : String(err)}`, isError: true };
          }
        },
      });
    });
  }

  /** The private memory of one person (by name, so it survives restarts): never shared, never in Lorebase. */
  memoryTools(name: string, at: () => { day: number; minute: number }, ingest: { importance: number; emotion: number }): Tool[] {
    if (!this.mnemo.enabled) return [];
    const agent = memoryKey(name);
    return [
      defineTool<{ text: string; importance?: number }>({
        name: 'remember',
        description: this.t('rt.tools.remember'),
        schema: { type: 'object', properties: { text: { type: 'string' }, importance: { type: 'number', description: this.t('rt.tools.rememberImportance') } }, required: ['text'] },
        run: async ({ text, importance }) => {
          const imp = Number.isFinite(Number(importance)) ? Math.max(0, Math.min(1, Number(importance))) : ingest.importance;
          const m = await this.mnemo.add(agent, String(text ?? ''), { importance: imp, emotion: ingest.emotion, at: at(), source: 'agent' });
          return m ? this.t('rt.act.remembered') : { content: this.t('rt.act.memoryUnavailable'), isError: true };
        },
      }),
      defineTool<{ query: string }>({
        name: 'recall',
        description: this.t('rt.tools.recall'),
        risk: 'read',
        schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        run: async ({ query }) => {
          const hits = await this.mnemo.recall(agent, String(query ?? ''));
          if (!hits) return { content: this.t('rt.act.memoryUnavailable'), isError: true };
          return hits.length ? hits.map((m) => this.t('rt.act.recallLine', { day: m.createdAt.day, text: m.text, vivid: this.t(m.fidelity >= 0.5 ? 'rt.act.vivid' : 'rt.act.faded') })).join('\n') : this.t('rt.act.recallNone');
        },
      }),
    ];
  }
}
