// Real-time world: a tile map with elevation, people with float positions executing plans at
// their own speed, a clock in game minutes, and the laws (Lorebase Rule values) applied per
// game minute. No IO: everything that happens is reported through `onEvent`.
import type { Role } from '../lorebase/rules.ts';
import { seasonOf } from '../world/engine.ts';
import { createRng, type Rng, valueNoise } from '../world/rng.ts';
import type { Rules, Season } from '../world/types.ts';
import { findPath, nearestWalkable, type Point } from './path.ts';
import {
  addItems, applyCraft, knownItem, newInventory, canCraft, type Catalog, count, defaultFood, type Discovery, experiment, gatherableAt, gatherTool, protectionOf,
  type RecipeDef, spoil, stationsOf, type TechDef, type ToolInstance, transfer, useEffect, wearStructures, wearTool,
} from './economy.ts';
import { type Activity, advance, type Anim, type Dir, type ExecContext, type Plan, prepareStep, tileOf } from './plan.ts';

export type Biome = 'grass' | 'forest' | 'water' | 'rock' | 'sand';
export type EntityTier = 'opus' | 'sonnet' | 'haiku' | 'human';
export type EntityKind = 'agent' | 'player' | 'crowd';
export type AgeStage = 'child' | 'adult' | 'elder';
/** Item code (Lorebase Resource). `food` and `wood` are the tile stocks. */
export type Resource = string;

/** Rule keys the real-time world reads (values only in Lorebase). */
export const RT_RULE_KEYS = [
  'max_hp', 'food_per_tick', 'starvation_threshold', 'starvation_damage', 'rest_heal', 'gather_food_yield', 'gather_wood_yield',
  'regrowth_per_tick', 'shelter_wood_cost', 'winter_every_ticks', 'winter_length_ticks', 'winter_food_yield_multiplier',
  'cold_damage_unsheltered', 'birth_food_cost', 'sharing_allowed', 'vision_radius', 'game_minutes_per_real_second', 'turn_minutes',
  'dawn_minute', 'dusk_minute', 'plan_horizon_minutes', 'replan_cooldown_minutes', 'base_move_speed', 'base_work_speed',
  'gather_minutes', 'build_minutes', 'eat_minutes', 'weak_speed_factor', 'critical_hunger', 'critical_hp_fraction', 'speech_radius',
  'max_shelter_level', 'shelter_decay_per_day', 'wild_distance', 'wild_damage', 'experiment_minutes', 'use_minutes', 'tool_wear_per_use', 'season_turn_minutes',
  // barter, ages, skills and society
  'offer_minutes', 'trade_trust_esteem', 'age_child_days', 'age_elder_days', 'founder_age_days', 'child_work_factor', 'child_move_factor',
  'child_max_recipe_inputs', 'elder_work_factor', 'elder_move_factor', 'elder_esteem_weight', 'skill_gain_per_practice', 'skill_max_level',
  'esteem_prior', 'esteem_prior_weight', 'opinion_half_life_days', 'esteem_judge_weight', 'reputation_inheritance', 'fame_gift',
  'fame_recipe_supply', 'fame_insight_accepted', 'fame_discovery', 'fame_law_enacted', 'fame_half_life_days', 'esteem_vote_weight',
  'insight_review_esteem_factor', 'insight_solo_approve_esteem', 'law_proposal_min_esteem', 'fame_law_respected', 'fame_law_breached',
] as const;
export type RtRuleKey = (typeof RT_RULE_KEYS)[number];

export const DAY_MINUTES = 1440;

export function missingRtRules(rules: Rules): string[] {
  return RT_RULE_KEYS.filter((k) => typeof rules[k] !== 'number' || !Number.isFinite(rules[k]));
}

export interface RtTile {
  x: number;
  y: number;
  biome: Biome;
  elev: number;
  food: number;
  wood: number;
  shelter: number;
  /** Structures built on the tile (code -> days of durability left). */
  structures: Record<string, number>;
  /** Fraction of a shelter level already worn away. */
  shelterWear: number;
}

export interface MapConfig {
  width: number;
  height: number;
  noiseScale: number;
  waterBelow: number;
  sandBelow: number;
  rockAbove: number;
  forestAbove: number;
  elevationSteps: number;
  capacity: Record<Biome, { food: number; wood: number }>;
  blocked: Biome[];
  initialFill: [number, number];
  spawnRadius: number;
  /**
   * Food near the spawn at world creation, so the first day is survivable: walkable tiles within `radius`
   * (Chebyshev, from the map centre) start filled to `fill` of their food capacity and with at least `minFood`.
   */
  spawnFood?: { radius: number; fill: number; minFood: number };
  /**
   * Where the gathered materials are found. Outside a core of `coreRadius` tiles (Chebyshev, from the map
   * centre) the map is cut into angular sectors, each yielding only its `items` (on the biomes their Lorebase
   * Resource names); the core yields none of the listed items. Items listed in no sector are found wherever
   * their biome is. The rotation of the sectors is seeded: of `rotations` candidates the first where every
   * sector has at least `minTiles` tiles for each of its items is kept (else the best one).
   */
  regions?: { coreRadius: number; minTiles: number; rotations: number; sectors: Array<{ name: string; items: string[] }> };
  maxPopulation: number;
}

/** Why the body lost or gained health since the person last thought (physically attributable causes). */
export type BodyCause = 'starved' | 'cold' | 'wild' | 'rest' | 'remedy';

export interface BodyLog {
  /** Game clock when the log began. */
  since: number;
  hp: number;
  hunger: number;
  /** Health lost (negative) or gained (positive) per cause. */
  causes: Partial<Record<BodyCause, number>>;
  /** Food units eaten. */
  ate: number;
}

