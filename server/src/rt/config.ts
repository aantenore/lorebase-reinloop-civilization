// Real-time world settings: config/game.json (GAME_CONFIG overrides the path). Gameplay numbers
// are Lorebase Rules; this file holds engine, decision, player and group knobs.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../config.ts';
import type { Tier } from '../world/types.ts';
import type { MapConfig, MovementConfig } from './world.ts';

export type GroupPattern = 'orchestrator' | 'council' | 'router' | 'chain' | 'mentor' | 'assembly' | 'crowd';
export const AGENT_PATTERNS: GroupPattern[] = ['orchestrator', 'council', 'router', 'chain', 'mentor', 'assembly'];

export interface TierDecision {
  minSteps: number;
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
  memoryDir: string;
  memoryRecallLimit: number;
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
}

export type ReplanTrigger = 'planExhausted' | 'stepFailed' | 'spokenTo' | 'critical' | 'nightfall' | 'dawn' | 'seasonChange' | 'rulesChanged';

export interface GameConfig {
  ws: { path: string; maxPayloadBytes: number };
  loop: { tickHz: number; stateHz: number; timeBroadcastMs: number; deadLingerMs: number; statusLogMs: number };
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
  };
  conversation: { replyMaxOutputTokens: number; replyTimeoutMs: number; agentReplyDepth: number; replanAfterReply: boolean };
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
  mock: { thinkDelayMs: number; replyDelayMs: number; wanderRadius: number };
  brain: BrainConfig;
  insights: InsightConfig;
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
  return cfg;
}
