// Reputation, fame, ranks and families. Nothing here decides for anyone: opinions come from the
// agents' own `giudica` tool, deeds from what happens in the world. Every weight is a Lorebase
// rule read through `r(key)`; the society only aggregates.
//   esteem  decayed weighted mean of the latest opinion of each judge (score -1..1 mapped to 0..1),
//           plus a prior worth `esteem_prior_weight` opinions; a judge weighs more with its own
//           esteem (`esteem_judge_weight`) and as an elder (`elder_esteem_weight`); opinions halve
//           every `opinion_half_life_days`.
//   fame    deeds (gifts, recipe supplies, accepted insights, discoveries, enacted laws, social laws
//           seen kept or broken by witnesses) weighted by `fame_*` rules (a breach weighs negative),
//           halving every `fame_half_life_days`; never below 0.
//   rank    1 = highest esteem (fame breaks ties) among the living people.
// People never see these numbers: perception carries hearsay phrases from i18n (bands only).
import type { RtRuleKey } from './world.ts';
import type { AgeStage, EntityTier, EntityKind } from './world.ts';

export type DeedKind = 'gift' | 'recipe_supply' | 'insight_accepted' | 'discovery' | 'law_enacted' | 'law_respected' | 'law_breached';

const DEED_RULE: Record<DeedKind, RtRuleKey> = {
  gift: 'fame_gift', recipe_supply: 'fame_recipe_supply', insight_accepted: 'fame_insight_accepted', discovery: 'fame_discovery', law_enacted: 'fame_law_enacted',
  law_respected: 'fame_law_respected', law_breached: 'fame_law_breached',
};

export interface Opinion {
  from: string;
  to: string;
  /** -1..1 */
  score: number;
  reason: string;
  /** Game clock (minutes). */
  at: number;
}

export interface Person {
  id: string;
  name: string;
  role: string;
  tier: EntityTier;
  kind: EntityKind;
  bornAt: number;
  parents: [string, string] | null;
  family: string | null;
  alive: boolean;
  /** Esteem before anyone judged (rule esteem_prior, or inherited at birth). */
  prior: number;
  /** Clock at death (age stops). */
  diedAt?: number;
}

export interface Family {
  id: string;
  name: string;
  founder: string;
  members: string[];
  foundedDay: number;
  /** From the configured palette, by founding order (absent with no palette). */
  color?: string;
}

export interface Hearsay {
  about: string;
  from: string;
  text: string;
  at: number;
}

type R = (key: RtRuleKey) => number;
const DAY = 1440;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const halve = (minutes: number, halfLifeDays: number) => (halfLifeDays > 0 ? 0.5 ** (minutes / DAY / halfLifeDays) : 1);

/** Weight of a judge or voter from its esteem: max(0, 1 + k·(2e − 1)). Pure. */
export function esteemWeight(esteem: number, k: number): number {
  return Math.max(0, 1 + k * (2 * esteem - 1));
}

/**
 * Esteem of every person from the latest opinion of each judge about them. `prev` holds the
 * judges' esteem from the previous round (so the computation is not recursive). Pure.
 */
export function computeEsteem(people: Iterable<Pick<Person, 'id' | 'prior'>>, opinions: Opinion[], r: R, clock: number, prev: ReadonlyMap<string, number>, stageOf: (id: string) => AgeStage | undefined): Map<string, number> {
  const latest = new Map<string, Opinion>();
  for (const o of opinions) {
    const k = `${o.from}>${o.to}`;
    const have = latest.get(k);
    if (!have || have.at <= o.at) latest.set(k, o);
  }
  const byTarget = new Map<string, Opinion[]>();
  for (const o of latest.values()) (byTarget.get(o.to) ?? byTarget.set(o.to, []).get(o.to)!).push(o);
  const priorW = Math.max(0, r('esteem_prior_weight'));
  const out = new Map<string, number>();
  for (const p of people) {
    let num = p.prior * priorW;
    let den = priorW;
    for (const o of byTarget.get(p.id) ?? []) {
      const judge = esteemWeight(prev.get(o.from) ?? r('esteem_prior'), r('esteem_judge_weight')) * (stageOf(o.from) === 'elder' ? r('elder_esteem_weight') : 1);
      const w = judge * halve(clock - o.at, r('opinion_half_life_days'));
      num += w * clamp01((o.score + 1) / 2);
      den += w;
    }
    out.set(p.id, round3(den > 0 ? clamp01(num / den) : p.prior));
  }
  return out;
}

