/**
 * Wire protocol between the world server and the game client.
 * WebSocket at `/ws`, JSON text frames, every message has a `type` discriminator.
 * This file has no runtime dependencies so the server can import or copy it as-is.
 */

export type Biome = 'grass' | 'forest' | 'water' | 'rock' | 'sand';
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type Tier = 'opus' | 'sonnet' | 'haiku' | 'human';
export type EntityKind = 'agent' | 'player' | 'crowd';
export type Dir = 'n' | 'e' | 's' | 'w';
export type Anim = 'idle' | 'walk' | 'work' | 'sleep' | 'eat';
/**
 * orchestrator: clan, a leader splits the plan · council: parallel proposals, an elder harmonizes ·
 * router: guild, a dispatcher routes each situation to a specialist · chain: expedition, scout -> planner -> doer ·
 * mentor: apprentice plans, mentor critiques and revises · assembly: everyone proposes, majority vote ·
 * crowd: one mind drives many extras.
 */
export type GroupPattern = 'orchestrator' | 'council' | 'router' | 'chain' | 'mentor' | 'assembly' | 'crowd';

export interface DecisionTraceEntry {
  /** Entity id. */
  member: string;
  role: 'proposer' | 'critic' | 'router' | 'leader' | 'voter';
  text: string;
}

export interface GroupDecision {
  summary: string;
  trace: DecisionTraceEntry[];
}
export type ShelterLevel = 0 | 1 | 2;

/** Item code -> amount. Always carries `food` and `wood`; any other resource code may appear. */
export type ItemBag = Record<string, number>;
export type Inventory = ItemBag & { food: number; wood: number };

/** A tool being carried; it wears out with use. */
export interface ToolState {
  item: string;
  durability: number;
  max: number;
}

/** Game clock stamp. */
export interface GameTime {
  day: number;
  minute: number;
}

export interface TilePos {
  x: number;
  y: number;
}

export interface Tile {
  x: number;
  y: number;
  biome: Biome;
  /** Integer height step; 0 = water level. */
  elev: number;
  food: number;
  wood: number;
  shelter: ShelterLevel;
}

export interface MapData {
  w: number;
  h: number;
  /** Row-major is not required: each tile carries its own x/y. */
  tiles: Tile[];
}

export interface Entity {
  id: string;
  name: string;
  role: string;
  tier: Tier;
  /** Tier of the model actually in use (differs from `tier` under a model override); display only. */
  effectiveTier?: Tier;
  model: string;
  kind: EntityKind;
  groupId: string | null;
  /** Float tile coordinates; integer values are tile CENTRES (tile (i,j) covers [i-0.5, i+0.5)). */
  x: number;
  y: number;
  dir: Dir;
  anim: Anim;
  hp: number;
  maxHp: number;
  hunger: number;
  inventory: Inventory;
  tools?: ToolState[];
  /** Tiles per second. */
  speed: number;
  alive: boolean;
  /** Society fields (absent on servers without the society layer). */
  age?: Age;
  /** 0-1 standing in the eyes of the others. */
  esteem?: number;
  fame?: number;
  /** 1 = most esteemed. */
  rank?: number;
  family?: string | null;
  /** Ids of the two parents (they may be dead and no longer entities). */
  parents?: [string, string] | null;
}

export interface Group {
  id: string;
  name: string;
  pattern: GroupPattern;
  members: string[];
  leader: string | null;
  /** CSS hex colour, e.g. "#e0a030". */
  color: string;
  /** How the group reached its latest joint plan. */
  lastDecision?: GroupDecision;
}

export type RuleValue = number | string | boolean;

export interface Rule {
  key: string;
  value: RuleValue;
  text: string;
  category: string;
  unit: string;
}

export interface WorldTime {
  day: number;
  /** 0-1439 */
  minute: number;
  season: Season;
}

export interface LorebaseStatus {
  connected: boolean;
  branch: string;
  revision: string;
}

export interface PlanStep {
  action: string;
  /** Free-form. For group plans `args.who` (entity id) names the member doing the step. */
  args: Record<string, unknown>;
  label: string;
}

// ---------------------------------------------------------------- society

export type AgeStage = 'child' | 'adult' | 'elder';

export interface Age {
  stage: AgeStage;
  /** Age in game days. */
  days: number;
}

/** Everyone who ever lived, entities or not (`alive: false` for the dead). */
export interface Person {
  id: string;
  name: string;
  role: string;
  tier: Tier;
  /** See Entity.effectiveTier. */
  effectiveTier?: Tier;
  age: Age;
  esteem: number;
  fame: number;
  rank: number;
  family: string | null;
  parents: [string, string] | null;
  alive: boolean;
}

