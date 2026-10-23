// The agents' faculties: a mind connected to Lorebase through Herald (the Lorebase MCP server,
// read tools only) and a private memory (reinloop memory tools, persisted under data/).
// All agents share one Keeper principal, so calls go through a small cache that also
// coalesces identical concurrent calls; the Domain is pinned server-side.
import { resolve } from 'node:path';
import { defineTool, fileNotes, McpClient, type McpToolInfo, type MemoryStore, memoryTools, type Tool } from 'reinloop';
import { ROOT } from '../config.ts';
import type { Translate } from '../i18n.ts';
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

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

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
  private readonly notes: MemoryStore;
  private retry: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(cfg: BrainConfig, t: Translate) {
    this.cfg = cfg;
    this.t = t;
    this.notes = fileNotes(resolve(ROOT, cfg.memoryDir));
  }

  /** Connects to Herald; on failure retries in the background (agents meanwhile have no Lorebase tools). */
  async connect(): Promise<void> {
    if (!this.cfg.mcpUrl || this.stopped) return;
    try {
      // Keeper runs with auth mode `none` locally; Herald still requires a bearer to forward.
      const token = process.env.HERALD_API_KEY || 'local';
      this.client = await McpClient.connect('lorebase', { url: this.cfg.mcpUrl, headers: { Authorization: `Bearer ${token}` }, timeoutMs: this.cfg.callTimeoutMs });
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
        schema: info.inputSchema ?? { type: 'object', properties: {} },
        risk: 'read',
        run: async (raw, ctx) => {
          if (budget.left <= 0) return { content: this.t('rt.act.noMoreConsults'), isError: true };
          budget.left--;
          const args = { ...((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>), domain: this.cfg.domain };
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
  memoryTools(name: string): Tool[] {
    const { remember, recall } = memoryTools({ store: this.notes, scope: 'shared', namespace: `mind.${slug(name)}` });
    return [
      { ...remember, description: this.t('rt.tools.remember') },
      { ...recall, description: this.t('rt.tools.recall') },
    ];
  }
}
