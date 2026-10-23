import type { AgeStage, Entity, Family, ItemBag, LawProposalMsg, Opinion, Person, ServerMsg, Society } from '../net/protocol';

/** Real seconds (speed 1) between reputation rounds, opinion shifts, skill gains and barter offers. */
const REPUTATION_EVERY = 8;
const OPINION_EVERY = 6;
const SKILL_EVERY = 17;
const OFFER_EVERY = 12;
/** Seconds before a pending offer is answered. */
const OFFER_ANSWER_SEC = 4;
/** Scripted moments: a child comes of age, an adult becomes an elder. */
const COMING_OF_AGE_AT = 75;
const ELDER_AT = 140;
const PROPOSALS_AT: [number, Omit<LawProposalMsg, 'type'>][] = [
  [10, { id: 'lp-1', by: 'a-dario', text: 'Ogni casata versi un cibo al granaio comune ogni giorno, per i giorni di neve.', key: 'food.family_tithe', category: 'economy', value: 1, branch: 'proposal/food-family-tithe', status: 'open' }],
  [24, { id: 'lp-2', by: 'a-bruno', text: 'Chi taglia un albero ne pianti un altro vicino al fiume.', key: 'wood.replant', category: 'environment', value: true, branch: 'proposal/wood-replant', status: 'open' }],
];
const PROPOSAL_REJECTED_AT = 50;

interface Seed {
  id: string;
  name: string;
  role: string;
  family: string | null;
  parents: [string, string] | null;
  stage: AgeStage;
  days: number;
  esteem: number;
  fame: number;
}

/** Two generations (three with the grandchild) of three houses; dead ancestors are people, not entities. */
const SEEDS: Seed[] = [
  { id: 'x-rosa', name: 'Rosa', role: 'healer', family: 'f-ardenti', parents: null, stage: 'elder', days: 21900, esteem: 0.7, fame: 40 },
  { id: 'a-dario', name: 'Dario', role: 'elder', family: 'f-ardenti', parents: null, stage: 'elder', days: 24800, esteem: 0.82, fame: 64 },
  { id: 'a-aurelia', name: 'Aurelia', role: 'chief', family: 'f-ardenti', parents: ['a-dario', 'x-rosa'], stage: 'adult', days: 13100, esteem: 0.9, fame: 78 },
  { id: 'a-bruno', name: 'Bruno', role: 'woodcutter', family: 'f-ardenti', parents: ['a-dario', 'x-rosa'], stage: 'adult', days: 11600, esteem: 0.48, fame: 22 },
  { id: 'a-ugo', name: 'Ugo', role: 'woodcutter', family: null, parents: null, stage: 'adult', days: 13900, esteem: 0.36, fame: 15 },
  { id: 'c-0', name: 'Lino', role: 'villager', family: 'f-ardenti', parents: ['a-aurelia', 'a-ugo'], stage: 'child', days: 2900, esteem: 0.2, fame: 4 },
  { id: 'x-sergio', name: 'Sergio', role: 'hunter', family: 'f-valli', parents: null, stage: 'elder', days: 23000, esteem: 0.6, fame: 35 },
  { id: 'a-elsa', name: 'Elsa', role: 'healer', family: 'f-valli', parents: null, stage: 'adult', days: 17500, esteem: 0.74, fame: 47 },
  { id: 'a-gaia', name: 'Gaia', role: 'gatherer', family: 'f-valli', parents: ['x-sergio', 'a-elsa'], stage: 'adult', days: 8100, esteem: 0.55, fame: 18 },
  { id: 'a-tina', name: 'Tina', role: 'gatherer', family: 'f-valli', parents: ['x-sergio', 'a-elsa'], stage: 'adult', days: 7000, esteem: 0.42, fame: 26 },
  { id: 'a-ivo', name: 'Ivo', role: 'hunter', family: 'f-corvi', parents: null, stage: 'adult', days: 12400, esteem: 0.58, fame: 31 },
  { id: 'a-cora', name: 'Cora', role: 'builder', family: 'f-corvi', parents: null, stage: 'adult', days: 11900, esteem: 0.66, fame: 38 },
  { id: 'c-1', name: 'Mira', role: 'villager', family: 'f-corvi', parents: ['a-ivo', 'a-cora'], stage: 'child', days: 5400, esteem: 0.25, fame: 6 },
  { id: 'a-fosco', name: 'Fosco', role: 'scout', family: null, parents: null, stage: 'adult', days: 9500, esteem: 0.61, fame: 52 },
  { id: 'c-2', name: 'Nello', role: 'villager', family: null, parents: null, stage: 'adult', days: 10200, esteem: 0.3, fame: 5 },
  { id: 'c-3', name: 'Olga', role: 'villager', family: null, parents: null, stage: 'elder', days: 26100, esteem: 0.45, fame: 12 },
];

