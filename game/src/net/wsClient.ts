import { config } from '../config';
import type { ClientMsg, RuleEditRequest, ServerMsg } from './protocol';
import { authHeaders, getJson, requestJson, withToken } from './http';
import type { ConnStatus, Transport } from './transport';

/** Reconnecting WebSocket transport. Re-sends the last `join` after a reconnect. */
export class WsTransport implements Transport {
  readonly kind = 'ws' as const;
  private ws: WebSocket | null = null;
  private msgCbs: ((m: ServerMsg) => void)[] = [];
  private statusCbs: ((s: ConnStatus) => void)[] = [];
  private queue: ClientMsg[] = [];
  private lastJoin: ClientMsg | null = null;
  private retry = 0;
  private closed = false;
  everOpened = false;

  constructor(private url = withToken(config.wsUrl)) {
    this.connect();
  }

  private connect(): void {
    this.emitStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.everOpened = true;
      this.retry = 0;
      this.emitStatus('online');
      if (this.lastJoin) ws.send(JSON.stringify(this.lastJoin));
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      for (const cb of this.msgCbs) cb(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.closed) return;
      this.emitStatus('offline');
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      setTimeout(() => !this.closed && this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private emitStatus(s: ConnStatus) {
    for (const cb of this.statusCbs) cb(s);
  }

  send(msg: ClientMsg): void {
    if (msg.type === 'join') {
      if (config.apiToken && !msg.token) msg = { ...msg, token: config.apiToken };
      this.lastJoin = msg;
    }
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else if (msg.type !== 'input' && msg.type !== 'join') this.queue.push(msg);
  }

  onMessage(cb: (msg: ServerMsg) => void): void {
    this.msgCbs.push(cb);
  }

  onStatus(cb: (s: ConnStatus) => void): void {
    this.statusCbs.push(cb);
  }

  async postRule(req: RuleEditRequest): Promise<string | null> {
    try {
      const res = await fetch(`${config.apiBase}/rules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(req),
      });
      if (!res.ok) return `${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`;
      return null;
    } catch (e) {
      return String(e);
    }
  }

  getJson<T = unknown>(path: string): Promise<T> {
    return getJson<T>(path);
  }

  request<T = unknown>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return requestJson<T>(method, path, body);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}

/** Resolves true if the socket opened within the timeout. */
export function waitForOpen(t: WsTransport, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (t.everOpened) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    t.onStatus((s) => {
      if (s === 'online') {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}
