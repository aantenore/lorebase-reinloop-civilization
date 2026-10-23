// Follows the Lorebase change feed of the rules branch: SSE (`/branches/{b}/events?kinds=Rule`)
// with `Last-Event-ID` resume, and the polling feed (`/branches/{b}/changes?since=`) as a
// fallback while the stream is down. Every committed Revision touching Rule or Role triggers a
// reload of those Records and a diff against the previous snapshot.
import type { LorebaseClient, RevisionEvent } from './client.ts';
import { diffRoles, diffRules, type LawKinds, loadRules, type RoleChange, type RuleChange, type RuleSnapshot } from './rules.ts';

export interface WatcherConfig extends LawKinds {
  branch: string;
  pollMs: number;
  reconnectMs: number;
}

export interface WatcherHandlers {
  onChange(snapshot: RuleSnapshot, changes: RuleChange[], roleChanges: RoleChange[], event?: RevisionEvent): void;
  onStatus(connected: boolean, detail: string): void;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export class RuleWatcher {
  current: RuleSnapshot = { revision: '', rules: [], roles: [] };
  connected = false;
  private readonly client: LorebaseClient;
  private readonly cfg: WatcherConfig;
  private readonly handlers: WatcherHandlers;
  private abort = new AbortController();
  private lastEventId: string | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(client: LorebaseClient, cfg: WatcherConfig, handlers: WatcherHandlers) {
    this.client = client;
    this.cfg = cfg;
    this.handlers = handlers;
  }

  /** Loads the first snapshot (throws when Lorebase is unreachable) and starts following the feed. */
  async start(): Promise<RuleSnapshot> {
    this.current = await loadRules(this.client, this.cfg, this.cfg.branch);
    void this.loop();
    return this.current;
  }

  private get kinds(): string[] {
    return [this.cfg.ruleKind, this.cfg.roleKind];
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

  /** Reloads the rules and reports what changed; serialized so events never interleave. */
  private refresh(event?: RevisionEvent): Promise<void> {
    this.queue = this.queue.then(async () => {
      const next = await loadRules(this.client, this.cfg, this.cfg.branch);
      const changes = diffRules(this.current.rules, next.rules);
      const roleChanges = diffRoles(this.current.roles, next.roles);
      const moved = next.revision !== this.current.revision;
      this.current = next;
      if (changes.length || roleChanges.length || (event && moved)) this.handlers.onChange(next, changes, roleChanges, event);
    }).catch((err) => this.setConnected(false, `reload failed: ${err instanceof Error ? err.message : err}`));
    return this.queue;
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
    if (!this.current.revision) return this.refresh();
    const page = await this.client.changes(this.cfg.branch, this.current.revision, this.kinds);
    if (page.items.length) await this.refresh(page.items.at(-1));
  }

  private async stream(signal: AbortSignal): Promise<void> {
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;
    const res = await fetch(this.client.eventsUrl(this.cfg.branch, this.kinds), { headers, signal });
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
    void this.refresh(parsed);
  }
}