export interface MovementConfig {
  arriveEpsilon: number;
  interactRange: number;
  maxPathNodes: number;
  diagonal: boolean;
}

export interface InboxItem {
  from: string;
  fromName: string;
  to: string;
  text: string;
  day: number;
  minute: number;
}

export interface RtEntity {
  id: string;
  name: string;
  role: string;
  tier: EntityTier;
  model: string;
  kind: EntityKind;
  personality: string;
  groupId: string | null;
  x: number;
  y: number;
  dir: Dir;
  anim: Anim;
  hp: number;
  maxHp: number;
  hunger: number;
  inventory: Record<string, number>;
  tools: ToolInstance[];
  /** Perishable stock already half-spoiled (fractions not yet lost). */
  spoilAcc: Record<string, number>;
  alive: boolean;
  plan?: Plan;
  activity?: Activity;
  /** Player movement vector (tile space, length <= 1). */
  input: { dx: number; dy: number };
  /** What this person lived through, newest last (own memory, read back when deciding). */
  memory: string[];
  inbox: InboxItem[];
  lastBirthTurn: number;
  /** Game clock (minutes) of birth; founders arrive already grown (rule founder_age_days). */
  bornAt: number;
  /** Life stage last reported (an `aged` event fires when it changes). */
  stage: AgeStage;
  /** Ids of the two parents, null for founders and players. */
  parents: [string, string] | null;
  /** Family (dynasty) id, null until the person belongs to one. */
  family: string | null;
  /** Times each recipe was followed (practice). */
  skills: Record<string, number>;
  diedAtMs?: number;
  /** Players: brief work animation after an act. */
  busyUntilMinute?: number;
}

export type WorldEvent =
  | { type: 'step'; id: string; current: number }
  | { type: 'step_failed'; id: string; step: number; reason: string }
  | { type: 'plan_done'; id: string }
  | { type: 'say'; from: string; to: string; text: string; hearers: string[] }
  | { type: 'tile'; tile: RtTile }
  | { type: 'death'; id: string; cause: 'starved' | 'frozen' | 'other' }
  | { type: 'birth'; child: RtEntity; parents: [string, string] }
  | { type: 'build'; id: string; x: number; y: number; level: number }
  | { type: 'gave'; from: string; to: string; resource: Resource; amount: number }
  | { type: 'craft'; id: string; recipe: string; inputs: Record<string, number>; outputs: Record<string, number>; at: Point; broken: string[] }
  | { type: 'experiment'; id: string; items: string[]; found?: { tech: TechDef; recipe: RecipeDef } }
  | { type: 'decay'; id: string; item: string; amount: number; reason: 'spoiled' | 'broken' | 'worn' }
  | { type: 'used'; id: string; item: string }
  | { type: 'critical'; id: string; what: 'hunger' | 'hp' }
  | { type: 'aged'; id: string; stage: AgeStage }
  | { type: 'skill'; id: string; recipe: string; level: number }
  | { type: 'season'; season: Season }
  | { type: 'night'; night: boolean };

