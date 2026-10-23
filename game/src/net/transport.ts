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
  close(): void;
}