export interface Family {
  id: string;
  name: string;
  /** Person id. */
  founder: string;
  members: string[];
  /** Living members. */
  alive: number;
  esteem: number;
  /** From the server's palette (config); clients fall back to their own when absent. */
  color?: string;
}

/** How much `from` esteems `to` (-1..1). Only sent to authorized (god) clients. */
export interface Opinion {
  from: string;
  to: string;
  score: number;
}

export interface Society {
  people: Person[];
  families: Family[];
  opinions?: Opinion[];
}

export type LawProposalStatus = 'open' | 'merged' | 'rejected';
export type OfferStatus = 'pending' | 'accepted' | 'rejected' | 'expired';
/** `barter`: give for want; `ask`: want only, nothing given (a gift when accepted). */
export type OfferKind = 'barter' | 'ask';

export interface EntityDelta {
  id: string;
  x: number;
  y: number;
  dir: Dir;
  anim: Anim;
  hp: number;
  hunger: number;
  inventory?: Inventory;
  tools?: ToolState[];
  alive: boolean;
}

// ---------------------------------------------------------------- economy

export interface Resource {
  code: string;
  name: string;
  perishable: boolean;
}

export interface Recipe {
  code: string;
  name: string;
  inputs: ItemBag;
  outputs: ItemBag;
  /** Role that knows the recipe. */
  role: string;
  /** Technology that unlocked it (null: known from the start). */
  tech: string | null;
  /** Required station (null: by hand). */
  station: string | null;
}

export interface Tech {
  code: string;
  /** '???' while undiscovered. */
  name: string;
  description: string;
  discovered: boolean;
  discoveredBy: string | null;
  discoveredAt: GameTime | null;
  /** Recipe codes (or tech codes) unlocked by this technology. */
  unlocks: string[];
}

/** Discovered recipes only; `hiddenRecipes` counts the ones still unknown. */
export interface Economy {
  resources: Resource[];
  recipes: Recipe[];
  techs: Tech[];
  hiddenRecipes: number;
}

export interface FlowEdge {
  fromRole: string;
  toRole: string;
  item: string;
  amount: number;
}

// ---------------------------------------------------------------- minds

export type InsightStatus = 'proposed' | 'accepted' | 'retired' | 'rejected';

/** A piece of a role's shared consciousness, versioned in Lorebase. `author`/`reviewer` are names. */
export interface Insight {
  code: string;
  role: string;
  text: string;
  confidence: number;
  author: string;
  reviewer?: string;
  day: number;
  evidence?: string;
  status: InsightStatus;
}

export type MemoryKind = 'episodic' | 'gist';
export type MemoryAction = 'added' | 'blurred' | 'merged' | 'forgotten' | 'recalled';

/** One private memory of an agent (never written to Lorebase). Fidelity fades with time. */
export interface Memory {
  id: string;
  text: string;
  /** 0-1: 1 = vivid, near 0 = about to be forgotten. */
  fidelity: number;
  importance: number;
  emotion: string | number;
  kind: MemoryKind;
  createdAt: GameTime;
  recalls: number;
}

export type WorldEventKind = 'birth' | 'death' | 'build' | 'season' | 'starvation' | 'cold' | 'rules' | 'group';

export interface RuleChange {
  key: string;
  old: RuleValue;
  new: RuleValue;
  text: string;
  /** Present when the law was retired/deleted. */
  removed?: boolean;
  /** Present when the law was created or re-categorized. */
  category?: string;
  unit?: string;
}

// ---------------------------------------------------------------- server -> client

