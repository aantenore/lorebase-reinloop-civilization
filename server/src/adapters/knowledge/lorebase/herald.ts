// The consultations of the live world through Herald, the Lorebase MCP server: read tools only,
// renamed to the neutral consultation names, pinned to the Domain and to the live branch (the
// hidden catalog and the drafts live on other branches, out of reach). On failure the
// connection is retried in the background; meanwhile no consultation is offered.
import { McpClient, type McpToolInfo } from 'reinloop';
import { CONSULT_NAMES, type ConsultName, type ConsultTool, type KnowledgeConsult } from '../../../ports/knowledge.ts';

export interface HeraldConfig {
  /** MCP endpoint; HERALD_URL overrides; empty disables the consultations. */
  url: string;
  /** Neutral consultation name -> Herald tool name. */
  tools: Partial<Record<ConsultName, string>>;
  callTimeoutMs: number;
  connectRetryMs: number;
  /** Tool arguments that would leave the pinned branch; removed from schemas and forced server-side. */
  branchArgs: string[];
}

/** A tool schema without the arguments that would leave the pinned branch, nor backend names in descriptions. */
export function pinnedSchema(schema: Record<string, unknown>, drop: string[]): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((schema.properties as Record<string, unknown> | undefined) ?? {})) {
    if (drop.includes(k)) continue;
    props[k] = scrub(v);
  }
  const required = Array.isArray(schema.required) ? (schema.required as string[]).filter((k) => !drop.includes(k)) : undefined;
  const { description: _description, ...rest } = schema;
  return { ...rest, properties: props, ...(required ? { required } : {}) };
}

const VENDOR = /lorebase|herald|keeper/i;

/** Drops descriptions naming the backend (recursively), so the people of the world never read them. */
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === 'description' && typeof x === 'string' && VENDOR.test(x)) continue;
    out[k] = scrub(x);
  }
  return out;
}

export class HeraldConsult implements KnowledgeConsult {
  connected = false;
  private client: McpClient | undefined;
  private infos: Array<{ name: ConsultName; info: McpToolInfo }> = [];
  private retry: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly cfg: HeraldConfig;
  private readonly domain: string;
  private readonly branch: string;

  constructor(cfg: HeraldConfig, domain: string, branch: string) {
    this.cfg = cfg;
    this.domain = domain;
    this.branch = branch;
  }

  async connect(): Promise<void> {
    if (!this.cfg.url || this.stopped) return;
    try {
      // A Lorebase API key when Keeper needs one; locally Herald forwards credential-less calls (HERALD_ALLOW_ANONYMOUS).
      const token = process.env.HERALD_API_KEY;
      this.client = await McpClient.connect('knowledge', { url: this.cfg.url, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}), timeoutMs: this.cfg.callTimeoutMs });
      const all = new Map((await this.client.listTools()).map((i) => [i.name, i]));
      this.infos = [];
      for (const name of CONSULT_NAMES) {
        const info = all.get(this.cfg.tools[name] ?? '');
        // Read tools only, whatever the server offers.
        if (info && info.annotations?.readOnlyHint !== false) this.infos.push({ name, info });
      }
      this.connected = true;
      console.log(`[knowledge] consultations connected (${this.cfg.url}): ${this.infos.map((i) => `${i.name}=${i.info.name}`).join(', ')}`);
    } catch (err) {
      this.connected = false;
      console.warn(`[knowledge] consultations unavailable at ${this.cfg.url} (${err instanceof Error ? err.message : err}); retrying in ${this.cfg.connectRetryMs} ms`);
      this.retry = setTimeout(() => void this.connect(), this.cfg.connectRetryMs);
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    await this.client?.close().catch(() => undefined);
  }

  tools(): ConsultTool[] {
    const client = this.client;
    if (!this.connected || !client) return [];
    return this.infos.map(({ name, info }) => {
      const props = ((info.inputSchema as { properties?: object } | undefined)?.properties ?? {}) as Record<string, unknown>;
      return {
        name,
        description: info.description && !VENDOR.test(info.description) ? info.description : undefined,
        schema: pinnedSchema((info.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>, this.cfg.branchArgs),
        call: (raw, signal) => {
          const args: Record<string, unknown> = { ...raw, domain: this.domain };
          // Only the live branch: the hidden catalog (undiscovered technologies) and the drafts live elsewhere.
          for (const k of this.cfg.branchArgs) delete args[k];
          if ('branch' in props) args.branch = this.branch;
          return client.callTool(info.name, args, signal);
        },
      };
    });
  }
}
