// Loads config/mnemo.json (override: MNEMO_CONFIG) and applies environment overrides. Also loads
// the repo-root `.env` when present (secrets stay in the environment; nothing here prints them).
// Relative paths in the config are resolved from the repo root.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../../..');

export type EmbedderProvider = 'transformers' | 'claude-concepts' | 'hash';
export type LlmProvider = 'anthropic' | 'heuristic';

export interface FadingConfig {
  baseStabilityHours: number;
  importanceWeight: number;
  emotionWeight: number;
  recallStabilityFactor: number;
  strengthen: number;
  gistStabilityFactor: number;
  gistFidelity: number;
}

export interface ReconsolidationConfig {
  enabled: boolean;
  probability: number;
  fidelityPenalty: number;
}

export interface CompactionConfig {
  intervalMs: number;
  blurBelow: number[];
  mergeBelow: number;
  mergeCosine: number;
  mergeMinCluster: number;
  forgetBelow: number;
  maxAgentsPerPass: number;
  maxLlmCallsPerPass: number;
  maxInputChars: number;
  maxMemoriesPerAgent: number;
}

export interface RecallWeights {
  cosine: number;
  bm25: number;
  fidelity: number;
  recency: number;
  importance: number;
}

export interface MnemoConfig {
  http: { host: string; port: number; maxBodyBytes: number };
  /** With MNEMO_PARENT_PID set: how often to check the launcher is still alive. */
  lifecycle: { parentCheckMs: number };
  db: { path: string; maxBytes: number; capBatch: number };
  embedder: {
    provider: EmbedderProvider;
    model: string;
    dtype: string;
    cacheDir: string;
    queryPrefix: string;
    passagePrefix: string;
    conceptDim: number;
    conceptModel: string;
    conceptMaxTokens: number;
    conceptWordWeight: number;
    reembedBatch: number;
  };
  llm: { provider: LlmProvider; model: string; maxOutputTokens: number; timeoutMs: number; heuristicMergeChars: number };
  recall: {
    weights: RecallWeights;
    candidates: number;
    recencyHalfLifeHours: number;
    defaultLimit: number;
    rerank: { enabled: boolean; minCandidates: number; model: string };
  };
  fading: FadingConfig;
  compaction: CompactionConfig;
  reconsolidation: ReconsolidationConfig;
  runs: { maxRuns: number; maxAgeHours: number; pruneEveryInserts: number };
  conversations: { maxKept: number; maxLimit: number };
  /** Forgetting a whole agent (it died): VACUUM afterwards to give the pages back. */
  forget: { vacuum: boolean };
  events: { maxKept: number; trimEvery: number };
  namespaces: { fading: string[]; static: string[] };
}

export function loadEnvFile(): void {
  const file = resolve(ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

function fromRoot(p: string): string {
  return p === ':memory:' || isAbsolute(p) ? p : resolve(ROOT, p);
}

function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function oneOf<T extends string>(v: string | undefined, name: string, allowed: readonly T[]): T | undefined {
  if (v === undefined || v === '') return undefined;
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`${name} must be one of ${allowed.join('|')}`);
  return v as T;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MnemoConfig {
  const file = env.MNEMO_CONFIG ? fromRoot(env.MNEMO_CONFIG) : resolve(ROOT, 'config/mnemo.json');
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as MnemoConfig;
  cfg.http.port = num(env.MNEMO_PORT, 'MNEMO_PORT') ?? cfg.http.port;
  cfg.db.path = fromRoot(env.MNEMO_DB || cfg.db.path);
  cfg.compaction.intervalMs = num(env.MNEMO_COMPACT_MS, 'MNEMO_COMPACT_MS') ?? cfg.compaction.intervalMs;
  cfg.embedder.provider = oneOf(env.MNEMO_EMBEDDER, 'MNEMO_EMBEDDER', ['transformers', 'claude-concepts', 'hash'] as const) ?? cfg.embedder.provider;
  cfg.llm.provider = oneOf(env.MNEMO_LLM, 'MNEMO_LLM', ['anthropic', 'heuristic'] as const) ?? cfg.llm.provider;
  cfg.embedder.cacheDir = fromRoot(cfg.embedder.cacheDir);
  return cfg;
}
