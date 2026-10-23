import type { ClientMsg } from './protocol';
import type { Transport } from './transport';

/** The active transport, shared by the scene and the overlay. */
export const session = {
  transport: null as Transport | null,
  send(msg: ClientMsg): void {
    this.transport?.send(msg);
  },
};
