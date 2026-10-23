// Backend contract types (server → UI).

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type Biome = 'grass' | 'forest' | 'water' | 'rock';
export type Role = 'gatherer' | 'builder' | 'explorer' | 'elder' | 'healer' | string;
export type Tier = 'opus' | 'sonnet' | 'haiku';
export const TIERS: Tier[] = ['opus', 'sonnet', 'haiku'];

export interface Tile {
  x: number;
  y: number;
  biome: Biome;
  food: number;
  wood: number;
  shelter: boolean;
}

export interface World {
  w: number;
  h: number;
  tiles: Tile[];
}

export interface Agent {
  id: string;
  name: string;
  role: Role;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  hunger: number;
  inventory: { food: number; wood: number };
  alive: boolean;
  sheltered: boolean;
  status: 'idle' | 'thinking' | 'acting' | 'dead';
  thought: string;
  lastAction: string | null;
  generation: number;
  model?: string;
  tier?: Tier;
}

export interface Rule {
  key: string;
  value: number;
  text: string;
  category: string;
  unit: string;
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
  byTier?: Partial<Record<Tier, TierStats>>;
}

export interface LorebaseStatus {
  connected: boolean;
  url: string;
  domain: string;
  branch: string;
  revision: string;
}

export interface SimStatus {
  running: boolean;
  tick: number;
  tickMs: number;
  provider: 'anthropic' | 'mock' | string;
  model: string;
  lorebase: LorebaseStatus;
}

export interface RuleChange {
  key: string;
  old: number;
  new: number;
  text?: string;
}

export type WorldEventKind = 'birth' | 'death' | 'build' | 'season' | 'starvation' | 'cold' | 'rules';

export type ServerEvent =
  | {
      type: 'snapshot';
      tick: number;
      season: Season;
      world: World;
      agents: Agent[];
      rules: Rule[];
      history: Stats[];
      status: SimStatus;
      roster?: RosterEntry[];
    }
  | { type: 'tick'; tick: number; season: Season; stats: Stats }
  | { type: 'agent_update'; agent: Agent }
  | { type: 'agent_thought'; agentId: string; delta: string }
  | { type: 'agent_action'; agentId: string; tick: number; tool: string; args: unknown; result: unknown; ok: boolean }
  | { type: 'message'; tick: number; from: string; to: string; text: string }
  | { type: 'world_event'; tick: number; kind: WorldEventKind; text: string }
  | { type: 'tile_update'; x: number; y: number; food: number; wood: number; shelter: boolean }
  | { type: 'rules_changed'; revision: string; source: 'lorebase' | string; changes: RuleChange[] }
  | { type: 'status'; status: SimStatus };

export interface Scenario {
  name: string;
  title: string;
  description: string;
  changes: { key: string; value: number }[];
}

export type RuleMode = 'direct' | 'proposal';

export interface RuleWriteResult {
  ok: boolean;
  revision?: string;
  proposalId?: string;
  error?: string;
}

export interface RosterEntry {
  id?: string;
  name: string;
  role: Role;
  tier: Tier;
  model?: string;
  personality?: string;
}

export interface RosterInfo {
  agents: RosterEntry[];
  models: Record<Tier, string>;
  roles: string[];
}

export interface OkResult {
  ok: boolean;
  error?: string;
}