export interface HelloMsg {
  type: 'hello';
  you: { entityId: string } | null;
  map: MapData;
  entities: Entity[];
  groups: Group[];
  rules: Rule[];
  time: WorldTime;
  roles: string[];
  lorebase: LorebaseStatus;
  /** Absent on servers without the economy. */
  economy?: Economy;
  /** Absent on servers without the society layer. */
  society?: Society;
}
export interface StateMsg { type: 'state'; t: number; entities: EntityDelta[] }
export interface EntityAddedMsg { type: 'entity_added'; entity: Entity }
export interface EntityRemovedMsg { type: 'entity_removed'; id: string; reason: string }
export interface ThinkingMsg { type: 'thinking'; id: string; on: boolean }
export interface PlanMsg {
  type: 'plan';
  /** Entity id or group id, depending on scope. */
  id: string;
  scope: 'entity' | 'group';
  steps: PlanStep[];
  current: number;
  reason: string;
  createdAt: number;
}
export interface PlanProgressMsg { type: 'plan_progress'; id: string; current: number }
export interface SayMsg { type: 'say'; from: string; to: string | 'all'; text: string; kind: 'speech' | 'thought' }
/** Streamed reply (to the player). The message with `done: true` closes the utterance; no extra `say` is needed. */
export interface SayDeltaMsg { type: 'say_delta'; from: string; to: string; delta: string; done: boolean }
export interface GroupMsg { type: 'group'; group: Group }
export interface GroupRemovedMsg { type: 'group_removed'; id: string }
export interface TileMsg { type: 'tile'; x: number; y: number; food: number; wood: number; shelter: ShelterLevel }
export interface TimeMsg { type: 'time'; day: number; minute: number; season: Season }
export interface WorldEventMsg { type: 'world_event'; kind: WorldEventKind; text: string; at?: { x: number; y: number } }
export interface RulesChangedMsg { type: 'rules_changed'; revision: string; changes: RuleChange[] }
export interface LorebaseMsg { type: 'lorebase'; connected: boolean; branch: string; revision: string }
export interface InsightMsg { type: 'insight'; insight: Insight; action: 'proposed' | 'accepted' | 'rejected' | 'retired'; reviewer?: string }
/** An agent consulted Lorebase; `query` is a short summary of what it asked. */
export interface ConsultMsg { type: 'consult'; agentId: string; tool: string; query: string }
export interface CraftMsg { type: 'craft'; by: string; recipe: string; inputs: ItemBag; outputs: ItemBag; at: TilePos }
export interface TradeMsg { type: 'trade'; from: string; to: string; give: ItemBag; get: ItemBag; kind: 'gift' | 'barter' }
export interface DiscoveryMsg {
  type: 'discovery';
  tech: { code: string; name: string; description: string; unlocks: string[] };
  by: string;
  role: string;
  /** Where (tile) or when (clock) it happened. */
  at?: TilePos | GameTime;
}
/** `id` is the holder (entity id). */
export interface DecayMsg { type: 'decay'; id: string; item: string; amount: number; reason: 'spoiled' | 'broken' | 'worn' }
/** Goods moved between roles over the last `window` (seconds of real time). */
export interface FlowsMsg { type: 'flows'; window: number; edges: FlowEdge[] }
export interface MemoryMsg {
  type: 'memory';
  agentId: string;
  action: MemoryAction;
  memory: Memory;
  /** For `merged`: ids of the memories folded into `memory` (optional). */
  mergedFrom?: string[];
}

/** One voice inside a group deliberation (the pattern's internal discussion). */
export interface DeliberationMsg {
  type: 'deliberation';
  groupId: string;
  pattern: GroupPattern;
  /** Entity id. */
  member: string;
  role: DecisionTraceEntry['role'];
  text: string;
}

export interface ReputationMsg { type: 'reputation'; people: { id: string; esteem: number; fame: number; rank: number }[] }
/** God/authorized clients only. */
export interface OpinionMsg { type: 'opinion'; from: string; to: string; score: number; reason: string }
export interface AgedMsg { type: 'aged'; id: string; stage: AgeStage }
export interface SkillMsg { type: 'skill'; id: string; recipe: string; level: number }
export interface FamilyMsg { type: 'family'; family: Family }
/** A law change proposed by an agent; it is reviewed (merged/rejected) in Lorebase. */
export interface LawProposalMsg {
  type: 'law_proposal';
  id: string;
  /** Entity id of the proposer. */
  by: string;
  text: string;
  key: string;
  category: string;
  value: RuleValue;
  branch: string;
  status: LawProposalStatus;
}
export interface OfferMsg {
  type: 'offer';
  id: string;
  /** Absent from older servers: barter. */
  kind?: OfferKind;
  from: string;
  to: string;
  give: Record<string, number>;
  want: Record<string, number>;
  status: OfferStatus;
}
/** Batched tile updates (`tile` stays valid for single updates). */
export interface TilesMsg { type: 'tiles'; items: { x: number; y: number; food: number; wood: number; shelter: ShelterLevel }[] }