const FAMILIES: { id: string; name: string; founder: string }[] = [
  { id: 'f-ardenti', name: 'Casata degli Ardenti', founder: 'a-dario' },
  { id: 'f-valli', name: 'Casata delle Valli', founder: 'x-sergio' },
  { id: 'f-corvi', name: 'Casata dei Corvi', founder: 'a-ivo' },
];

const OPINION_REASONS: [number, string][] = [
  [0.7, 'mi ha diviso il suo cibo durante il gelo'],
  [0.5, 'ha costruito la capanna dove dormo'],
  [0.4, 'mantiene sempre la parola'],
  [-0.4, 'ha tenuto per sé la legna del deposito'],
  [-0.6, 'ha rifiutato uno scambio onesto'],
  [-0.3, 'parla troppo e lavora poco'],
];

/** Barters the inhabitants propose to each other. */
const OFFERS: { give: ItemBag; want: ItemBag }[] = [
  { give: { wood: 2 }, want: { stone_axe: 1 } },
  { give: { food: 3 }, want: { poultice: 1 } },
  { give: { herbs: 2 }, want: { food: 2 } },
  { give: { meat: 2 }, want: { basket: 1 } },
  { give: { clay: 2 }, want: { wood: 3 } },
];

/** Recipes each role can get better at. */
const SKILLS: Record<string, string[]> = {
  builder: ['stone_axe', 'basket', 'rope'],
  healer: ['poultice'],
  elder: ['pot'],
  hunter: ['smoked_meat'],
  chief: ['rope'],
};

export interface SocietyHooks {
  emit(m: ServerMsg): void;
  r(): number;
  /** Living actors (mutated in place: society fields ride on the entity). */
  actors(): Entity[];
  speed: number;
}

/** Mock society: esteem drift, opinions, aging, skills, barter offers and agents' law proposals. */
export class SocietySim {
  private people = new Map<string, Person>();
  private opinions = new Map<string, Opinion>();
  private skills = new Map<string, Map<string, number>>();
  private repAt = REPUTATION_EVERY;
  private opAt = OPINION_EVERY;
  private skillAt = 5;
  private offerAt = 7;
  private offerSeq = 0;
  private proposalsSent = 0;
  private rejected = false;
  private comingOfAge = false;
  private elder = false;

  constructor(private hooks: SocietyHooks) {
    for (const sd of SEEDS) {
      // `x-` ids are dead ancestors: people of the society, never entities
      const dead = sd.id.startsWith('x-');
      this.people.set(sd.id, { id: sd.id, name: sd.name, role: sd.role, tier: 'haiku', age: { stage: sd.stage, days: sd.days }, esteem: sd.esteem, fame: sd.fame, rank: 0, family: sd.family, parents: sd.parents, alive: !dead });
    }
    const ids = SEEDS.filter((sd) => sd.id.startsWith('a-')).map((sd) => sd.id);
    for (const from of ids)
      for (const to of ids) {
        if (from === to || this.hooks.r() > 0.32) continue;
        const [score] = OPINION_REASONS[Math.floor(this.hooks.r() * OPINION_REASONS.length)];
        this.opinions.set(`${from}>${to}`, { from, to, score: +(score + (this.hooks.r() - 0.5) * 0.2).toFixed(2) });
      }
    this.rerank();
  }