/** Ranks (1 = top) by esteem, then fame, then name. Pure. */
export function rankPeople(ids: Array<{ id: string; name: string }>, esteem: ReadonlyMap<string, number>, fame: ReadonlyMap<string, number>): Map<string, number> {
  const sorted = [...ids].sort((a, b) => (esteem.get(b.id) ?? 0) - (esteem.get(a.id) ?? 0) || (fame.get(b.id) ?? 0) - (fame.get(a.id) ?? 0) || a.name.localeCompare(b.name));
  return new Map(sorted.map((p, i) => [p.id, i + 1]));
}

/** Weighted plurality: the index of the proposal with most weight (ties: lowest index). Pure. */
export function weightedWinner(votes: Array<number | null | undefined>, weights: number[], proposals: number): { winner: number; weights: number[] } {
  const sums = Array.from({ length: Math.max(0, proposals) }, () => 0);
  votes.forEach((v, i) => {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < proposals) sums[v]! += weights[i] ?? 1;
  });
  let winner = proposals > 0 ? 0 : -1;
  sums.forEach((s, i) => {
    if (s > sums[winner]!) winner = i;
  });
  return { winner, weights: sums };
}

/** Society state kept across restarts (names, not ids; `clock` is the game clock when saved). */
export interface SocietySnapshot {
  clock: number;
  people: Array<{ name: string; prior: number; esteem: number; fame: number; fameAt: number; skills: Record<string, number> }>;
  opinions: Array<{ from: string; to: string; score: number; reason: string; at: number }>;
  /** Families of the people above, members and founder by name (absent in snapshots of older versions). */
  families?: Array<{ id: string; name: string; founder: string; members: string[]; foundedDay: number; color?: string }>;
}

/** One witness's account: `who` kept (or broke) the social law `law`. */
export interface Testimony {
  witness: string;
  who: string;
  law: string;
  kept: boolean;
  reason: string;
  at: number;
}

/**
 * Accounts of social laws kept or broken. One account per witness, person and law within
 * `windowMinutes`; a breach becomes public (once per window) when `minWitnesses` distinct
 * witnesses told it.
 */
export class Testimonies {
  private list: Testimony[] = [];
  private readonly told = new Map<string, number>();
  private readonly opts: { windowMinutes: number; minWitnesses: number; maxKept: number };
  constructor(opts: { windowMinutes: number; minWitnesses: number; maxKept: number }) {
    this.opts = opts;
  }

  /** 'duplicate' when this witness already told about this person and law recently. */
  add(t: Testimony): { error: 'duplicate' } | { breachWitnesses: string[] | null } {
    const since = t.at - this.opts.windowMinutes;
    this.list = this.list.filter((x) => x.at >= since).slice(-this.opts.maxKept);
    if (this.list.some((x) => x.witness === t.witness && x.who === t.who && x.law === t.law)) return { error: 'duplicate' };
    this.list.push(t);
    if (t.kept) return { breachWitnesses: null };
    const witnesses = [...new Set(this.list.filter((x) => !x.kept && x.who === t.who && x.law === t.law).map((x) => x.witness))];
    const key = `${t.who}>${t.law}`;
    const last = this.told.get(key);
    if (witnesses.length < this.opts.minWitnesses || (last !== undefined && t.at - last < this.opts.windowMinutes)) return { breachWitnesses: null };
    this.told.set(key, t.at);
    return { breachWitnesses: witnesses };
  }

  clear(): void {
    this.list = [];
    this.told.clear();
  }
}

export class Society {
  readonly people = new Map<string, Person>();
  readonly families = new Map<string, Family>();
  opinions: Opinion[] = [];
  esteem = new Map<string, number>();
  ranks = new Map<string, number>();
  private readonly fameAcc = new Map<string, { value: number; at: number }>();
  private readonly heard = new Map<string, Hearsay[]>();
  private familySeq = 0;
  private readonly r: R;
  private readonly maxOpinions: number;
  private readonly hearsayKept: number;
  private readonly familyColors: string[];
  /** Life stage of a living person (from the world). */
  stageOf: (id: string) => AgeStage | undefined = () => undefined;

