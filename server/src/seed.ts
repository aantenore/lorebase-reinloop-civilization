// The seed of the world (config `knowledge.seed`): default laws and roles, resources and the
// recipes known from the start (live world), every technology with the recipes it unlocks
// (hidden catalog). Turned into knowledge changes; any backend can load them.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseYaml } from 'reinloop';
import type { Change } from './ports/knowledge.ts';
import { recipeChange, type EconomyConfig } from './rt/economy-book.ts';
import { recipeFrom } from './rt/economy.ts';

type Row = Record<string, unknown>;

export interface SeedFiles {
  /** Schema of the knowledge (used by backends that need one). */
  schema: string;
  rules: string;
  economy: string;
}

export interface WorldSeed {
  rules: Row[];
  roles: Row[];
  resources: Row[];
  recipes: Row[];
  technologies: Array<Row & { recipes?: Row[] }>;
}

export function loadSeed(root: string, files: SeedFiles): WorldSeed {
  const laws = parseYaml(readFileSync(resolve(root, files.rules), 'utf8')) as { rules: Row[]; roles?: Row[] };
  const eco = parseYaml(readFileSync(resolve(root, files.economy), 'utf8')) as { resources: Row[]; recipes: Row[]; technologies: WorldSeed['technologies'] };
  return { rules: laws.rules, roles: laws.roles ?? [], resources: eco.resources ?? [], recipes: eco.recipes ?? [], technologies: eco.technologies ?? [] };
}

const upsert = (kind: string, row: Row): Change => ({ action: 'upsert', kind, key: String(row.code), values: row });

export interface SeedKinds {
  ruleKind: string;
  roleKind: string;
}

/** Laws, then roles of the live world (one batch each). */
export function lawChanges(seed: WorldSeed, kinds: SeedKinds, keep: (kind: string, row: Row) => boolean = () => true): Change[][] {
  return [
    seed.rules.filter((r) => keep(kinds.ruleKind, r)).map((r) => upsert(kinds.ruleKind, r)),
    seed.roles.filter((r) => keep(kinds.roleKind, r)).map((r) => upsert(kinds.roleKind, r)),
  ].filter((b) => b.length);
}

/** Resources first (recipes link to them), then the recipes known from the start. */
export function economyChanges(seed: WorldSeed, eco: Pick<EconomyConfig, 'kinds' | 'relations'>, keep: (kind: string, row: Row) => boolean = () => true): Change[][] {
  return [
    seed.resources.filter((r) => keep(eco.kinds.resource, r)).map((r) => upsert(eco.kinds.resource, r)),
    seed.recipes.filter((r) => keep(eco.kinds.recipe, r)).map((r) => recipeChange(eco, recipeFrom(r))),
  ].filter((b) => b.length);
}

/** The hidden catalog: technologies not yet discovered (prerequisites first) and every locked recipe. */
export function hiddenChanges(seed: WorldSeed, eco: Pick<EconomyConfig, 'kinds' | 'relations'>, discovered: Set<string>): Change[][] {
  const techs: Change[] = [];
  const locked: Change[] = [];
  const sorted = [...seed.technologies].sort((a, b) => ((a.prerequisites as string[] | undefined)?.length ?? 0) - ((b.prerequisites as string[] | undefined)?.length ?? 0));
  for (const t of sorted) {
    const prerequisites = (t.prerequisites as string[] | undefined) ?? [];
    if (!discovered.has(String(t.code))) {
      techs.push({
        action: 'upsert', kind: eco.kinds.technology, key: String(t.code),
        values: { code: t.code, name: t.name, description: t.description, prerequisites, discovered: false },
        ...(prerequisites.length ? { links: { [eco.relations.requires]: prerequisites } } : {}),
      });
    }
    for (const r of t.recipes ?? []) locked.push(recipeChange(eco, recipeFrom(r, String(t.code))));
  }
  return [techs, locked].filter((b) => b.length);
}
