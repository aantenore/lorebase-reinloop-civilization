// Follows the Lorebase change feed of one branch: SSE (`/branches/{b}/events?kinds=`) with
// `Last-Event-ID` resume, and the polling feed (`/branches/{b}/changes?since=`) as a fallback
// while the stream is down. Every committed Revision touching a watched Kind is reported.
import type { Revision, Watch, WatchHandlers } from '../../../ports/knowledge.ts';
import type { LorebaseClient, RevisionEvent } from './client.ts';

export interface FeedConfig {
  branch: string;
  kinds: string[];
  pollMs: number;
  reconnectMs: number;
  /** Revision the caller already has (empty: none yet). */
  since(): string;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export const revisionOf = (ev: RevisionEvent): Revision => ({ revision: ev.revision, message: ev.message, author: ev.author, at: ev.created_at, kinds: ev.kinds ?? {} });

export class RevisionFeed implements Watch {
  connected = false;
  private readonly client: LorebaseClient;
  private readonly cfg: FeedConfig;
  private readonly handlers: WatchHandlers;
  private readonly abort = new AbortController();
  private lastEventId: string | undefined;

  constructor(client: LorebaseClient, cfg: FeedConfig, handlers: WatchHandlers) {
    this.client = client;
    this.cfg = cfg;
    this.handlers = handlers;
    void this.loop();
  }

  stop(): void {
    this.abort.abort();
  }

  private setConnected(connected: boolean, detail: string): void {
    if (connected !== this.connected) {
      this.connected = connected;
      this.handlers.onStatus(connected, detail);
    }
  }

  private async loop(): Promise<void> {
    const signal = this.abort.signal;
    while (!signal.aborted) {
      try {
        await this.stream(signal);
      } catch (err) {
        if (signal.aborted) break;
        this.setConnected(false, `stream: ${err instanceof Error ? err.message : err}`);
      }
      if (signal.aborted) break;
      // Stream closed or failed: catch up through the polling feed, then reconnect.
      try {
        await this.poll();
      } catch (err) {
        this.setConnected(false, `poll: ${err instanceof Error ? err.message : err}`);
      }
      await sleep(this.connected ? this.cfg.reconnectMs : this.cfg.pollMs, signal);
    }
  }

  private async poll(): Promise<void> {
    const since = this.cfg.since();
    if (!since) return this.handlers.onRevision();
    const page = await this.client.changes(this.cfg.branch, since, this.cfg.kinds);
    const last = page.items.at(-1);
    if (last) this.handlers.onRevision(revisionOf(last));
  }

  private async stream(signal: AbortSignal): Promise<void> {
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;
    const res = await fetch(this.client.eventsUrl(this.cfg.branch, this.cfg.kinds), { headers, signal });
    if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`);
    this.setConnected(true, 'change feed connected');
    // Close the gap between the last read and the moment the stream opened.
    if (!this.lastEventId) await this.poll();
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        this.handleBlock(block);
      }
    }
  }

  private handleBlock(block: string): void {
    let event = 'message';
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    if (id) this.lastEventId = id;
    if (event !== 'revision' || !data.length) return;
    let parsed: RevisionEvent | undefined;
    try {
      parsed = JSON.parse(data.join('\n')) as RevisionEvent;
    } catch {
      return;
    }
    this.handlers.onRevision(revisionOf(parsed));
  }
}
