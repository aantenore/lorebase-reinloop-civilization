// Real-time world settings: config/game.json (GAME_CONFIG overrides the path). Gameplay numbers
// are Lorebase Rules; this file holds engine, decision, player and group knobs.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ModelParams } from 'reinloop';
import { ROOT } from '../config.ts';
import type { Tier } from '../world/types.ts';
import type { EconomyConfig } from './economy-book.ts';
import type { MapConfig, MovementConfig } from './world.ts';

export type GroupPattern = 'orchestrator' | 'council' | 'router' | 'chain' | 'mentor' | 'assembly' | 'crowd';
export const AGENT_PATTERNS: GroupPattern[] = ['orchestrator', 'council', 'router', 'chain', 'mentor', 'assembly'];

export interface TierDecision {
  /** Upper bound of the steps kept from one plan (cost control); the schema only suggests it. */
  maxSteps: number;
  /** Multiplies the Lorebase rule plan_horizon_minutes. */
  horizonFactor: number;
  /** Multiplies the Lorebase rule replan_cooldown_minutes. */
  cooldownFactor: number;
  maxTurns: number;
  maxOutputTokens: number;
  /** Lorebase consultations (MCP read tools) allowed per decision. */
  maxConsults: number;
}

export interface BrainConfig {
  /** Herald (Lorebase MCP server) endpoint; HERALD_URL overrides; empty disables. */
  mcpUrl: string;
  domain: string;
  tools: string[];
  cacheMs: number;
  callTimeoutMs: number;
  outputMaxChars: number;
  connectRetryMs: number;
  /** Tool arguments that would leave the pinned branch; removed from schemas and forced server-side. */
  branchArgs: string[];
}

export interface MemoryIngest {
  importance: number;
  emotion: number;
}

export interface MemoryConfig {
  /** mnemo, the private memory service; MNEMO_URL overrides; disabled: no private memory. */
  enabled: boolean;
  url: string;
  timeoutMs: number;
  pollMs: number;
  recallLimit: number;
  textMaxChars: number;
  /** Index accepted insights and Chronicle entries for `ricorda_mondo`. */
  worldIndex: boolean;
  /** Keep reinloop run logs in mnemo (best effort). */
  runStore: boolean;
  runFlushMs: number;
  /** Retries of a request that found nothing listening, with exponential backoff from retryBaseMs. */
  retries: number;
  retryBaseMs: number;
  ingest: Record<string, MemoryIngest>;
}

export interface ServicesConfig {
  herald: { autoStart: boolean; script: string; healthUrl: string; stopOnExit: boolean };
  mnemo: { autoStart: boolean; entry: string; healthUrl: string; readyTimeoutMs: number; pollMs: number };
}

export interface InsightConfig {
  enabled: boolean;
  kind: string;
  operation: string;
  updateOperation: string;
  branchPrefix: string;
  autoAcceptMinutes: number;
  maxPendingPerRole: number;
  textMaxChars: number;
  listMax: number;
  /** At startup: `reload` open insight Proposals into the review queue (closing those older than maxAgeHours), or `close` them all. */
  reconcile: { mode: 'reload' | 'close'; maxAgeHours: number };
}

export interface BarterConfig {
  enabled: boolean;
  /** How often pending offers are checked for expiry (real ms). */
  checkMs: number;
  textMaxChars: number;
}

export interface SocietyConfig {
  enabled: boolean;
  /** `reputation` broadcast period (real ms); esteem, fame and ranks are recomputed then. */
  broadcastMs: number;
  maxOpinions: number;
  reasonMaxChars: number;
  /** What people hear about each other (bands of esteem and fame, never numbers). */
  hearsay: { perPerson: number; maxKept: number; lowBelow: number; highAbove: number; famousAbove: number };
  /** Laws proposed by agents: a branch + Proposal in Lorebase, never merged by the world. */
  lawProposals: { branchPrefix: string; textMaxChars: number; pollMs: number; maxOpen: number; defaultValue: number };
  /** Family records (Kind) written in batches like the Chronicle. */
  families: { kind: string; flushMs: number };
}

export type ReplanTrigger = 'planExhausted' | 'stepFailed' | 'spokenTo' | 'critical' | 'nightfall' | 'dawn' | 'seasonChange' | 'rulesChanged' | 'offer' | 'offerAnswered';

/** Per-call model params taken from config. */
export type CallParams = Pick<ModelParams, 'thinking' | 'effort' | 'retryMaxTokens'>;