  /** Copy the society fields onto an actor (called once per actor at creation). */
  decorate(e: Entity): void {
    const p = this.people.get(e.id);
    if (!p) {
      this.people.set(e.id, { id: e.id, name: e.name, role: e.role, tier: e.tier, age: { stage: 'adult', days: 9000 }, esteem: 0.3, fame: 0, rank: 0, family: null, parents: null, alive: true });
      this.rerank();
    } else Object.assign(p, { tier: e.tier, role: e.kind === 'crowd' ? p.role : e.role });
    this.sync(e);
  }

  society(): Society {
    for (const e of this.hooks.actors()) {
      const p = this.people.get(e.id);
      if (p) p.alive = e.alive;
    }
    return { people: [...this.people.values()].map((p) => ({ ...p, age: { ...p.age } })), families: this.families(), opinions: [...this.opinions.values()].map((o) => ({ ...o })) };
  }

  /** Skills the world already knows about, replayed after hello. */
  replay(): void {
    if (!this.skills.size) {
      for (const p of this.people.values()) {
        const list = SKILLS[p.role];
        if (!list || !p.alive) continue;
        this.skills.set(p.id, new Map([[list[0], 1 + Math.floor(this.hooks.r() * 3)]]));
      }
    }
    for (const [id, m] of this.skills) for (const [recipe, level] of m) this.hooks.emit({ type: 'skill', id, recipe, level });
    for (let i = 0; i < this.proposalsSent; i++) this.hooks.emit({ type: 'law_proposal', ...PROPOSALS_AT[i][1], status: i === 0 && this.rejected ? 'rejected' : 'open' });
  }

  tick(dt: number, elapsed: number): void {
    for (const p of this.people.values()) if (p.alive) p.age.days += dt * 0.0055; // ~8 game minutes per second
    if (elapsed >= this.repAt) {
      this.repAt = elapsed + REPUTATION_EVERY;
      this.reputation();
    }
    if (elapsed >= this.opAt) {
      this.opAt = elapsed + OPINION_EVERY;
      this.opinion();
    }
    if (elapsed >= this.skillAt) {
      this.skillAt = elapsed + SKILL_EVERY;
      this.skillUp();
    }
    if (elapsed >= this.offerAt) {
      this.offerAt = elapsed + OFFER_EVERY;
      this.offer();
    }
    while (this.proposalsSent < PROPOSALS_AT.length && elapsed >= PROPOSALS_AT[this.proposalsSent][0]) {
      const lp = PROPOSALS_AT[this.proposalsSent++][1];
      this.hooks.emit({ type: 'law_proposal', ...lp });
      this.hooks.emit({ type: 'world_event', kind: 'rules', text: `${this.people.get(lp.by)?.name ?? lp.by} propone una legge: ${lp.text}` });
    }
    if (!this.rejected && elapsed >= PROPOSAL_REJECTED_AT && this.proposalsSent > 0) {
      this.rejected = true;
      this.hooks.emit({ type: 'law_proposal', ...PROPOSALS_AT[0][1], status: 'rejected' });
    }
    if (!this.comingOfAge && elapsed >= COMING_OF_AGE_AT) {
      this.comingOfAge = true;
      this.age('c-1', 'adult', 'Mira è diventata adulta.');
    }
    if (!this.elder && elapsed >= ELDER_AT) {
      this.elder = true;
      this.age('a-elsa', 'elder', 'Elsa ora è un’anziana del villaggio.');
    }
  }

  // ------------------------------------------------------------ internals

  private living(): Person[] {
    const alive = new Set(this.hooks.actors().filter((e) => e.alive).map((e) => e.id));
    return [...this.people.values()].filter((p) => p.alive && alive.has(p.id));
  }

  private sync(e: Entity): void {
    const p = this.people.get(e.id);
    if (!p) return;
    Object.assign(e, { age: { ...p.age }, esteem: p.esteem, fame: p.fame, rank: p.rank, family: p.family, parents: p.parents });
  }

  private rerank(): void {
    const alive = [...this.people.values()].filter((p) => p.alive);
    alive.sort((a, b) => b.esteem * 100 + b.fame * 0.3 - (a.esteem * 100 + a.fame * 0.3));
    alive.forEach((p, i) => (p.rank = i + 1));
    for (const p of this.people.values()) if (!p.alive) p.rank = 0;
  }

