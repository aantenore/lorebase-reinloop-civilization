export type Biome = 'grass' | 'forest' | 'water' | 'rock';
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type Tier = 'opus' | 'sonnet' | 'haiku';
export type Resource = 'food' | 'wood';
export type AgentStatus = 'idle' | 'thinking' | 'acting' | 'dead';
export type WorldEventKind = 'birth' | 'death' | 'build' | 'season' | 'starvation' | 'cold' | 'rules';

/** Numeric rule values keyed by rule key, as loaded from Lorebase. */
export type Rules = Record<string, number>;

export interface Tile {
  x: number;
  y: number;
  biome: Biome;
  food: number;
  wood: number;
  shelter: boolean;
}

export interface Inventory {
  food: number;
  wood: number;
}

export interface InboxMessage {
  tick: number;
  from: string;
  fromName: string;
  to: string;
  text: string;
}

export interface AgentSpec {
  id?: string;
  name: string;
  role: string;
  tier: Tier;
  model: string;
  personality?: string;
}

export interface AgentState {
  id: string;
  name: string;
  role: string;
  tier: Tier;
  model: string;
  personality: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  hunger: number;
  inventory: Inventory;
  alive: boolean;
  status: AgentStatus;
  thought: string;
  lastAction: string | null;
  generation: number;
  actionsLeft: number;
  inbox: InboxMessage[];
  lastBirthTick: number;
  bornTick: number;
}

export interface WorldEvent {
  tick: number;
  kind: WorldEventKind;
  text: string;
}

export interface TierStats {
  alive: number;
  avgHp: number;
}

export interface Stats {
  tick: number;
  population: number;
  food: number;
  wood: number;
  shelters: number;
  avgHp: number;
  byTier: Record<Tier, TierStats>;
}

export interface ActionResult {
  ok: boolean;
  text: string;
  tiles?: Tile[];
  message?: InboxMessage;
  events?: WorldEvent[];
}

export interface TickOutcome {
  events: WorldEvent[];
  births: AgentState[];
  deaths: AgentState[];
  tiles: Tile[];
}

export interface BiomeCapacity {
  food: number;
  wood: number;
}

/** World generation settings (config/sim.json `world`). Not gameplay rules: those come from Lorebase. */
export interface WorldGenConfig {
  width: number;
  height: number;
  /** Size in tiles of the noise cells used to shape biomes. */
  noiseScale: number;
  /** Elevation below which a tile is water, above which it is rock. */
  waterBelow: number;
  rockAbove: number;
  /** Moisture above which a land tile is forest. */
  forestAbove: number;
  capacity: Record<Biome, BiomeCapacity>;
  /** Fraction of capacity present at generation, [min, max]. */
  initialFill: [number, number];
  /** Radius around the centre where the first agents spawn. */
  spawnRadius: number;
  maxPopulation: number;
  namePool: string[];
}

export const TIERS: readonly Tier[] = ['opus', 'sonnet', 'haiku'];