export interface ActResult {
  ok: boolean;
  /** Stable reason code when not ok (translated by the caller). */
  reason?: string;
  amount?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A recipe a child cannot follow: it needs tools or a station, or consumes more than `maxInputs` units. */
export function tooComplexForChild(r: Pick<RecipeDef, 'tools' | 'station' | 'inputs'>, maxInputs: number): boolean {
  const units = Object.values(r.inputs).reduce((s, n) => s + n, 0);
  return r.tools.length > 0 || !!r.station || units > maxInputs;
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class RtWorld {
  readonly map: MapConfig;
  readonly move: MovementConfig;
  readonly width: number;
  readonly height: number;
  tiles: RtTile[] = [];
  entities = new Map<string, RtEntity>();
  /** Total game minutes since day 1 00:00. */
  clock: number;
  /** Clock value at which the world began: turns (and so seasons) count from here. */
  epoch: number;
  rules: Rules = {};
  roleOf: (code: string) => Role | undefined = () => undefined;
  /** The economy (Lorebase Resource/Recipe/Technology) and what the civilization has discovered. */
  catalog: Catalog = { resources: new Map(), recipes: new Map(), techs: new Map() };
  discovered = new Map<string, Discovery>();
  /** Multiplies game time per real second (engine knob, config `loop.timeScale`). */
  timeScale = 1;
  minExperimentItems = 2;
  onEvent: (ev: WorldEvent) => void = () => undefined;
  namePool: string[];
  memoryItems: number;
  inboxItems: number;
  private rng: Rng;
  /** Seeded rotation of the resource sectors (map.regions), chosen once the catalog is known. */
  private regionSeed = 0;
  private regionOffset = 0;
  private regionCatalog?: Catalog;
  private bodyLogs = new Map<string, BodyLog>();
  /** Harms each person has felt on its own body at least once (e.g. 'wild'). */
  private felt = new Map<string, Set<BodyCause>>();
  /** Who the child of two parents is (tier, model, kind), or undefined when no birth may happen. Default: like a random parent. */
  childOf?: (a: RtEntity, b: RtEntity, rnd: () => number) => { tier: EntityTier; model: string; kind: EntityKind } | undefined;
  /** Barter (plan step `offer`): the game's offer book handles it. */
  offerHook?: (e: RtEntity, to: string, give: unknown, want: unknown) => ActResult;
  private nextId = 1;
  private lastSeason: Season | undefined;
  private lastNight: boolean | undefined;
  private lastTurn = -1;
  private namesUsed = new Set<string>();

  constructor(map: MapConfig, move: MovementConfig, seed: number, startMinute: number, opts: { namePool: string[]; memoryItems: number; inboxItems: number }) {
    this.map = map;
    this.move = move;
    this.width = map.width;
    this.height = map.height;
    this.rng = createRng(seed);
    this.clock = startMinute;
    this.epoch = startMinute;
    this.namePool = opts.namePool;
    this.memoryItems = opts.memoryItems;
    this.inboxItems = opts.inboxItems;
    this.generate();
  }

  // ---- rules & time -------------------------------------------------------

  r(key: RtRuleKey): number {
    const v = this.rules[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`rule "${key}" is missing or not a number`);
    return v;
  }

  get day(): number {
    return Math.floor(this.clock / DAY_MINUTES) + 1;
  }

  get minute(): number {
    return Math.floor(this.clock % DAY_MINUTES);
  }

  get turn(): number {
    return Math.floor((this.clock - this.epoch) / Math.max(1, this.r('turn_minutes')));
  }

  /** Turns of the year for seasons (rule season_turn_minutes; turn_minutes stays the body's clock). */
  get seasonTurn(): number {
    return Math.floor((this.clock - this.epoch) / Math.max(1, this.r('season_turn_minutes')));
  }

  season(): Season {
    return seasonOf(this.seasonTurn, this.rules);
  }

  isNight(): boolean {
    const m = this.minute;
    const dawn = this.r('dawn_minute');
    const dusk = this.r('dusk_minute');
    return dawn <= dusk ? m >= dusk || m < dawn : m >= dusk && m < dawn;
  }

  // ---- map ----------------------------------------------------------------

  private generate(): void {
    const m = this.map;
    const elevation = valueNoise(this.rng, m.width, m.height, m.noiseScale);
    const moisture = valueNoise(this.rng, m.width, m.height, m.noiseScale);
    for (let y = 0; y < m.height; y++) {
      for (let x = 0; x < m.width; x++) {
        const e = elevation[y]![x]!;
        const biome: Biome = e < m.waterBelow ? 'water' : e > m.rockAbove ? 'rock' : e < m.sandBelow ? 'sand' : moisture[y]![x]! > m.forestAbove ? 'forest' : 'grass';
        const elev = biome === 'water' ? 0 : 1 + Math.floor(clamp((e - m.waterBelow) / (1 - m.waterBelow), 0, 0.999) * m.elevationSteps);
        const fill = m.initialFill[0] + this.rng.next() * (m.initialFill[1] - m.initialFill[0]);
        const cap = m.capacity[biome];
        this.tiles.push({ x, y, biome, elev, food: round2(cap.food * fill), wood: round2(cap.wood * fill), shelter: 0, structures: {}, shelterWear: 0 });
      }
    }
    this.regionSeed = this.rng.next();
    const sf = m.spawnFood;
    if (!sf || sf.radius < 0) return;
    const cx = Math.floor(this.width / 2);
    const cy = Math.floor(this.height / 2);
    for (const t of this.tiles) {
      if (Math.max(Math.abs(t.x - cx), Math.abs(t.y - cy)) > sf.radius || m.blocked.includes(t.biome)) continue;
      t.food = round2(Math.max(t.food, m.capacity[t.biome].food * sf.fill, sf.minFood));
    }
  }

  // ---- regions (where gathered materials are found) ---------------------------------

  /** Sector index of a tile, -1 inside the core, undefined when the map has no regions. */
  regionOf(p: Point): number | undefined {
    const rg = this.map.regions;
    if (!rg || !rg.sectors.length) return undefined;
    this.ensureRegions();
    return this.sectorAt(p, this.regionOffset);
  }

  private sectorAt(p: Point, offset: number): number {
    const rg = this.map.regions!;
    if (this.distanceFromCenter(p) <= rg.coreRadius) return -1;
    const a = Math.atan2(p.y - Math.floor(this.height / 2), p.x - Math.floor(this.width / 2)) / (2 * Math.PI);
    const turn = (((a + offset) % 1) + 1) % 1;
    return Math.min(rg.sectors.length - 1, Math.floor(turn * rg.sectors.length));
  }

  /** Picks the sector rotation once the catalog (biomes of each Resource) is known. */
  private ensureRegions(): void {
    const rg = this.map.regions;
    if (!rg || this.regionCatalog === this.catalog) return;
    this.regionCatalog = this.catalog;
    const n = Math.max(1, Math.floor(rg.rotations));
    let best = { offset: this.regionSeed, score: -1 };
    for (let k = 0; k < n; k++) {
      const offset = (this.regionSeed + k / n) % 1;
      const counts = rg.sectors.map((s) => Object.fromEntries(s.items.map((i) => [i, 0])) as Record<string, number>);
      for (const t of this.tiles) {
        if (!this.walkable(t.x, t.y)) continue;
        const s = this.sectorAt(t, offset);
        if (s < 0) continue;
        for (const item of rg.sectors[s]!.items) {
          const def = this.catalog.resources.get(item);
          if (def && gatherableAt(def, t.biome, this.distanceFromCenter(t))) counts[s]![item]!++;
        }
      }
      const score = Math.min(...counts.flatMap((c) => Object.values(c)), Number.MAX_SAFE_INTEGER);
      if (score > best.score) best = { offset, score };
      if (score >= rg.minTiles) break;
    }
    this.regionOffset = best.offset;
  }

  /** Whether `item` can be gathered on tile `t` (its biome, its distance and the region's items). */
  canGatherAt(item: string, t: Pick<RtTile, 'x' | 'y' | 'biome'>): boolean {
    const def = this.catalog.resources.get(item);
    if (!def || !gatherableAt(def, t.biome, this.distanceFromCenter(t))) return false;
    const rg = this.map.regions;
    if (!rg || !rg.sectors.some((s) => s.items.includes(item))) return true;
    const s = this.regionOf(t)!;
    return s >= 0 && rg.sectors[s]!.items.includes(item);
  }

  // ---- body log (what the body went through since the person last thought) --------------

  private bodyLog(e: RtEntity): BodyLog {
    let log = this.bodyLogs.get(e.id);
    if (!log) {
      log = { since: this.clock, hp: e.hp, hunger: e.hunger, causes: {}, ate: 0 };
      this.bodyLogs.set(e.id, log);
    }
    return log;
  }

  private logBody(e: RtEntity, cause: BodyCause, amount: number): void {
    if (!amount) return;
    const log = this.bodyLog(e);
    log.causes[cause] = round2((log.causes[cause] ?? 0) + amount);
    if (amount < 0 && cause !== 'rest' && cause !== 'remedy') (this.felt.get(e.id) ?? this.felt.set(e.id, new Set()).get(e.id)!).add(cause);
  }

  /** The body's changes since the log began (health and hunger now minus then, causes, food eaten). */
  bodySince(e: RtEntity): { minutes: number; hp: number; hunger: number; causes: Partial<Record<BodyCause, number>>; ate: number } {
    const log = this.bodyLog(e);
    return { minutes: Math.round(this.clock - log.since), hp: round2(e.hp - log.hp), hunger: round2(e.hunger - log.hunger), causes: { ...log.causes }, ate: log.ate };
  }

  /** Starts a new body log (when the person has just thought about its situation). */
  resetBody(e: RtEntity): void {
    this.bodyLogs.set(e.id, { since: this.clock, hp: e.hp, hunger: e.hunger, causes: {}, ate: 0 });
  }

  /** Whether the person has already felt this harm on its own body. */
  hasFelt(e: RtEntity, cause: BodyCause): boolean {
    return this.felt.get(e.id)?.has(cause) ?? false;
  }

  tile(x: number, y: number): RtTile | undefined {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return undefined;
    return this.tiles[y * this.width + x];
  }

  walkable = (x: number, y: number): boolean => {
    const t = this.tile(x, y);
    return !!t && !this.map.blocked.includes(t.biome);
  };

  path(from: Point, to: Point): Point[] | undefined {
    return findPath(this.width, this.height, this.walkable, from, to, { diagonal: this.move.diagonal, maxNodes: this.move.maxPathNodes });
  }

  // ---- people -------------------------------------------------------------

  living(): RtEntity[] {
    return [...this.entities.values()].filter((e) => e.alive);
  }

  find(ref: string): RtEntity | undefined {
    const r = ref.trim().toLowerCase();
    return this.entities.get(ref) ?? [...this.entities.values()].find((e) => e.alive && (e.name.toLowerCase() === r || e.id.toLowerCase() === r));
  }

  nameTaken(name: string): boolean {
    return this.living().some((e) => e.name.toLowerCase() === name.trim().toLowerCase());
  }

  private spawnPoint(near?: Point): Point {
    const cx = near?.x ?? Math.floor(this.width / 2);
    const cy = near?.y ?? Math.floor(this.height / 2);
    const radius = near ? 1 : this.map.spawnRadius;
    const pool = this.tiles.filter((t) => Math.max(Math.abs(t.x - cx), Math.abs(t.y - cy)) <= radius && this.walkable(t.x, t.y));
    if (pool.length) {
      const t = this.rng.pick(pool);
      return { x: t.x, y: t.y };
    }
    const p = nearestWalkable(this.width, this.height, this.walkable, { x: cx, y: cy });
    if (!p) throw new Error('no walkable tile in the world');
    return p;
  }

  /** `ageDays`: age at arrival (default: rule founder_age_days, or age_elder_days for the elder role). */
  spawn(spec: { id?: string; name: string; role: string; tier: EntityTier; model: string; kind: EntityKind; personality?: string; ageDays?: number; parents?: [string, string] }, near?: Point): RtEntity {
    let id = spec.id && !this.entities.has(spec.id) ? spec.id : `${spec.kind === 'player' ? 'p' : spec.kind === 'crowd' ? 'c' : 'a'}${this.nextId++}`;
    while (this.entities.has(id)) id = `e${this.nextId++}`;
    const at = this.spawnPoint(near);
    const maxHp = this.r('max_hp');
    const e: RtEntity = {
      id, name: spec.name, role: spec.role, tier: spec.tier, model: spec.model, kind: spec.kind, personality: spec.personality ?? '',
      groupId: null, x: at.x, y: at.y, dir: 's', anim: 'idle', hp: maxHp, maxHp, hunger: 0, inventory: newInventory(),
      tools: [], spoilAcc: {}, alive: true, input: { dx: 0, dy: 0 }, memory: [], inbox: [], lastBirthTurn: this.turn,
      bornAt: 0, stage: 'adult', parents: spec.parents ?? null, family: null, skills: {},
    };
    const ageDays = spec.ageDays ?? (spec.role === 'elder' ? this.r('age_elder_days') : this.r('founder_age_days'));
    e.bornAt = this.clock - Math.max(0, ageDays) * DAY_MINUTES;
    e.stage = this.stageOf(e);
    this.entities.set(id, e);
    this.namesUsed.add(spec.name);
    return e;
  }

  /** Puts a message in one person's inbox (kept to the last `inboxItems`). */
  deliver(e: RtEntity, item: InboxItem): void {
    e.inbox.push(item);
    if (e.inbox.length > this.inboxItems) e.inbox.splice(0, e.inbox.length - this.inboxItems);
  }

  remember(e: RtEntity, text: string): void {
    e.memory.push(`[g${this.day} ${this.clockText()}] ${text}`);
    if (e.memory.length > this.memoryItems) e.memory.splice(0, e.memory.length - this.memoryItems);
  }

  clockText(): string {
    const m = this.minute;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }

  kill(id: string, cause: 'starved' | 'frozen' | 'other', nowMs: number): boolean {
    const e = this.entities.get(id);
    if (!e || !e.alive) return false;
    e.alive = false;
    e.hp = 0;
    e.anim = 'idle';
    e.plan = undefined;
    e.activity = undefined;
    e.diedAtMs = nowMs;
    this.onEvent({ type: 'death', id, cause });
    return true;
  }

  isSheltered(e: { x: number; y: number }): boolean {
    const t = tileOf(e);
    return (this.tile(t.x, t.y)?.shelter ?? 0) > 0;
  }

  /** Age in game days. */
  ageDays(e: Pick<RtEntity, 'bornAt'>): number {
    return Math.max(0, (this.clock - e.bornAt) / DAY_MINUTES);
  }

  stageOf(e: Pick<RtEntity, 'bornAt'>): AgeStage {
    const d = this.ageDays(e);
    return d < this.r('age_child_days') ? 'child' : d >= this.r('age_elder_days') ? 'elder' : 'adult';
  }

  private ageFactor(e: RtEntity, what: 'work' | 'move'): number {
    const stage = this.stageOf(e);
    if (stage === 'adult') return 1;
    return this.r(`${stage}_${what}_factor` as RtRuleKey);
  }

  /** Work-time multiplier of a recipe from practice: 1 / (1 + gain × min(practice, max)). */
  skillFactor(e: Pick<RtEntity, 'skills'>, recipe: string): number {
    const level = Math.min(e.skills[recipe] ?? 0, Math.max(0, this.r('skill_max_level')));
    return 1 / (1 + Math.max(0, this.r('skill_gain_per_practice')) * level);
  }

  /** Health factor in [weak_speed_factor, 1]. */
  private vigor(e: RtEntity): number {
    const weak = clamp(this.r('weak_speed_factor'), 0, 1);
    return weak + (1 - weak) * clamp(e.hp / Math.max(1e-9, e.maxHp), 0, 1);
  }

  /** Walking speed in tiles per real second. */
  speedOf(e: RtEntity): number {
    const role = this.roleOf(e.role)?.moveFactor ?? 1;
    return round2(this.r('base_move_speed') * this.r('game_minutes_per_real_second') * role * this.vigor(e) * this.ageFactor(e, 'move'));
  }

  workSpeedOf(e: RtEntity): number {
    return this.r('base_work_speed') * (this.roleOf(e.role)?.workFactor ?? 1) * this.vigor(e) * this.ageFactor(e, 'work');
  }

  private execContext(): ExecContext {
    return {
      path: (from, to) => this.path(from, to),
      locate: (who) => {
        const t = this.find(who);
        return t && t.alive ? tileOf(t) : undefined;
      },
      durations: { gather: this.r('gather_minutes'), build: this.r('build_minutes'), eat: this.r('eat_minutes'), experiment: this.r('experiment_minutes'), use: this.r('use_minutes') },
      craftMinutes: (code, who) => {
        const minutes = this.catalog.recipes.get(code)?.minutes;
        return minutes === undefined ? undefined : minutes * (who ? this.skillFactor(who as RtEntity, code) : 1);
      },
      maxWaitMinutes: Math.max(1, this.r('plan_horizon_minutes')),
    };
  }

  // ---- actions (instant effects) ----------------------------------------------

  private winterFactor(): number {
    return this.season() === 'winter' ? this.r('winter_food_yield_multiplier') : 1;
  }

  /** Tiles from the centre of the world (where the wilds and the far resources begin). */
  distanceFromCenter(p: Point): number {
    return Math.max(Math.abs(p.x - Math.floor(this.width / 2)), Math.abs(p.y - Math.floor(this.height / 2)));
  }

  gather(e: RtEntity, resource: Resource, at: Point = tileOf(e)): ActResult {
    const t = this.tile(at.x, at.y);
    if (!t) return { ok: false, reason: 'outside' };
    if (!knownItem(this.catalog, resource)) return { ok: false, reason: 'unknown_item' };
    const tool = gatherTool(this.catalog, e, resource);
    const boost = tool?.boost ?? 1;
    let amount: number;
    if (resource === 'food' || resource === 'wood') {
      const base = this.r(resource === 'food' ? 'gather_food_yield' : 'gather_wood_yield');
      amount = Math.floor(Math.min(base * boost * this.winterFactor(), t[resource]));
      if (amount < 1) return { ok: false, reason: 'not_enough' };
      t[resource] = round2(t[resource] - amount);
      this.onEvent({ type: 'tile', tile: t });
    } else {
      const def = this.catalog.resources.get(resource);
      if (!def) return { ok: false, reason: 'unknown_item' };
      if (!this.canGatherAt(resource, t)) return { ok: false, reason: 'not_here' };
      amount = Math.floor(def.gatherYield * boost * this.winterFactor());
      if (amount < 1) return { ok: false, reason: 'not_enough' };
    }
    addItems(e, resource, amount, this.catalog.resources.get(resource));
    if (tool) this.wear(e, tool.tool);
    return { ok: true, amount };
  }

  private wear(e: RtEntity, tool: ToolInstance): void {
    if (wearTool(e, tool, this.r('tool_wear_per_use'))) this.onEvent({ type: 'decay', id: e.id, item: tool.item, amount: 1, reason: 'broken' });
  }

  craft(e: RtEntity, recipe: string): ActResult {
    if (typeof recipe !== 'string' || !this.catalog.recipes.has(recipe)) return { ok: false, reason: 'unknown_recipe' };
    const here = tileOf(e);
    const t = this.tile(here.x, here.y);
    if (!t) return { ok: false, reason: 'outside' };
    const check = canCraft(this.catalog, e, recipe, { stations: stationsOf(t), discovered: new Set(this.discovered.keys()) });
    if ('error' in check) return { ok: false, reason: check.error };
    if (this.stageOf(e) === 'child' && tooComplexForChild(check.recipe, this.r('child_max_recipe_inputs'))) return { ok: false, reason: 'too_young' };
    const out = applyCraft(this.catalog, e, check.recipe, this.r('tool_wear_per_use'));
    for (const [k] of Object.entries(out.structures)) t.structures[k] = this.catalog.resources.get(k)?.durability || 1;
    if (Object.keys(out.structures).length) this.onEvent({ type: 'tile', tile: t });
    this.onEvent({ type: 'craft', id: e.id, recipe, inputs: out.inputs, outputs: out.outputs, at: here, broken: out.broken });
    for (const b of out.broken) this.onEvent({ type: 'decay', id: e.id, item: b, amount: 1, reason: 'broken' });
    const before = Math.min(e.skills[recipe] ?? 0, this.r('skill_max_level'));
    e.skills[recipe] = (e.skills[recipe] ?? 0) + 1;
    const level = Math.min(e.skills[recipe], this.r('skill_max_level'));
    if (level !== before) this.onEvent({ type: 'skill', id: e.id, recipe, level });
    return { ok: true, amount: 1 };
  }

  experiment(e: RtEntity, items: string[], minItems: number): ActResult {
    const out = experiment(this.catalog, e, items, new Set(this.discovered.keys()), minItems);
    if (!out.ok) return { ok: false, reason: out.error };
    this.onEvent({ type: 'experiment', id: e.id, items: Object.keys(out.consumed), ...(out.found ? { found: out.found } : {}) });
    return { ok: true };
  }

  use(e: RtEntity, item: string): ActResult {
    const fx = useEffect(this.catalog, e, item);
    if ('error' in fx) return { ok: false, reason: fx.error };
    addItems(e, item, -1, fx.def);
    e.hunger = round2(Math.max(0, e.hunger - fx.def.nourish));
    const hp = e.hp;
    e.hp = Math.min(e.maxHp, e.hp + fx.def.heal);
    this.logBody(e, 'remedy', e.hp - hp);
    this.onEvent({ type: 'used', id: e.id, item });
    return { ok: true, amount: 1 };
  }

  eat(e: RtEntity, amount?: number, item?: string): ActResult {
    if (e.hunger <= 0) return { ok: false, reason: 'not_hungry' };
    const food = item ?? defaultFood(this.catalog, e) ?? 'food';
    const per = this.catalog.resources.get(food)?.nourish ?? (food === 'food' ? 1 : 0);
    if (per <= 0) return { ok: false, reason: 'not_usable' };
    if (count(e, food) < 1) return { ok: false, reason: 'no_food' };
    const want = Math.max(1, Math.floor(amount ?? Math.ceil(e.hunger / per)));
    const n = Math.min(want, Math.floor(count(e, food)), Math.ceil(e.hunger / per));
    addItems(e, food, -n, this.catalog.resources.get(food));
    e.hunger = round2(Math.max(0, e.hunger - n * per));
    this.bodyLog(e).ate += n;
    return { ok: true, amount: n };
  }

  build(e: RtEntity, at: Point = tileOf(e)): ActResult {
    const t = this.tile(at.x, at.y);
    if (!t || !this.walkable(t.x, t.y)) return { ok: false, reason: 'cannot_build_here' };
    if (t.shelter >= this.r('max_shelter_level')) return { ok: false, reason: 'shelter_max' };
    const cost = this.r('shelter_wood_cost');
    if (e.inventory.wood < cost) return { ok: false, reason: 'not_enough_wood' };
    e.inventory.wood = round2(e.inventory.wood - cost);
    t.shelter++;
    this.onEvent({ type: 'tile', tile: t });
    this.onEvent({ type: 'build', id: e.id, x: t.x, y: t.y, level: t.shelter });
    return { ok: true, amount: t.shelter };
  }

  give(e: RtEntity, to: string, resource: Resource, amount: number): ActResult {
    if (!knownItem(this.catalog, resource)) return { ok: false, reason: 'unknown_item' };
    if (this.r('sharing_allowed') < 1) return { ok: false, reason: 'giving_forbidden' };
    const b = this.find(to);
    if (!b || !b.alive || b.id === e.id) return { ok: false, reason: 'no_such_person' };
    if (Math.hypot(b.x - e.x, b.y - e.y) > this.move.interactRange) return { ok: false, reason: 'too_far' };
    const n = transfer(this.catalog, e, b, resource, amount);
    if (n < 1) return { ok: false, reason: 'nothing_to_give' };
    this.onEvent({ type: 'gave', from: e.id, to: b.id, resource, amount: n });
    return { ok: true, amount: n };
  }

  /** Speech reaches everyone within speech_radius. A named listener must be in range. */
  say(e: RtEntity, to: string, text: string): ActResult {
    const radius = this.r('speech_radius');
    const near = this.living().filter((b) => b.id !== e.id && Math.hypot(b.x - e.x, b.y - e.y) <= radius);
    const all = !to || to.trim().toLowerCase() === 'all';
    const target = all ? undefined : this.find(to);
    if (!all && (!target || !target.alive)) return { ok: false, reason: 'no_such_person' };
    if (target && !near.includes(target)) return { ok: false, reason: 'too_far' };
    const item: InboxItem = { from: e.id, fromName: e.name, to: target?.id ?? 'all', text, day: this.day, minute: this.minute };
    for (const b of near) this.deliver(b, item);
    this.onEvent({ type: 'say', from: e.id, to: item.to, text, hearers: near.map((b) => b.id) });
    return { ok: true };
  }

  // ---- simulation step ----------------------------------------------------------

  /** Advances the world by `dtSeconds` of real time. */
  step(dtSeconds: number, nowMs: number): void {
    const minutes = dtSeconds * Math.max(0, this.r('game_minutes_per_real_second')) * this.timeScale;
    this.clock += minutes;
    this.calendar();
    const ctx = this.execContext();
    for (const e of this.living()) {
      if (e.kind === 'player') this.movePlayer(e, dtSeconds);
      else this.runPlan(e, dtSeconds * this.timeScale, minutes, ctx);
      this.body(e, minutes, nowMs);
      if (e.alive && e.kind !== 'player') this.age(e);
      if (e.alive) for (const [item, n] of Object.entries(spoil(this.catalog, e, e.spoilAcc, minutes, DAY_MINUTES))) this.onEvent({ type: 'decay', id: e.id, item, amount: n, reason: 'spoiled' });
    }
    this.wearTiles(minutes);
  }

  private age(e: RtEntity): void {
    const stage = this.stageOf(e);
    if (stage === e.stage) return;
    e.stage = stage;
    this.onEvent({ type: 'aged', id: e.id, stage });
  }

  /** Shelters and structures wear with the days. */
  private wearTiles(minutes: number): void {
    const shelterRate = this.r('shelter_decay_per_day') * (minutes / DAY_MINUTES);
    for (const t of this.tiles) {
      if (t.shelter <= 0 && !Object.keys(t.structures).length) continue;
      let changed = false;
      if (t.shelter > 0 && shelterRate > 0) {
        t.shelterWear += shelterRate;
        if (t.shelterWear >= 1) {
          t.shelterWear -= 1;
          t.shelter--;
          changed = true;
          this.onEvent({ type: 'decay', id: `tile:${t.x},${t.y}`, item: 'shelter', amount: 1, reason: 'worn' });
        }
      }
      for (const gone of wearStructures(this.catalog, t.structures, minutes, DAY_MINUTES)) {
        changed = true;
        this.onEvent({ type: 'decay', id: `tile:${t.x},${t.y}`, item: gone, amount: 1, reason: 'worn' });
      }
      if (changed) this.onEvent({ type: 'tile', tile: t });
    }
  }

  private calendar(): void {
    const season = this.season();
    if (season !== this.lastSeason) {
      if (this.lastSeason) this.onEvent({ type: 'season', season });
      this.lastSeason = season;
    }
    const night = this.isNight();
    if (night !== this.lastNight) {
      if (this.lastNight !== undefined) this.onEvent({ type: 'night', night });
      this.lastNight = night;
    }
    const turn = this.turn;
    if (this.lastTurn < 0) this.lastTurn = turn;
    while (this.lastTurn < turn) {
      this.lastTurn++;
      this.regrow();
      this.births();
    }
  }

  private movePlayer(e: RtEntity, dt: number): void {
    if (e.busyUntilMinute !== undefined && this.clock < e.busyUntilMinute) return;
    e.busyUntilMinute = undefined;
    const { dx, dy } = e.input;
    if (!dx && !dy) {
      if (e.anim === 'walk' || e.anim === 'work' || e.anim === 'eat') e.anim = 'idle';
      return;
    }
    const step = this.speedOf(e) * dt;
    const nx = clamp(e.x + dx * step, 0, this.width - 1);
    const ny = clamp(e.y + dy * step, 0, this.height - 1);
    if (this.walkable(Math.round(nx), Math.round(e.y))) e.x = nx;
    if (this.walkable(Math.round(e.x), Math.round(ny))) e.y = ny;
    e.anim = 'walk';
    e.dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n';
  }

  private runPlan(e: RtEntity, dt: number, minutes: number, ctx: ExecContext): void {
    const plan = e.plan;
    if (!plan || plan.current >= plan.steps.length) {
      if (e.anim !== 'sleep') e.anim = 'idle';
      return;
    }
    const step = plan.steps[plan.current]!;
    if (!e.activity) {
      const prepared = prepareStep(step, e, ctx);
      if ('error' in prepared) return this.failStep(e, prepared.error);
      e.activity = prepared.activity;
    }
    if (!advance(e.activity, e, dt, this.speedOf(e), minutes, this.workSpeedOf(e), this.move.arriveEpsilon)) return;
    e.activity = undefined;
    const out = this.complete(e, step.action, step.args);
    if (!out.ok) return this.failStep(e, out.reason ?? 'failed');
    this.nextStep(e);
  }

  private complete(e: RtEntity, action: string, args: Record<string, unknown>): ActResult {
    switch (action) {
      case 'gather':
        return this.gather(e, String(args.resource));
      case 'eat':
        return this.eat(e, typeof args.amount === 'number' ? args.amount : undefined, typeof args.item === 'string' ? args.item : undefined);
      case 'build':
        return this.build(e);
      case 'give':
        return this.give(e, String(args.to), String(args.item ?? args.resource), Number(args.amount));
      case 'craft':
        return this.craft(e, String(args.recipe));
      case 'experiment':
        return this.experiment(e, Array.isArray(args.items) ? args.items.map(String) : [], this.minExperimentItems);
      case 'use':
        return this.use(e, String(args.item));
      case 'say':
        return this.say(e, String(args.to ?? 'all'), String(args.text ?? ''));
      case 'offer':
        return this.offerHook ? this.offerHook(e, String(args.to ?? ''), args.give, args.want) : { ok: false, reason: 'failed' };
      default:
        return { ok: true };
    }
  }

  private nextStep(e: RtEntity): void {
    const plan = e.plan!;
    plan.current++;
    this.onEvent({ type: 'step', id: e.id, current: plan.current });
    if (plan.current >= plan.steps.length) {
      e.anim = 'idle';
      this.onEvent({ type: 'plan_done', id: e.id });
    }
  }

  private failStep(e: RtEntity, reason: string): void {
    const plan = e.plan!;
    e.activity = undefined;
    this.onEvent({ type: 'step_failed', id: e.id, step: plan.current, reason });
    this.nextStep(e);
  }

  private body(e: RtEntity, minutes: number, nowMs: number): void {
    if (!e.alive || minutes <= 0) return;
    const perTurn = minutes / Math.max(1e-9, this.r('turn_minutes'));
    const threshold = this.r('starvation_threshold');
    const critHunger = this.r('critical_hunger');
    const critHp = this.r('critical_hp_fraction') * e.maxHp;
    const hungerBefore = e.hunger;
    const hpBefore = e.hp;
    e.maxHp = this.r('max_hp');
    e.hunger = round2(e.hunger + this.r('food_per_tick') * perTurn);
    let cause: 'starved' | 'frozen' | undefined;
    if (e.hunger > threshold) {
      const dmg = this.r('starvation_damage') * perTurn;
      e.hp -= dmg;
      this.logBody(e, 'starved', -dmg);
      cause = 'starved';
    }
    const sheltered = this.isSheltered(e);
    const cold = this.season() === 'winter' && !sheltered ? this.r('cold_damage_unsheltered') : 0;
    const wild = !sheltered && this.distanceFromCenter(tileOf(e)) > this.r('wild_distance') ? this.r('wild_damage') : 0;
    const exposure = cold + wild;
    if (exposure > 0) {
      const guard = protectionOf(this.catalog, e);
      const dmg = exposure * (1 - guard.share) * perTurn;
      // A protective item wears with each turn it spends warding off harm.
      if (guard.tool) {
        guard.tool.durability -= this.r('tool_wear_per_use') * perTurn;
        if (guard.tool.durability <= 0) {
          guard.tool.durability = 0.001;
          this.wear(e, guard.tool);
        }
      }
      if (dmg > 0) {
        e.hp -= dmg;
        this.logBody(e, 'cold', -dmg * (cold / exposure));
        this.logBody(e, 'wild', -dmg * (wild / exposure));
        cause ??= 'frozen';
      }
    }
    const resting = e.anim === 'sleep' || (e.plan && ['rest', 'sleep'].includes(e.plan.steps[e.plan.current]?.action ?? ''));
    if (resting && e.hunger <= threshold && e.hp < e.maxHp) {
      const heal = Math.min(this.r('rest_heal') * perTurn, e.maxHp - e.hp);
      e.hp += heal;
      this.logBody(e, 'rest', heal);
    }
    e.hp = clamp(e.hp, 0, e.maxHp);
    if (e.hp <= 0) {
      this.kill(e.id, cause ?? 'other', nowMs);
      return;
    }
    if (hungerBefore < critHunger && e.hunger >= critHunger) this.onEvent({ type: 'critical', id: e.id, what: 'hunger' });
    if (hpBefore >= critHp && e.hp < critHp) this.onEvent({ type: 'critical', id: e.id, what: 'hp' });
  }

  private regrow(): void {
    const rate = this.r('regrowth_per_tick') * this.winterFactor();
    if (rate <= 0) return;
    for (const t of this.tiles) {
      const cap = this.map.capacity[t.biome];
      const food = round2(Math.min(cap.food, t.food + cap.food * rate));
      const wood = round2(Math.min(cap.wood, t.wood + cap.wood * rate));
      if (food !== t.food || wood !== t.wood) {
        t.food = food;
        t.wood = wood;
        this.onEvent({ type: 'tile', tile: t });
      }
    }
  }

  private births(): void {
    const cost = this.r('birth_food_cost');
    const threshold = this.r('starvation_threshold');
    const year = Math.max(1, Math.round(this.r('winter_every_ticks')));
    const turn = this.lastTurn;
    const ready = this.living().filter((a) => a.kind !== 'player' && a.hunger <= threshold && turn - a.lastBirthTurn >= year && this.isSheltered(a));
    const used = new Set<string>();
    for (const a of ready) {
      if (used.has(a.id)) continue;
      const ta = tileOf(a);
      const b = ready.find((p) => p.id !== a.id && !used.has(p.id) && tileOf(p).x === ta.x && tileOf(p).y === ta.y && a.inventory.food + p.inventory.food >= cost);
      if (!b) continue;
      if (this.living().length >= this.map.maxPopulation) return;
      const parent = this.rng.next() < 0.5 ? a : b;
      const spec = this.childOf ? this.childOf(a, b, () => this.rng.next()) : { tier: parent.tier, model: parent.model, kind: parent.kind };
      if (!spec) continue;
      const fromA = Math.min(a.inventory.food, Math.max(cost / 2, cost - b.inventory.food));
      a.inventory.food = round2(a.inventory.food - fromA);
      b.inventory.food = round2(b.inventory.food - (cost - fromA));
      a.lastBirthTurn = b.lastBirthTurn = turn;
      used.add(a.id).add(b.id);
      const child = this.spawn({ name: this.childName(), role: parent.role, ...spec, ageDays: 0, parents: [a.id, b.id] }, ta);
      child.lastBirthTurn = turn;
      this.onEvent({ type: 'birth', child, parents: [a.id, b.id] });
    }
  }

  private childName(): string {
    const free = this.namePool.filter((n) => !this.namesUsed.has(n) && !this.nameTaken(n));
    return free.length ? this.rng.pick(free) : `${this.namePool[0] ?? 'N'}${this.nextId}`;
  }
}
