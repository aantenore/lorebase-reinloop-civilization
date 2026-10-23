// Creates the `world` Domain, applies lorebase/schema.yaml and loads lorebase/rules.seed.yaml
// (rules and roles) and lorebase/economy.seed.yaml (resources and the recipes known from the
// start) on a seed branch merged into `main` through a Proposal. Then rebuilds the hidden
// branch (config/game.json `economy.hiddenBranch`) with the whole catalog: technologies not
// yet discovered and their recipes, which agents cannot read. Safe to run again: existing
// rules keep their current values unless --reset is passed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseYaml } from 'reinloop';
import { loadConfig, ROOT } from '../server/src/config.ts';
import { LorebaseClient, LorebaseError } from '../server/src/lorebase/client.ts';
import { loadRules } from '../server/src/lorebase/rules.ts';
import { recipeRow } from '../server/src/rt/economy-book.ts';
import { loadGameConfig } from '../server/src/rt/config.ts';
import { recipeFrom } from '../server/src/rt/economy.ts';

const cfg = loadConfig();
const reset = process.argv.includes('--reset');
const { url, domain, branch, ruleKind, roleKind } = cfg.lorebase;
const client = new LorebaseClient(url, domain);
const schemaYaml = readFileSync(resolve(ROOT, 'lorebase/schema.yaml'), 'utf8');
const eco = loadGameConfig().economy;
type Row = Record<string, unknown>;
const economy = parseYaml(readFileSync(resolve(ROOT, 'lorebase/economy.seed.yaml'), 'utf8')) as { resources: Row[]; recipes: Row[]; technologies: Array<Row & { recipes?: Row[] }> };
const seed = parseYaml(readFileSync(resolve(ROOT, 'lorebase/rules.seed.yaml'), 'utf8')) as { rules: Array<Record<string, unknown>>; roles: Array<Record<string, unknown>> };

await client.ready().catch(() => {
  console.error(`Keeper is not reachable at ${url}; run: npm run lorebase:up`);
  process.exit(1);
});

try {
  await client.getDomain();
  console.log(`domain "${domain}" exists`);
} catch (err) {
  if (!(err instanceof LorebaseError) || err.status !== 404) throw err;
  await client.createDomain('World laws', 'The rules a small colony of agents must live by.');
  console.log(`created domain "${domain}"`);
}

const existing = await loadRules(client, cfg.lorebase, branch).catch(() => ({ revision: '', rules: [], roles: [] }));
const haveRules = new Set(existing.rules.map((r) => r.key));
const haveRoles = new Map(existing.roles.map((r) => [r.key, r]));
// A role is (re)written when missing, or when the seed adds speed factors the stored record lacks.
const roleOutdated = (r: Record<string, unknown>) => {
  const have = haveRoles.get(String(r.code));
  if (!have) return true;
  return (r.move_factor !== undefined && have.moveFactor === undefined) || (r.work_factor !== undefined && have.workFactor === undefined);
};
const rows = seed.rules.filter((r) => reset || !haveRules.has(String(r.code)));
const roleRows = (seed.roles ?? []).filter((r) => reset || roleOutdated(r));

const haveCodes = async (kind: string) => new Set((await client.listRecords(kind, branch).catch(() => ({ items: [] as Array<{ values: Row }> }))).items.map((r) => String(r.values.code)));
const haveResources = await haveCodes(eco.kinds.resource);
const haveRecipes = await haveCodes(eco.kinds.recipe);
const resourceRows = economy.resources.filter((r) => reset || !haveResources.has(String(r.code))).map((r) => ({ kind: eco.kinds.resource, ...r }));
const baseRecipeRows = economy.recipes.filter((r) => reset || !haveRecipes.has(String(r.code))).map((r) => recipeRow(eco, recipeFrom(r)));

const work = `seed/${Date.now().toString(36)}`;
await client.createBranch(work, branch);
const schema = await client.applySchema(work, schemaYaml, 'Apply world schema');
console.log(`schema: ${schema.status}, ${schema.change_count} change(s)`);
for (const [kind, list] of [[ruleKind, rows], [roleKind, roleRows]] as const) {
  if (list.length) {
    const out = await client.execute('import_records', { kind, rows: list }, { branch: work, message: `Seed ${list.length} ${kind} record(s)` });
    console.log(`${kind}: ${out.status}, ${out.edit_count} edit(s)`);
  } else {
    console.log(`${kind}: all present (use --reset to restore seed values)`);
  }
}

if (resourceRows.length || baseRecipeRows.length) {
  // Resources first: recipes link to them.
  for (const records of [resourceRows, baseRecipeRows]) {
    if (!records.length) continue;
    const out = await client.execute(eco.importOperation, { records }, { branch: work, message: `Seed ${records.length} economy record(s)` });
    console.log(`economy: ${out.status}, ${out.edit_count} edit(s)`);
  }
} else {
  console.log('economy: resources and base recipes present (use --reset to restore seed values)');
}

const head = await client.getBranch(work);
const base = await client.getBranch(branch);
if (head.head === base.head) {
  console.log('nothing to merge');
  await client.deleteBranch(work).catch(() => undefined);
} else {
  const proposal = await client.createProposal(work, branch, 'Seed the laws of the world', 'Schema and default rules of the civilization demo.');
  await client.review(proposal.id, 'approve', 'Seed');
  const merged = await client.merge(proposal.id, 'Seed the laws of the world');
  await client.deleteBranch(work).catch(() => undefined);
  console.log(`merged proposal ${proposal.id} into ${branch}: ${merged.result} @ ${merged.revision.slice(0, 12)}`);
}

// The hidden catalog: rebuilt from main every time (it holds no state of its own).
const hidden = eco.hiddenBranch;
await client.deleteBranch(hidden).catch(() => undefined);
await client.createBranch(hidden, branch);
const discoveredOnMain = await haveCodes(eco.kinds.technology);
const techRows: Row[] = [];
const lockedRows: Row[] = [];
for (const t of economy.technologies) {
  const prerequisites = (t.prerequisites as string[] | undefined) ?? [];
  if (!discoveredOnMain.has(String(t.code))) {
    techRows.push({
      kind: eco.kinds.technology, code: t.code, name: t.name, description: t.description, prerequisites, discovered: false,
      ...(prerequisites.length ? { links: { [eco.relations.requires]: prerequisites } } : {}),
    });
  }
  for (const r of t.recipes ?? []) lockedRows.push(recipeRow(eco, recipeFrom(r, String(t.code))));
}
// Prerequisites first, so the `requires` Links find their target.
techRows.sort((a, b) => ((a.prerequisites as string[]).length - (b.prerequisites as string[]).length));
for (const records of [techRows, lockedRows]) {
  if (!records.length) continue;
  const out = await client.execute(eco.importOperation, { records }, { branch: hidden, message: `Hidden catalog: ${records.length} record(s)` });
  console.log(`hidden branch ${hidden}: ${out.status}, ${out.edit_count} edit(s)`);
}

const now = await loadRules(client, cfg.lorebase, branch);
console.log(`${now.rules.length} rules and ${now.roles.length} roles on ${branch} @ ${now.revision.slice(0, 12)}`);
for (const r of now.rules) console.log(`  ${r.category.padEnd(8)} ${r.key.padEnd(30)} ${r.value} ${r.unit}`);
