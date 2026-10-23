// Appends notable events to the `Chronicle` Kind in Lorebase, so the knowledge graph holds the
// civilization's history. Entries are queued and written in batches through an Operation
// (built-in `import_records`: one Revision per batch); 429/5xx back off (Retry-After honoured).
import { randomUUID } from 'node:crypto';
import { type LorebaseClient, LorebaseError } from '../lorebase/client.ts';

export type ChronicleEvent = 'birth' | 'death' | 'arrival' | 'departure' | 'group_formed' | 'group_dissolved' | 'laws_changed' | 'discovery' | 'family_founded' | 'law_proposed' | 'law_breach';

export interface ChronicleEntry {
  event: ChronicleEvent;
  text: string;
  actors: string[];
  day: number;
  minute: number;
}

export interface ChronicleConfig {
  enabled: boolean;
  kind: string;
  operation: string;
  flushMs: number;
  maxBatch: number;
  maxQueue: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

export class Chronicle {
  readonly session: string;
  written = 0;
  failed = 0;
  lastError: string | undefined;
  private readonly client: LorebaseClient;
  private readonly cfg: ChronicleConfig;
  private readonly branch: string;
  private queue: Array<Record<string, unknown>> = [];
  private seq = 0;
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private backoffMs = 0;
  private notBefore = 0;

  constructor(client: LorebaseClient, branch: string, cfg: ChronicleConfig, session = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)) {
    this.client = client;
    this.branch = branch;
    this.cfg = cfg;
    this.session = session;
  }

  start(): void {
    if (!this.cfg.enabled || this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.cfg.flushMs);
  }

  add(e: ChronicleEntry): void {
    if (!this.cfg.enabled) return;
    if (this.queue.length >= this.cfg.maxQueue) this.queue.shift();
    this.seq++;
    this.queue.push({
      code: `${this.session}-${String(e.day).padStart(3, '0')}-${String(e.minute).padStart(4, '0')}-${String(this.seq).padStart(5, '0')}`,
      session: this.session,
      day: e.day,
      minute: Math.floor(e.minute),
      event: e.event,
      text: e.text,
      actors: e.actors.join(', '),
    });
  }

  /** Queues a raw row of the configured Kind (e.g. a Family record). */
  addRow(row: Record<string, unknown>): void {
    if (!this.cfg.enabled) return;
    if (this.queue.length >= this.cfg.maxQueue) this.queue.shift();
    this.queue.push(row);
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Writes queued entries in batches. Safe to call concurrently (calls are serialized). */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.queue.length && Date.now() >= this.notBefore) {
      const batch = this.queue.slice(0, this.cfg.maxBatch);
      try {
        await this.client.execute(this.cfg.operation, { kind: this.cfg.kind, rows: batch }, {
          branch: this.branch, message: `Chronicle: ${batch.length} event(s)`, idempotencyKey: randomUUID(),
        });
        this.queue.splice(0, batch.length);
        this.written += batch.length;
        this.backoffMs = 0;
        this.lastError = undefined;
      } catch (err) {
        this.failed++;
        this.lastError = err instanceof Error ? err.message : String(err);
        const retryAfter = err instanceof LorebaseError ? Number((err.body as Record<string, unknown> | undefined)?.retry_after_s) : NaN;
        this.backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(this.cfg.retryMaxMs, this.backoffMs ? this.backoffMs * 2 : this.cfg.retryBaseMs);
        this.notBefore = Date.now() + this.backoffMs;
        // A 4xx other than 429 will not succeed by retrying: drop the batch.
        if (err instanceof LorebaseError && err.status >= 400 && err.status < 500 && err.status !== 429) {
          console.warn(`[chronicle] dropping ${batch.length} entr(ies): ${this.lastError}`);
          this.queue.splice(0, batch.length);
        } else console.warn(`[chronicle] write failed, retrying in ${this.backoffMs} ms: ${this.lastError}`);
        return;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.notBefore = 0;
    await this.flush().catch(() => undefined);
  }
}