export type ServerMsg =
  | HelloMsg
  | StateMsg
  | EntityAddedMsg
  | EntityRemovedMsg
  | ThinkingMsg
  | PlanMsg
  | PlanProgressMsg
  | SayMsg
  | SayDeltaMsg
  | GroupMsg
  | GroupRemovedMsg
  | TileMsg
  | TimeMsg
  | WorldEventMsg
  | RulesChangedMsg
  | LorebaseMsg
  | InsightMsg
  | ConsultMsg
  | CraftMsg
  | TradeMsg
  | DiscoveryMsg
  | DecayMsg
  | FlowsMsg
  | MemoryMsg
  | DeliberationMsg
  | ReputationMsg
  | OpinionMsg
  | AgedMsg
  | SkillMsg
  | FamilyMsg
  | LawProposalMsg
  | OfferMsg
  | TilesMsg;

// ---------------------------------------------------------------- client -> server

export interface JoinMsg { type: 'join'; name: string; role: string; token?: string }
/** Held movement vector in TILE space (x/y grid axes), length <= 1. Sent only when it changes; {0,0} = stop. */
export interface InputMsg { type: 'input'; dx: number; dy: number }
export type ActAction = 'gather' | 'chop' | 'build' | 'eat' | 'give';
/** args: `{x,y}` target tile for gather/chop/build; `{to, item:'food'|'wood', amount}` for give. */
export interface ActMsg { type: 'act'; action: ActAction; args: Record<string, unknown> }
export interface SpeakMsg { type: 'speak'; to: string; text: string }

export type ClientMsg = JoinMsg | InputMsg | ActMsg | SpeakMsg;

// ---------------------------------------------------------------- HTTP

/** POST /api/rules. The client never applies the value locally; it waits for `rules_changed`. */
export interface RuleEditRequest {
  key: string;
  value: RuleValue;
  mode: 'direct' | 'proposal';
  message: string;
}

/** GET /api/insights?role= */
export interface InsightList {
  pending: Insight[];
  stored: Insight[];
}
/** GET /api/consciousness : accepted insights grouped by role. */
export type Consciousness = Record<string, Insight[]>;
/** GET /api/agents/:id/memories (a bare array is accepted too). */
export interface MemoryList {
  memories: Memory[];
}
/** GET /api/society (opinions only for authorized clients). */
export type SocietyResponse = Society;
/** GET /api/economy */
export type EconomyResponse = Economy & { flows?: FlowEdge[] };

// ---------------------------------------------------------------- HTTP (god mode)

export type RuleMode = 'direct' | 'proposal';

/** POST /api/rules: create a law (or edit an existing key). */
export interface RuleCreateRequest {
  key: string;
  value?: RuleValue;
  text?: string;
  category?: string;
  unit?: string;
  mode: RuleMode;
  message: string;
}

/** PATCH /api/rules/:key */
export interface RulePatchRequest {
  value?: RuleValue;
  text?: string;
  category?: string;
  mode: RuleMode;
  message: string;
}

/** Response of a rule mutation (every field optional: the client waits for `rules_changed`). */
export interface RuleMutationResult {
  revision?: string;
  branch?: string;
  proposal?: { id: string; branch?: string; title?: string };
}

export type ConversationKind = 'speech' | 'thought' | 'deliberation';

/** GET /api/conversations?agent=&with=&group=&since=&limit= */
export interface ConversationLine {
  id: string;
  at: GameTime;
  from: string;
  to: string;
  text: string;
  kind: ConversationKind;
  groupId?: string;
}

/** GET /api/agents/:id/mind */
export interface AgentMind {
  agentId: string;
  plan?: { steps: PlanStep[]; current: number; reason: string } | null;
  thoughts?: { at: GameTime; text: string }[];
  consults?: { at: GameTime; tool: string; query: string }[];
  groupId?: string | null;
}

/** GET /api/observatory/summary. Nested values may vary by server version: render generically. */
export interface ObservatorySummary {
  lorebase?: { url?: string; domain?: string; branch?: string; revision?: string; counts?: Record<string, number> };
  mnemo?: {
    memories?: number;
    perAgent?: { agentId: string; name: string; count: number; avgFidelity: number; gists: number }[];
    dbBytes?: number;
    lastCompaction?: string | null;
  };
  reinloop?: {
    runs?: number;
    decisions?: number;
    groupDecisions?: number;
    failures?: number;
    tokens?: number | Record<string, unknown>;
    costUsd?: number | Record<string, unknown>;
  };
}

/** GET /api/observatory/log?limit= */
export interface LorebaseLogEntry {
  revision: string;
  message: string;
  time: string;
  kinds: string[];
}

/** GET /api/observatory/proposals?status= */
export interface ProposalInfo {
  id: string;
  title: string;
  branch: string;
  status: string;
  author?: string;
}
