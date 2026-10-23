import type { ClientMsg, RuleEditRequest, ServerMsg } from './protocol';

export type ConnStatus = 'connecting' | 'online' | 'offline' | 'mock';

/** Anything that speaks the protocol: the real socket or the in-browser mock world. */
export interface Transport {
  readonly kind: 'ws' | 'mock';
  send(msg: ClientMsg): void;
  onMessage(cb: (msg: ServerMsg) => void): void;
  onStatus(cb: (s: ConnStatus) => void): void;
  /** HTTP rule edit. Resolves with an error string or null. */
  postRule(req: RuleEditRequest): Promise<string | null>;
  /** GET a REST resource under the API base (`/economy`, `/agents/:id/memories`...). Rejects on HTTP errors. */
  getJson<T = unknown>(path: string): Promise<T>;
  /** JSON request (POST/PATCH/DELETE) under the API base. Rejects with the server message on errors. */
  request<T = unknown>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T>;
  close(): void;
}
