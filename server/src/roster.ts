// Roster entries (people the world starts with): validation, cleaning and the saved roster
// file. Shared by the tick simulation and the real-time game.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkModel, type RosterEntry, type SimConfig } from './config.ts';
import { applyRosterTiers } from './profile.ts';
import { TIERS } from './world/types.ts';

export const NAME_MAX = 40;

export function validateEntry(e: unknown, roles: string[], cfg: Pick<SimConfig, 'models' | 'allowedModels'>): string | undefined {
  if (!e || typeof e !== 'object') return 'must be an object';
  const r = e as Record<string, unknown>;
  if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > NAME_MAX) return `name must be 1-${NAME_MAX} characters`;
  if (typeof r.role !== 'string' || !roles.includes(r.role)) return `role must be one of ${roles.join(', ')}`;
  if (!TIERS.includes(r.tier as never)) return `tier must be one of ${TIERS.join(', ')}`;
  const modelError = checkModel(cfg, r.model);
  if (modelError) return modelError;
  if (r.personality !== undefined && typeof r.personality !== 'string') return 'personality must be a string';
  return undefined;
}

export function validateRoster(entries: unknown, roles: string[], cfg: Pick<SimConfig, 'models' | 'allowedModels' | 'agents'>): string | undefined {
  if (!Array.isArray(entries)) return 'agents must be an array';
  const { minRoster, maxRoster } = cfg.agents;
  if (entries.length < minRoster || entries.length > maxRoster) return `between ${minRoster} and ${maxRoster} agents are allowed`;
  const names = new Set<string>();
  for (const [i, e] of entries.entries()) {
    const err = validateEntry(e, roles, cfg);
    if (err) return `agents[${i}]: ${err}`;
    const n = (e as RosterEntry).name.trim().toLowerCase();
    if (names.has(n)) return `duplicate name "${(e as RosterEntry).name}"`;
    names.add(n);
  }
  return undefined;
}

export function cleanEntry(e: RosterEntry): RosterEntry {
  return { ...(e.id ? { id: e.id } : {}), name: e.name.trim(), role: e.role, tier: e.tier, ...(e.model ? { model: e.model } : {}), ...(e.personality ? { personality: e.personality } : {}) };
}

/** The saved roster when valid, else the configured one. */
export function loadRosterFile(cfg: SimConfig, roles: string[]): RosterEntry[] {
  try {
    if (existsSync(cfg.rosterFile)) {
      const saved = JSON.parse(readFileSync(cfg.rosterFile, 'utf8')) as RosterEntry[];
      if (!validateRoster(saved, roles, cfg)) return applyRosterTiers(saved, cfg.rosterTiers);
      console.warn(`ignoring invalid ${cfg.rosterFile}`);
    }
  } catch (err) {
    console.warn(`cannot read ${cfg.rosterFile}: ${err instanceof Error ? err.message : err}`);
  }
  return cfg.roster;
}

export function saveRosterFile(cfg: SimConfig, roster: RosterEntry[]): void {
  try {
    mkdirSync(dirname(cfg.rosterFile), { recursive: true });
    writeFileSync(cfg.rosterFile, `${JSON.stringify(roster, null, 2)}\n`);
  } catch (err) {
    console.warn(`cannot save roster: ${err instanceof Error ? err.message : err}`);
  }
}
