// Creates the `world` Domain, applies lorebase/schema.yaml and loads lorebase/rules.seed.yaml
// (rules and roles),
// on a seed branch merged into `main` through a Proposal. Safe to run again: existing rules
// keep their current values unless --reset is passed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseYaml } from 'reinloop';
import { loadConfig, ROOT } from '../server/src/config.ts';
import { LorebaseClient, LorebaseError } from '../server/src/lorebase/client.ts';
import { loadRules } from '../server/src/lorebase/rules.ts';

const cfg = loadConfig();
const reset = process.argv.includes('--reset');
const { url, domain, branch, ruleKind, roleKind } = cfg.lorebase;
const client = new LorebaseClient(url, domain);
const schemaYaml = readFileSync(resolve(ROOT, 'lorebase/schema.yaml'), 'utf8');
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

const now = await loadRules(client, cfg.lorebase, branch);
console.log(`${now.rules.length} rules and ${now.roles.length} roles on ${branch} @ ${now.revision.slice(0, 12)}`);
for (const r of now.rules) console.log(`  ${r.category.padEnd(8)} ${r.key.padEnd(30)} ${r.value} ${r.unit}`);