export interface GameConfig {
  ws: { path: string; maxPayloadBytes: number };
  /** `tiles` messages: changed tiles are coalesced and flushed at most every tileFlushMs. */
  net: { tileFlushMs: number };
  loop: { tickHz: number; stateHz: number; timeBroadcastMs: number; deadLingerMs: number; statusLogMs: number; timeScale: number };
  map: MapConfig;
  movement: MovementConfig;
  decisions: {
    tiers: Record<Tier, TierDecision>;
    timeoutMs: number;
    maxConcurrent: number;
    memoryItems: number;
    inboxItems: number;
    lookMaxTiles: number;
    lookMaxPeople: number;
    nearbyGroupsMax: number;
    textMaxChars: number;
    replanOn: Record<ReplanTrigger, boolean>;
    startStaggerMs: number;
    offersMax: number;
    /**
     * Model params per kind of call (reinloop `thinking`, `effort`, `retryMaxTokens`), so short answers are not
     * eaten by thinking; `maxTokens` comes from the tier or call settings.
     */
    modelParams: { plan: CallParams; reply: CallParams; prose: CallParams };
  };
  conversation: { replyMaxOutputTokens: number; replyTimeoutMs: number; replyMaxTurns: number; replyMaxConsults: number; agentReplyDepth: number; replanAfterReply: boolean };
  player: { speechMinIntervalMs: number; speechPerMinute: number; speechMaxChars: number; nameMaxChars: number; maxPlayers: number; inputMax: number };
  groups: {
    minMembers: number;
    maxMembers: number;
    nameMaxChars: number;
    replanDebounceMs: number;
    traceMaxChars: number;
    maxRounds: number;
    proseMaxOutputTokens: number;
    maxTurns: number;
    colors: string[];
    seeded: Array<{ name: string; pattern: GroupPattern; members: string[]; leader: string | null }>;
  };
  crowd: { count: number; tier: Tier; groupName: string; names: string[]; roles: string[]; personality: string };
  chronicle: { enabled: boolean; kind: string; operation: string; flushMs: number; maxBatch: number; maxQueue: number; retryBaseMs: number; retryMaxMs: number };
  mock: { thinkDelayMs: number; replyDelayMs: number; wanderRadius: number; planSteps: number; experimentChance: number; eatAtHunger: number; offerChance: number; judgeChance: number; lawChance: number };
  brain: BrainConfig;
  insights: InsightConfig;
  barter: BarterConfig;
  society: SocietyConfig;
  economy: EconomyConfig & { insightOnDiscovery: boolean; chronicleEvent: string };
  memory: MemoryConfig;
  services: ServicesConfig;
  observatory: import('./observatory.ts').ObservatoryConfig;
  god: { recentMax: number };
  /** Who a newborn is: `childTier` a tier name or 'random-parent'; at `maxAgentMinds` LLM minds a birth is blocked or becomes a crowd extra. */
  births: { maxAgentMinds: number; childTier: 'random-parent' | Tier; atCap: 'block' | 'crowd' };
  /** What a death frees: the private memory in mnemo (optionally leaving a one-line epitaph in the Chronicle). */
  death: { forgetMemories: boolean; epitaph: boolean };
}

export function loadGameConfig(env: NodeJS.ProcessEnv = process.env): GameConfig {
  const path = resolve(ROOT, env.GAME_CONFIG ?? 'config/game.json');
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as GameConfig;
  const n = Number(env.GAME_CROWD);
  if (env.GAME_CROWD !== undefined && Number.isInteger(n) && n >= 0) cfg.crowd.count = n;
  if (env.GAME_GROUPS === '0') cfg.groups.seeded = [];
  if (env.GAME_CHRONICLE === '0') cfg.chronicle.enabled = false;
  if (env.HERALD_URL !== undefined) cfg.brain.mcpUrl = env.HERALD_URL;
  cfg.brain.domain = env.LOREBASE_DOMAIN ?? cfg.brain.domain;
  if (env.MNEMO_URL !== undefined) cfg.memory.url = env.MNEMO_URL;
  if (env.MNEMO_URL === '') cfg.memory.enabled = false;
  const scale = Number(env.GAME_TIME_SCALE);
  if (env.GAME_TIME_SCALE !== undefined && Number.isFinite(scale) && scale > 0) cfg.loop.timeScale = scale;
  const flows = Number(env.GAME_FLOWS_MS);
  if (env.GAME_FLOWS_MS !== undefined && Number.isFinite(flows) && flows > 0) cfg.economy.flowsMs = flows;
  return cfg;
}