  constructor(r: R, opts: { maxOpinions: number; hearsayKept: number; familyColors?: string[] }) {
    this.r = r;
    this.maxOpinions = opts.maxOpinions;
    this.hearsayKept = opts.hearsayKept;
    this.familyColors = opts.familyColors ?? [];
  }

  /** A person enters the society (founder: prior esteem_prior; newborn: inherited). */
  add(p: Omit<Person, 'prior' | 'alive' | 'family'> & { family?: string | null }): Person {
    let prior = this.r('esteem_prior');
    if (p.parents) {
      const [a, b] = p.parents.map((id) => this.esteemOf(id));
      prior = clamp01(this.r('reputation_inheritance') * ((a! + b!) / 2));
    }
    const person: Person = { ...p, family: p.family ?? null, alive: true, prior };
    this.people.set(p.id, person);
    this.esteem.set(p.id, round3(prior));
    return person;
  }

  died(id: string, clock: number): void {
    const p = this.people.get(id);
    if (!p) return;
    p.alive = false;
    p.diedAt = clock;
    this.heard.delete(id);
  }

  esteemOf(id: string): number {
    return this.esteem.get(id) ?? this.people.get(id)?.prior ?? this.r('esteem_prior');
  }

  /** Fame now (decayed). */
  fameOf(id: string, clock: number): number {
    const f = this.fameAcc.get(id);
    return f ? round3(f.value * halve(clock - f.at, this.r('fame_half_life_days'))) : 0;
  }

  deed(id: string, kind: DeedKind, clock: number): void {
    if (!this.people.has(id)) return;
    const value = Math.max(0, this.fameOf(id, clock) + this.r(DEED_RULE[kind]));
    this.fameAcc.set(id, { value, at: clock });
  }

  /** What survives a restart of the world, by person name (see SocietySnapshot). */
  snapshot(clock: number, skillsOf: (id: string) => Record<string, number>): SocietySnapshot {
    const name = (id: string) => this.people.get(id)?.name;
    const people = [...this.people.values()].filter((p) => p.alive && p.kind !== 'player').map((p) => {
      const f = this.fameAcc.get(p.id);
      return { name: p.name, prior: p.prior, esteem: this.esteemOf(p.id), fame: f?.value ?? 0, fameAt: f?.at ?? clock, skills: { ...skillsOf(p.id) } };
    });
    const opinions = this.opinions.flatMap((o) => {
      const from = name(o.from);
      const to = name(o.to);
      return from && to ? [{ from, to, score: o.score, reason: o.reason, at: o.at }] : [];
    });
    const families = [...this.families.values()].flatMap((f) => {
      const members = f.members.flatMap((id) => {
        const p = this.people.get(id);
        return p?.alive && p.kind !== 'player' ? [p.name] : [];
      });
      return members.length ? [{ id: f.id, name: f.name, founder: name(f.founder) ?? f.founder, members, foundedDay: f.foundedDay, ...(f.color ? { color: f.color } : {}) }] : [];
    });
    return { clock, people, opinions, families };
  }

  /**
   * Brings back a saved society into the people present now (matched by name). Clocks are shifted
   * so that ages of opinions and fame are kept across restarts (the game clock restarts at dawn).
   * Opinions whose judge or subject is not here stay in the store but are not loaded; families come
   * back with the members present.
   * Returns the skills to give back to each person id. Pure apart from this society's state.
   */
  restore(saved: SocietySnapshot, clock: number): Map<string, Record<string, number>> {
    const shift = clock - saved.clock;
    const byName = new Map([...this.people.values()].filter((p) => p.alive).map((p) => [p.name, p]));
    const skills = new Map<string, Record<string, number>>();
    for (const sp of saved.people) {
      const p = byName.get(sp.name);
      if (!p) continue;
      p.prior = clamp01(sp.prior);
      this.esteem.set(p.id, round3(clamp01(sp.esteem)));
      if (sp.fame > 0) this.fameAcc.set(p.id, { value: sp.fame, at: Math.min(clock, sp.fameAt + shift) });
      skills.set(p.id, { ...sp.skills });
    }
    for (const o of saved.opinions) {
      const from = byName.get(o.from);
      const to = byName.get(o.to);
      if (from && to) this.opinion({ from: from.id, to: to.id, score: o.score, reason: o.reason, at: Math.min(clock, o.at + shift) });
    }
    for (const sf of saved.families ?? []) {
      const present = sf.members.flatMap((n) => {
        const p = byName.get(n);
        return p && !p.family ? [p] : [];
      });
      if (!present.length || this.families.has(sf.id)) continue;
      const family: Family = { id: sf.id, name: sf.name, founder: byName.get(sf.founder)?.id ?? sf.founder, members: [], foundedDay: sf.foundedDay, ...(sf.color ? { color: sf.color } : {}) };
      this.families.set(family.id, family);
      for (const p of present) this.join(family, p.id);
      this.familySeq++; // keeps the palette order of families founded later
    }
    return skills;
  }