  private families(): Family[] {
    return FAMILIES.map((f) => {
      const members = [...this.people.values()].filter((p) => p.family === f.id);
      const living = members.filter((p) => p.alive);
      const esteem = living.length ? living.reduce((a, p) => a + p.esteem, 0) / living.length : 0;
      return { ...f, members: members.map((p) => p.id), alive: living.length, esteem: +esteem.toFixed(3) };
    });
  }

  private reputation(): void {
    const living = this.living();
    if (!living.length) return;
    const r = this.hooks.r;
    // most drift a little, one person gets a notable jump either way
    const star = living[Math.floor(r() * living.length)];
    for (const p of living) {
      const d = p === star ? (r() < 0.6 ? 1 : -1) * (0.07 + r() * 0.06) : (r() - 0.5) * 0.03;
      p.esteem = +Math.max(0.02, Math.min(1, p.esteem + d)).toFixed(3);
      if (p === star && d > 0) p.fame += 2 + Math.floor(r() * 4);
    }
    this.rerank();
    const byId = new Map(this.hooks.actors().map((e) => [e.id, e]));
    for (const p of living) {
      const e = byId.get(p.id);
      if (e) this.sync(e);
    }
    this.hooks.emit({ type: 'reputation', people: [...this.people.values()].filter((p) => p.alive).map((p) => ({ id: p.id, esteem: p.esteem, fame: p.fame, rank: p.rank })) });
    for (const f of this.families()) this.hooks.emit({ type: 'family', family: f });
  }

  private opinion(): void {
    const living = this.living().filter((p) => p.id.startsWith('a-'));
    if (living.length < 2) return;
    const r = this.hooks.r;
    const from = living[Math.floor(r() * living.length)];
    const others = living.filter((p) => p !== from);
    const to = others[Math.floor(r() * others.length)];
    const [score, reason] = OPINION_REASONS[Math.floor(r() * OPINION_REASONS.length)];
    const key = `${from.id}>${to.id}`;
    const prev = this.opinions.get(key)?.score ?? 0;
    const next = +Math.max(-1, Math.min(1, prev * 0.5 + score * 0.7)).toFixed(2);
    this.opinions.set(key, { from: from.id, to: to.id, score: next });
    this.hooks.emit({ type: 'opinion', from: from.id, to: to.id, score: next, reason });
  }

  private skillUp(): void {
    const cands = this.living().filter((p) => SKILLS[p.role]);
    if (!cands.length) return;
    const r = this.hooks.r;
    const p = cands[Math.floor(r() * cands.length)];
    const list = SKILLS[p.role];
    const recipe = list[Math.floor(r() * list.length)];
    let m = this.skills.get(p.id);
    if (!m) this.skills.set(p.id, (m = new Map()));
    const level = Math.min(5, (m.get(recipe) ?? 0) + 1);
    m.set(recipe, level);
    this.hooks.emit({ type: 'skill', id: p.id, recipe, level });
  }

  private offer(): void {
    const agents = this.living().filter((p) => p.id.startsWith('a-'));
    if (agents.length < 2) return;
    const r = this.hooks.r;
    const from = agents[Math.floor(r() * agents.length)];
    const others = agents.filter((p) => p !== from);
    const to = others[Math.floor(r() * others.length)];
    const deal = OFFERS[Math.floor(r() * OFFERS.length)];
    const id = `of-${++this.offerSeq}`;
    const base = { type: 'offer' as const, id, from: from.id, to: to.id, give: { ...deal.give }, want: { ...deal.want } };
    this.hooks.emit({ ...base, status: 'pending' });
    // esteem tilts the answer: the trusted get more yeses
    const accepted = r() < 0.35 + from.esteem * 0.5;
    setTimeout(() => this.hooks.emit({ ...base, status: accepted ? 'accepted' : 'rejected' }), (OFFER_ANSWER_SEC * 1000) / this.hooks.speed);
  }

  private age(id: string, stage: AgeStage, text: string): void {
    const p = this.people.get(id);
    if (!p || !p.alive) return;
    p.age.stage = stage;
    const e = this.hooks.actors().find((a) => a.id === id);
    if (e) this.sync(e);
    this.hooks.emit({ type: 'aged', id, stage });
    this.hooks.emit({ type: 'world_event', kind: 'birth', text });
  }
}
