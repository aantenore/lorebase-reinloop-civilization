// Cost profiles: config/profiles/<name>.json, chosen with GAME_PROFILE. A profile is a patch over the
// configuration files: `game` is merged into config/game.json, `sim` into config/sim.json, and
// `rosterTiers` sets the model tier of roster entries by name ("*" for everyone else).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tier } from './world/types.ts';

export interface Profile {
  description?: string;
  game?: Record<string, unknown>;
  sim?: Record<string, unknown>;
  rosterTiers?: Record<string, Tier>;
}

const ROOT = resolve(import.meta.dirname, '../..');
const NAME = /^[a-z0-9][a-z0-9_-]*$/i;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Objects are merged key by key; arrays and scalars in `patch` replace those in `base`. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObject(base) || !isObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : v;
  return out as T;
}

/** The profile named by GAME_PROFILE (none: empty). Directory: GAME_PROFILES_DIR or config/profiles. */
export function loadProfile(env: NodeJS.ProcessEnv = process.env): Profile {
  const name = env.GAME_PROFILE?.trim();
  if (!name) return {};
  if (!NAME.test(name)) throw new Error(`GAME_PROFILE: invalid name "${name}"`);
  const file = resolve(ROOT, env.GAME_PROFILES_DIR ?? 'config/profiles', `${name}.json`);
  if (!existsSync(file)) throw new Error(`GAME_PROFILE: ${file} not found`);
  return JSON.parse(readFileSync(file, 'utf8')) as Profile;
}

/** Roster entries with the profile's tiers: by name first, then "*"; an explicit per-entry model is dropped when the tier changes. */
export function applyRosterTiers<E extends { name: string; tier: Tier; model?: string }>(roster: E[], tiers: Record<string, Tier> | undefined): E[] {
  if (!tiers) return roster;
  return roster.map((e) => {
    const tier = tiers[e.name] ?? tiers['*'];
    if (!tier || tier === e.tier) return e;
    const { model: _model, ...rest } = e;
    return { ...rest, tier } as E;
  });
}