  opinion(o: Opinion): void {
    this.opinions.push(o);
    if (this.opinions.length > this.maxOpinions) this.opinions.splice(0, this.opinions.length - this.maxOpinions);
  }

  /** People who heard a judgement remember what was said (not the score). */
  hear(hearers: string[], h: Hearsay): void {
    for (const id of hearers) {
      if (id === h.about) continue;
      const list = this.heard.get(id) ?? [];
      list.push(h);
      if (list.length > this.hearsayKept) list.splice(0, list.length - this.hearsayKept);
      this.heard.set(id, list);
    }
  }

  hearsayOf(hearer: string, about?: string): Hearsay[] {
    const list = this.heard.get(hearer) ?? [];
    return about ? list.filter((h) => h.about === about) : list;
  }

  /** Recomputes esteem (from last round's) and ranks of the living. */
  recompute(clock: number): void {
    const next = computeEsteem(this.people.values(), this.opinions, this.r, clock, this.esteem, this.stageOf);
    this.esteem = next;
    const living = [...this.people.values()].filter((p) => p.alive && p.kind !== 'player');
    const fame = new Map(living.map((p) => [p.id, this.fameOf(p.id, clock)]));
    this.ranks = rankPeople(living, this.esteem, fame);
  }

  /** Weight of a vote or a leadership claim (rule esteem_vote_weight). */
  voteWeight(id: string): number {
    return esteemWeight(this.esteemOf(id), this.r('esteem_vote_weight'));
  }

  /**
   * The family of a newborn: the family of the more esteemed parent that has one; when neither
   * has one, a new family is founded by the more esteemed parent and both parents join it.
   */
  familyForBirth(childId: string, a: string, b: string, day: number, name: (founderName: string) => string, session: string): { family: Family; founded: boolean } {
    const pa = this.people.get(a);
    const pb = this.people.get(b);
    const ordered = [pa, pb].filter((p): p is Person => !!p).sort((x, y) => this.esteemOf(y.id) - this.esteemOf(x.id));
    const withFamily = ordered.find((p) => p.family && this.families.has(p.family));
    let family: Family;
    let founded = false;
    if (withFamily) family = this.families.get(withFamily.family!)!;
    else {
      const founder = ordered[0];
      const seq = ++this.familySeq;
      const color = this.familyColors.length ? this.familyColors[(seq - 1) % this.familyColors.length] : undefined;
      family = { id: `${session}-f${seq}`, name: name(founder?.name ?? '?'), founder: founder?.id ?? a, members: [], foundedDay: day, ...(color ? { color } : {}) };
      this.families.set(family.id, family);
      founded = true;
      for (const p of ordered) this.join(family, p.id);
    }
    this.join(family, childId);
    return { family, founded };
  }

  private join(f: Family, id: string): void {
    const p = this.people.get(id);
    if (p && !p.family) p.family = f.id;
    if (!f.members.includes(id)) f.members.push(id);
  }

  familyDto(f: Family) {
    const living = f.members.filter((id) => this.people.get(id)?.alive);
    const esteem = living.length ? living.reduce((s, id) => s + this.esteemOf(id), 0) / living.length : 0;
    return { id: f.id, name: f.name, founder: f.founder, members: [...f.members], alive: living.length, esteem: round3(esteem), ...(f.color ? { color: f.color } : {}) };
  }

  clear(): void {
    this.people.clear();
    this.families.clear();
    this.opinions = [];
    this.esteem.clear();
    this.ranks.clear();
    this.fameAcc.clear();
    this.heard.clear();
  }
}
