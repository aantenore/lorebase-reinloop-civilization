// Deterministic world engine: grid, people, seasons and the effect of the laws. No IO.
import type { Translate } from '../i18n.ts';
import { createRng, type Rng, valueNoise } from './rng.ts';
import {
  type ActionResult, type AgentSpec, type AgentState, type Biome, type InboxMessage, type Resource, type Rules,
  type Season, type Stats, type Tier, TIERS, type Tile, type TickOutcome, type WorldEvent, type WorldGenConfig,
} from './types.ts';

/** Rule keys the engine reads. Their values live in Lorebase; defaults only in the seed file. */
export const RULE_KEYS = [
  'max_hp', 'food_per_tick', 'starvation_threshold', 'starvation_damage', 'rest_heal', 'actions_per_tick',
  'gather_food_yield', 'gather_wood_yield', 'regrowth_per_tick', 'shelter_wood_cost', 'winter_every_ticks',
  'winter_length_ticks', 'winter_food_yield_multiplier', 'cold_damage_unsheltered', 'birth_food_cost',
  'sharing_allowed', 'vision_radius',
] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

export function rule(rules: Rules, key: RuleKey): number {
  const v = rules[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`rule "${key}" is missing or not a number`);
  return v;
}

export function missingRules(rules: Rules): string[] {
  return RULE_KEYS.filter((k) => typeof rules[k] !== 'number' || !Number.isFinite(rules[k]));
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const chebyshev = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function yearShape(rules: Rules): { year: number; winter: number } {
  const year = Math.max(1, Math.round(rule(rules, 'winter_every_ticks')));
  const winter = Math.min(year, Math.max(0, Math.round(rule(rules, 'winter_length_ticks'))));
  return { year, winter };
}

export function seasonOf(tick: number, rules: Rules): Season {
  const { year, winter } = yearShape(rules);
  const p = tick % year;
  if (p >= year - winter) return 'winter';
  const third = (year - winter) / 3;
  return p < third ? 'spring' : p < 2 * third ? 'summer' : 'autumn';
}

export function ticksUntilWinter(tick: number, rules: Rules): number {
  const { year, winter } = yearShape(rules);
  if (winter === 0) return Infinity;
  const p = tick % year;
  return p >= year - winter ? 0 : year - winter - p;
}

export class World {
  readonly cfg: WorldGenConfig;
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  tick = 0;
  tiles: Tile[] = [];
  agents = new Map<string, AgentState>();
  private rng: Rng;
  private nextId = 1;
  private pending: InboxMessage[] = [];
  private lastSeason: Season | undefined;
  private namesUsed = new Set<string>();
  /** Texts people read (action results, events) come from language templates. */
  private readonly t: Translate;
  /** Display name of a role code, as people read it (set by the host; identity by default). */
  roleTitle: (code: string) => string = (code) => code;

  constructor(cfg: WorldGenConfig, t: Translate, seed: number) {
    this.cfg = cfg;
    this.t = t;
    this.seed = seed;
    this.width = cfg.width;
    this.height = cfg.height;
    this.rng = createRng(seed);
    this.generate();
  }

  // ---- grid ---------------------------------------------------------------

  private generate(): void {
    const { width, height, noiseScale, waterBelow, rockAbove, forestAbove, capacity, initialFill } = this.cfg;
    const elevation = valueNoise(this.rng, width, height, noiseScale);
    const moisture = valueNoise(this.rng, width, height, noiseScale);
    this.tiles = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const e = elevation[y]![x]!;
        const biome: Biome = e < waterBelow ? 'water' : e > rockAbove ? 'rock' : moisture[y]![x]! > forestAbove ? 'forest' : 'grass';
        const fill = initialFill[0] + this.rng.next() * (initialFill[1] - initialFill[0]);
        const cap = capacity[biome];
        this.tiles.push({ x, y, biome, food: round2(cap.food * fill), wood: round2(cap.wood * fill), shelter: false });
      }
    }
  }

  tile(x: number, y: number): Tile | undefined {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return undefined;
    return this.tiles[y * this.width + x];
  }

  private walkable(t: Tile | undefined): t is Tile {
    return !!t && t.biome !== 'water';
  }

  // ---- people -------------------------------------------------------------

  living(): AgentState[] {
    return [...this.agents.values()].filter((a) => a.alive);
  }

  get(id: string): AgentState | undefined {
    return this.agents.get(id);
  }

  /** Finds a person by id or (case-insensitive) name. */
  find(ref: string): AgentState | undefined {
    const r = ref.trim().toLowerCase();
    return this.agents.get(ref) ?? [...this.agents.values()].find((a) => a.name.toLowerCase() === r || a.id.toLowerCase() === r);
  }

  private freeSpawnTile(near?: { x: number; y: number }): Tile {
    const cx = near?.x ?? Math.floor(this.width / 2);
    const cy = near?.y ?? Math.floor(this.height / 2);
    const occupied = new Set(this.living().map((a) => `${a.x},${a.y}`));
    for (let r = near ? 0 : this.cfg.spawnRadius; r <= Math.max(this.width, this.height); r++) {
      const ring = this.tiles.filter((t) => chebyshev(t, { x: cx, y: cy }) <= r && this.walkable(t));
      const free = ring.filter((t) => !occupied.has(`${t.x},${t.y}`));
      const pool = free.length ? free : ring;
      if (pool.length) return this.rng.pick(pool);
    }
    throw new Error('no walkable tile in the world');
  }

  spawn(spec: AgentSpec, rules: Rules, opts: { at?: { x: number; y: number }; generation?: number } = {}): AgentState {
    let id = spec.id && !this.agents.has(spec.id) ? spec.id : `a${this.nextId++}`;
    while (this.agents.has(id)) id = `a${this.nextId++}`;
    const at = opts.at && this.walkable(this.tile(opts.at.x, opts.at.y)) ? opts.at : this.freeSpawnTile();
    const maxHp = rule(rules, 'max_hp');
    const agent: AgentState = {
      id, name: spec.name, role: spec.role, tier: spec.tier, model: spec.model, personality: spec.personality ?? '',
      x: at.x, y: at.y, hp: maxHp, maxHp, hunger: 0, inventory: { food: 0, wood: 0 },
      alive: true, status: 'idle', thought: '', lastAction: null, generation: opts.generation ?? 0,
      actionsLeft: 0, inbox: [], lastBirthTick: this.tick, bornTick: this.tick,
    };
    this.agents.set(id, agent);
    this.namesUsed.add(spec.name);
    return agent;
  }

  /** Kills a person (removal from the colony); returns the event, or undefined when unknown or already dead. */
  kill(id: string, reason: 'deathStarved' | 'deathFrozen' | 'deathOther' | 'left'): WorldEvent | undefined {
    const a = this.agents.get(id);
    if (!a || !a.alive) return undefined;
    a.alive = false;
    a.status = 'dead';
    a.hp = 0;
    return { tick: this.tick, kind: 'death', text: this.t(`events.${reason}`, { name: a.name }) };
  }

  isSheltered(a: AgentState): boolean {
    return !!this.tile(a.x, a.y)?.shelter;
  }

  // ---- tick lifecycle -----------------------------------------------------

  /** Starts a tick: action points, message delivery, season change. */
  beginTick(rules: Rules): WorldEvent[] {
    this.tick++;
    const events: WorldEvent[] = [];
    const season = seasonOf(this.tick, rules);
    if (season !== this.lastSeason) {
      events.push({ tick: this.tick, kind: 'season', text: this.t('events.season', { season: this.t(`season.${season}`) }) });
      this.lastSeason = season;
    }
    const actions = Math.max(0, Math.floor(rule(rules, 'actions_per_tick')));
    const maxHp = rule(rules, 'max_hp');
    const delivered = this.pending;
    this.pending = [];
    for (const a of this.living()) {
      a.actionsLeft = actions;
      a.maxHp = maxHp;
      a.hp = Math.min(a.hp, maxHp);
      a.inbox = delivered.filter((m) => m.from !== a.id && (m.to === 'all' || m.to === a.id));
    }
    return events;
  }

  /** Ends a tick: hunger, cold, deaths, regrowth, births. */
  endTick(rules: Rules): TickOutcome {
    const events: WorldEvent[] = [];
    const deaths: AgentState[] = [];
    const winter = seasonOf(this.tick, rules) === 'winter';
    const threshold = rule(rules, 'starvation_threshold');
    const starving: string[] = [];
    const freezing: string[] = [];
    const causes = new Map<string, 'deathStarved' | 'deathFrozen'>();
    for (const a of this.living()) {
      a.hunger = round2(a.hunger + rule(rules, 'food_per_tick'));
      if (a.hunger > threshold) {
        a.hp = round2(a.hp - rule(rules, 'starvation_damage'));
        starving.push(a.name);
        causes.set(a.id, 'deathStarved');
      }
      if (winter && !this.isSheltered(a)) {
        const dmg = rule(rules, 'cold_damage_unsheltered');
        if (dmg > 0) {
          a.hp = round2(a.hp - dmg);
          freezing.push(a.name);
          if (!causes.has(a.id)) causes.set(a.id, 'deathFrozen');
        }
      }
    }
    if (starving.length) events.push({ tick: this.tick, kind: 'starvation', text: this.t('events.starvation', { names: starving.join(', ') }) });
    if (freezing.length) events.push({ tick: this.tick, kind: 'cold', text: this.t('events.cold', { names: freezing.join(', ') }) });
    for (const a of this.living()) {
      if (a.hp <= 0) {
        const ev = this.kill(a.id, causes.get(a.id) ?? 'deathOther');
        if (ev) events.push(ev);
        deaths.push(a);
      }
    }
    const tiles = this.regrow(rules, winter);
    const births = this.births(rules, events);
    return { events, births, deaths, tiles };
  }

  private regrow(rules: Rules, winter: boolean): Tile[] {
    const rate = rule(rules, 'regrowth_per_tick') * (winter ? rule(rules, 'winter_food_yield_multiplier') : 1);
    const changed: Tile[] = [];
    if (rate <= 0) return changed;
    for (const t of this.tiles) {
      const cap = this.cfg.capacity[t.biome];
      const food = round2(Math.min(cap.food, t.food + cap.food * rate));
      const wood = round2(Math.min(cap.wood, t.wood + cap.wood * rate));
      if (food !== t.food || wood !== t.wood) {
        t.food = food;
        t.wood = wood;
        changed.push(t);
      }
    }
    return changed;
  }

  private births(rules: Rules, events: WorldEvent[]): AgentState[] {
    const cost = rule(rules, 'birth_food_cost');
    const threshold = rule(rules, 'starvation_threshold');
    const { year } = yearShape(rules);
    const born: AgentState[] = [];
    const ready = (a: AgentState) => a.alive && a.hunger <= threshold && this.tick - a.lastBirthTick >= year && this.isSheltered(a);
    const people = this.living().filter(ready);
    const used = new Set<string>();
    for (const a of people) {
      if (used.has(a.id)) continue;
      const partner = people.find((b) => b.id !== a.id && !used.has(b.id) && b.x === a.x && b.y === a.y && a.inventory.food + b.inventory.food >= cost);
      if (!partner) continue;
      if (this.living().length + born.length >= this.cfg.maxPopulation) break;
      // Each parent pays half; the richer one covers what the other cannot.
      let due = cost;
      const fromA = Math.min(a.inventory.food, Math.max(cost / 2, cost - partner.inventory.food));
      a.inventory.food = round2(a.inventory.food - fromA);
      due -= fromA;
      partner.inventory.food = round2(partner.inventory.food - due);
      a.lastBirthTick = partner.lastBirthTick = this.tick;
      used.add(a.id).add(partner.id);
      const parent = this.rng.next() < 0.5 ? a : partner;
      const child = this.spawn(
        { name: this.childName(), role: parent.role, tier: parent.tier, model: parent.model, personality: this.t('events.childOf', { a: a.name, b: partner.name }) },
        rules,
        { at: { x: a.x, y: a.y }, generation: Math.max(a.generation, partner.generation) + 1 },
      );
      born.push(child);
      events.push({ tick: this.tick, kind: 'birth', text: this.t('events.birth', { name: child.name, a: a.name, b: partner.name }) });
    }
    return born;
  }

  private childName(): string {
    const free = this.cfg.namePool.filter((n) => !this.namesUsed.has(n));
    return free.length ? this.rng.pick(free) : this.t('events.childName', { n: this.nextId });
  }

  // ---- actions ------------------------------------------------------------

  private actor(id: string, costsAction: boolean): AgentState | string {
    const a = this.agents.get(id);
    if (!a) return this.t('act.unknownPerson');
    if (!a.alive) return this.t('act.dead');
    if (costsAction && a.actionsLeft <= 0) return this.t('act.noActions');
    return a;
  }

  private fail(text: string): ActionResult {
    return { ok: false, text };
  }

  look(id: string, rules: Rules, maxTiles: number): ActionResult {
    const a = this.actor(id, false);
    if (typeof a === 'string') return this.fail(a);
    const t = this.t;
    const r = Math.max(0, Math.floor(rule(rules, 'vision_radius')));
    const here = this.tile(a.x, a.y)!;
    const visible = this.tiles
      .filter((x) => chebyshev(x, a) <= r && x !== here && (x.food >= 1 || x.wood >= 1 || x.shelter))
      .sort((p, q) => chebyshev(p, a) - chebyshev(q, a))
      .slice(0, maxTiles)
      .map((x) => t('look.tile', { x: x.x, y: x.y, biome: t(`biome.${x.biome}`), food: x.food, wood: x.wood, shelter: x.shelter ? t('look.tileShelter') : '' }));
    const people = this.living()
      .filter((b) => b.id !== a.id && chebyshev(b, a) <= r)
      .map((b) => t('look.person', { name: b.name, role: this.roleTitle(b.role), x: b.x, y: b.y, hp: b.hp, food: b.inventory.food }));
    const shelters = this.tiles.filter((x) => x.shelter).sort((p, q) => chebyshev(p, a) - chebyshev(q, a));
    const nearest = shelters[0] ? t('look.shelterAt', { x: shelters[0].x, y: shelters[0].y, steps: chebyshev(shelters[0], a) }) : t('look.noShelter');
    const lines = [
      t('look.here', { x: a.x, y: a.y, biome: t(`biome.${here.biome}`), food: here.food, wood: here.wood, shelter: here.shelter ? t('look.shelterHere') : '' }),
      t('look.map', { w: this.width, h: this.height }),
      t('look.tiles', { radius: r, tiles: visible.length ? visible.join('; ') : t('look.nothing') }),
      t('look.people', { people: people.length ? people.join('; ') : t('look.nobody') }),
      t('look.shelters', { shelter: nearest }),
    ];
    return { ok: true, text: lines.join('\n') };
  }

  move(id: string, dx: number, dy: number): ActionResult {
    const a = this.actor(id, true);
    if (typeof a === 'string') return this.fail(a);
    const sx = Math.sign(Math.trunc(dx) || 0);
    const sy = Math.sign(Math.trunc(dy) || 0);
    if (!sx && !sy) return this.fail(this.t('act.zeroMove'));
    const target = this.tile(a.x + sx, a.y + sy);
    if (!target) return this.fail(this.t('act.outside'));
    if (!this.walkable(target)) return this.fail(this.t('act.water', { x: target.x, y: target.y }));
    a.x = target.x;
    a.y = target.y;
    a.actionsLeft--;
    return {
      ok: true,
      text: this.t('act.moved', { x: a.x, y: a.y, biome: this.t(`biome.${target.biome}`), food: target.food, wood: target.wood, shelter: target.shelter ? this.t('act.movedShelter') : '' }),
    };
  }

  gather(id: string, resource: Resource, rules: Rules): ActionResult {
    const a = this.actor(id, true);
    if (typeof a === 'string') return this.fail(a);
    const t = this.tile(a.x, a.y)!;
    const winter = seasonOf(this.tick, rules) === 'winter';
    const base = rule(rules, resource === 'food' ? 'gather_food_yield' : 'gather_wood_yield');
    const yieldNow = base * (winter ? rule(rules, 'winter_food_yield_multiplier') : 1);
    const amount = Math.floor(Math.min(yieldNow, t[resource]));
    if (amount < 1) return this.fail(this.t('act.notEnough', { resource: this.t(`resource.${resource}`), amount: t[resource] }));
    t[resource] = round2(t[resource] - amount);
    a.inventory[resource] += amount;
    a.actionsLeft--;
    return { ok: true, text: this.t('act.gathered', { amount, resource: this.t(`resource.${resource}`), food: a.inventory.food, wood: a.inventory.wood }), tiles: [t] };
  }

  eat(id: string, amount?: number): ActionResult {
    const a = this.actor(id, false);
    if (typeof a === 'string') return this.fail(a);
    if (a.hunger <= 0) return this.fail(this.t('act.notHungry'));
    if (a.inventory.food < 1) return this.fail(this.t('act.noFood'));
    const want = Math.max(1, Math.floor(amount ?? Math.ceil(a.hunger)));
    const n = Math.min(want, a.inventory.food, Math.ceil(a.hunger));
    a.inventory.food -= n;
    a.hunger = round2(Math.max(0, a.hunger - n));
    return { ok: true, text: this.t('act.ate', { amount: n, hunger: a.hunger, food: a.inventory.food }) };
  }

  buildShelter(id: string, rules: Rules): ActionResult {
    const a = this.actor(id, true);
    if (typeof a === 'string') return this.fail(a);
    const t = this.tile(a.x, a.y)!;
    if (t.shelter) return this.fail(this.t('act.shelterExists'));
    const cost = rule(rules, 'shelter_wood_cost');
    if (a.inventory.wood < cost) return this.fail(this.t('act.shelterCost', { cost, wood: a.inventory.wood }));
    a.inventory.wood = round2(a.inventory.wood - cost);
    t.shelter = true;
    a.actionsLeft--;
    return {
      ok: true,
      text: this.t('act.built', { x: t.x, y: t.y }),
      tiles: [t],
      events: [{ tick: this.tick, kind: 'build', text: this.t('events.build', { name: a.name, x: t.x, y: t.y }) }],
    };
  }

  give(id: string, to: string, resource: Resource, amount: number, rules: Rules): ActionResult {
    const a = this.actor(id, true);
    if (typeof a === 'string') return this.fail(a);
    if (rule(rules, 'sharing_allowed') < 1) return this.fail(this.t('act.givingForbidden'));
    const b = this.find(to);
    if (!b || !b.alive) return this.fail(this.t('act.noSuchPerson', { name: to }));
    if (b.id === a.id) return this.fail(this.t('act.selfGive'));
    if (chebyshev(a, b) > 1) return this.fail(this.t('act.tooFar', { name: b.name }));
    const n = Math.floor(Math.min(amount, a.inventory[resource]));
    if (n < 1) return this.fail(this.t('act.nothingToGive', { resource: this.t(`resource.${resource}`) }));
    a.inventory[resource] -= n;
    b.inventory[resource] += n;
    a.actionsLeft--;
    return { ok: true, text: this.t('act.gave', { amount: n, resource: this.t(`resource.${resource}`), name: b.name }) };
  }

  say(id: string, to: string, text: string, maxChars: number): ActionResult {
    const a = this.actor(id, false);
    if (typeof a === 'string') return this.fail(a);
    const all = to.trim().toLowerCase() === 'all';
    const target = all ? undefined : this.find(to);
    if (!all && (!target || !target.alive)) return this.fail(this.t('act.noSuchPerson', { name: to }));
    const message: InboxMessage = { tick: this.tick, from: a.id, fromName: a.name, to: target?.id ?? 'all', text: text.slice(0, maxChars) };
    this.pending.push(message);
    return { ok: true, text: this.t('act.said', { to: target?.name ?? this.t('act.everyone'), text: message.text }), message };
  }

  rest(id: string, rules: Rules): ActionResult {
    const a = this.actor(id, true);
    if (typeof a === 'string') return this.fail(a);
    a.actionsLeft--;
    if (a.hunger > rule(rules, 'starvation_threshold')) return { ok: true, text: this.t('act.restStarving') };
    a.hp = round2(Math.min(a.maxHp, a.hp + rule(rules, 'rest_heal')));
    return { ok: true, text: this.t('act.rested', { hp: a.hp, maxHp: a.maxHp }) };
  }

  // ---- views --------------------------------------------------------------

  stats(): Stats {
    const living = this.living();
    const avg = (xs: AgentState[]) => (xs.length ? round2(xs.reduce((s, a) => s + a.hp, 0) / xs.length) : 0);
    const byTier = Object.fromEntries(
      TIERS.map((t) => {
        const of = living.filter((a) => a.tier === t);
        return [t, { alive: of.length, avgHp: avg(of) }];
      }),
    ) as Record<Tier, { alive: number; avgHp: number }>;
    return {
      tick: this.tick,
      population: living.length,
      food: round2(living.reduce((s, a) => s + a.inventory.food, 0)),
      wood: round2(living.reduce((s, a) => s + a.inventory.wood, 0)),
      shelters: this.tiles.filter((t) => t.shelter).length,
      avgHp: avg(living),
      byTier,
    };
  }
}
