// Barter with acceptance. An offer `{to, give, want}` waits in the target's inbox until the target
// answers it in its own loop (accept or reject) or it expires (rule offer_minutes, longer for
// people held in esteem: rule trade_trust_esteem). On accept both sides swap atomically: every
// item is checked on both sides first, then moved with economy.barter (catalog-checked transfers).
// An ask (`chiedi`) is an offer with nothing given: on accept the target gives what was asked.
// The ledger holds no IO: callers broadcast and deliver perceptions.
import { type Bag, barter, type Catalog, count, knownItem, transfer } from './economy.ts';
import type { RtEntity } from './world.ts';

export type OfferStatus = 'pending' | 'accepted' | 'rejected' | 'expired';
/** `barter`: give for want; `ask`: want only (a gift on accept). */
export type OfferKind = 'barter' | 'ask';

export interface Offer {
  id: string;
  from: string;
  to: string;
  kind: OfferKind;
  give: Bag;
  want: Bag;
  status: OfferStatus;
  /** Game clock (minutes) when it was made and when it expires. */
  madeAt: number;
  expiresAt: number;
}

export interface OfferLimits {
  maxKinds: number;
  /** Pending offers one person may have made at a time. */
  maxPending: number;
}

/** Why an offer cannot be made, or undefined. Pure. */
export function offerError(c: Catalog, from: RtEntity, to: RtEntity | undefined, give: Bag, want: Bag, limits: OfferLimits, pendingOfFrom: number): string | undefined {
  if (!to || !to.alive || to.id === from.id || to.kind === 'player') return 'no_such_person';
  const kinds = [...Object.keys(give), ...Object.keys(want)];
  if (!Object.keys(give).length || !Object.keys(want).length) return 'empty_offer';
  if (Object.keys(give).length > limits.maxKinds || Object.keys(want).length > limits.maxKinds) return 'too_many_kinds';
  if (kinds.some((k) => !knownItem(c, k))) return 'unknown_item';
  if (Object.entries(give).some(([k, n]) => count(from, k) < n)) return 'nothing_to_give';
  if (pendingOfFrom >= limits.maxPending) return 'too_many_offers';
  return undefined;
}

/** Why an ask cannot be made, or undefined. Pure. */
export function askError(c: Catalog, from: RtEntity, to: RtEntity | undefined, want: Bag, limits: OfferLimits, pendingOfFrom: number): string | undefined {
  if (!to || !to.alive || to.id === from.id || to.kind === 'player') return 'no_such_person';
  if (!Object.keys(want).length) return 'empty_ask';
  if (Object.keys(want).length > limits.maxKinds) return 'too_many_kinds';
  if (Object.keys(want).some((k) => !knownItem(c, k))) return 'unknown_item';
  if (pendingOfFrom >= limits.maxPending) return 'too_many_offers';
  return undefined;
}

/** Gives what an ask wants from `giver` to `asker`, all or nothing. Returns an error code or undefined. */
export function giveAsked(c: Catalog, want: Bag, giver: RtEntity, asker: RtEntity): string | undefined {
  if (Object.entries(want).some(([k, n]) => count(giver, k) < n)) return 'nothing_to_give';
  for (const [k, n] of Object.entries(want)) transfer(c, giver, asker, k, n);
  return undefined;
}

/** Whether both sides still hold what they promised. Pure. */
export function swapError(o: Pick<Offer, 'give' | 'want'>, from: RtEntity, to: RtEntity): string | undefined {
  if (Object.entries(o.give).some(([k, n]) => count(from, k) < n)) return 'offerer_lacks';
  if (Object.entries(o.want).some(([k, n]) => count(to, k) < n)) return 'missing_inputs';
  return undefined;
}

/** Swaps `give` (from → to) and `want` (to → from) all or nothing. Returns an error code or undefined. */
export function swap(c: Catalog, o: Pick<Offer, 'give' | 'want'>, from: RtEntity, to: RtEntity): string | undefined {
  return swapError(o, from, to) ?? (barter(c, from, to, o.give, o.want) ? undefined : 'unknown_item');
}

/** How long an offer stays open: offer_minutes × (1 + trust × (2·esteem − 1)), at least a quarter of it. */
export function offerMinutes(base: number, trust: number, esteem: number): number {
  return Math.max(base / 4, base * (1 + trust * (2 * esteem - 1)));
}

export class OfferBook {
  private readonly offers = new Map<string, Offer>();
  private seq = 0;

  get(id: string): Offer | undefined {
    return this.offers.get(id);
  }

  add(o: Omit<Offer, 'id' | 'status'>): Offer {
    const offer: Offer = { ...o, id: `o${++this.seq}`, status: 'pending' };
    this.offers.set(offer.id, offer);
    return offer;
  }

  pendingFrom(id: string): Offer[] {
    return [...this.offers.values()].filter((o) => o.status === 'pending' && o.from === id);
  }

  pendingFor(id: string): Offer[] {
    return [...this.offers.values()].filter((o) => o.status === 'pending' && o.to === id);
  }

  /** Closes an offer (it leaves the book). */
  close(o: Offer, status: Exclude<OfferStatus, 'pending'>): Offer {
    o.status = status;
    this.offers.delete(o.id);
    return o;
  }

  /** Pending offers past their time, or whose people are gone. */
  stale(clock: number, alive: (id: string) => boolean): Offer[] {
    return [...this.offers.values()].filter((o) => o.status === 'pending' && (clock >= o.expiresAt || !alive(o.from) || !alive(o.to)));
  }

  clear(): void {
    this.offers.clear();
  }
}
