// Client of mnemo, the private memory service (services/mnemo). Agents never reach it
// directly: their remember/recall tools and the world's own memories of what they lived go
// through here. Failures never stop the world: a memory that cannot be stored is lost.
import type { MemoryConfig } from './config.ts';

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

export interface MemoryEvent {
  seq: number;
  agentId: string;
  action: 'added' | 'blurred' | 'merged' | 'forgotten' | 'recalled';
  memory: Memory;
  mergedFrom?: string[];
}

export interface ConversationLine {
  from: string;
  to: string;
  text: string;
  kind: 'speech' | 'thought' | 'deliberation';
  at: { day: number; minute: number };
  groupId?: string;
}

export interface ConversationRow extends ConversationLine {
  id: string;
}

/** The key of a person's memory: its name, so a memory survives world resets. */
export const memoryKey = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

export class Mnemo {
  private readonly cfg: MemoryConfig;
  private last = 0;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private primed = false;
  connected = false;
  failures = 0;

  constructor(cfg: MemoryConfig) {
    this.cfg = cfg;
  }

  get enabled(): boolean {
    return this.cfg.enabled && !!this.cfg.url;
  }

  /** One request; connection errors (mnemo still starting, restarting) are retried with backoff. */
  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, path, body);
      } catch (err) {
        const connection = err instanceof TypeError; // fetch failed: nothing listening yet
        if (!connection || attempt >= this.cfg.retries) throw err;
        await new Promise((r) => setTimeout(r, this.cfg.retryBaseMs * 2 ** attempt));
      }
    }
  }

  private async once<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.url.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'X-Mnemo-Token': process.env.MNEMO_TOKEN ?? '',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`mnemo ${method} ${path}: ${res.status}`);
    this.connected = true;
    return (await res.json()) as T;
  }

  async add(agent: string, text: string, opts: { importance: number; emotion: number; at: { day: number; minute: number }; source?: string }): Promise<Memory | undefined> {
    if (!this.enabled) return undefined;
    try {
      return await this.req<Memory>('POST', '/memories', { agent, text: text.slice(0, this.cfg.textMaxChars), ns: 'mind', ...opts });
    } catch (err) {
      this.fail(err);
      return undefined;
    }
  }

  async recall(agent: string, query: string, limit = this.cfg.recallLimit): Promise<Array<Memory & { score: number }> | undefined> {
    if (!this.enabled) return undefined;
    try {
      return (await this.req<{ memories: Array<Memory & { score: number }> }>('POST', '/recall', { agent, query, ns: 'mind', limit })).memories;
    } catch (err) {
      this.fail(err);
      return undefined;
    }
  }

  async list(agent: string): Promise<Memory[]> {
    if (!this.enabled) return [];
    return this.req<Memory[]>('GET', `/agents/${encodeURIComponent(agent)}/memories?ns=mind`);
  }

  async health(): Promise<{ memories: number; dbBytes: number; lastCompaction?: unknown; embedder?: unknown }> {
    return this.req('GET', '/health');
  }

  private lines: ConversationLine[] = [];
  private lineTimer: NodeJS.Timeout | undefined;

  /** Queues a line of speech/thought/deliberation; flushed in batches. */
  converse(line: ConversationLine): void {
    if (!this.enabled) return;
    this.lines.push({ ...line, text: line.text.slice(0, this.cfg.textMaxChars) });
    this.lineTimer ??= setTimeout(() => void this.flushLines(), this.cfg.runFlushMs);
  }

  private async flushLines(): Promise<void> {
    this.lineTimer = undefined;
    const lines = this.lines.splice(0);
    if (!lines.length) return;
    await this.req('POST', '/conversations', { lines }).catch((err) => this.fail(err));
  }

  async conversations(q: Record<string, string>): Promise<ConversationRow[]> {
    if (!this.enabled) return [];
    await this.flushLines();
    return this.req<ConversationRow[]>('GET', `/conversations?${new URLSearchParams(q)}`);
  }

  /** Follows mnemo's event log (added, blurred, merged, forgotten, recalled). */
  follow(onEvent: (ev: MemoryEvent) => void): void {
    if (!this.enabled || this.timer) return;
    const poll = async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        const out = await this.req<{ events: MemoryEvent[]; last: number }>('GET', `/events?since=${this.last}`);
        // First contact: start from now, not from the history of earlier worlds.
        const fresh = this.primed;
        this.primed = true;
        this.last = out.last ?? this.last;
        if (fresh) for (const ev of out.events) onEvent(ev);
      } catch (err) {
        this.fail(err);
      } finally {
        this.polling = false;
      }
    };
    void poll();
    this.timer = setInterval(() => void poll(), this.cfg.pollMs);
  }

  stop(): void {
    void this.flushLines();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private fail(err: unknown): void {
    if (this.connected || this.failures === 0) console.warn(`[mnemo] ${err instanceof Error ? err.message : err}`);
    this.connected = false;
    this.failures++;
  }
}
