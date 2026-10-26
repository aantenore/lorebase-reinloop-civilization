// Seeds the shared knowledge configured in config/sim.json (`knowledge.adapter`): makes sure the
// space and its schema exist, then loads the seed laws and roles (knowledge.seed.rules) and the
// resources and recipes known from the start (knowledge.seed.economy) on a draft accepted into
// the live world through a proposal. Then rebuilds the hidden catalog (config/game.json
// `economy.hiddenBranch`): technologies not yet discovered and their recipes, which people
// cannot read. Safe to run again: existing laws keep their current values unless --reset is passed.
import { scriptKnowledge } from '../server/src/composition.ts';
import { loadConfig, ROOT } from '../server/src/config.ts';
import { loadRules } from '../server/src/laws/laws.ts';
import { loadGameConfig } from '../server/src/rt/config.ts';
import { economyChanges, hiddenChanges, lawChanges, loadSeed } from '../server/src/seed.ts';

const cfg = loadConfig();
const game = loadGameConfig();
const reset = process.argv.includes('--reset');
const kinds = cfg.knowledge;
const eco = game.economy;
const knowledge = scriptKnowledge(cfg, game);
type Row = Record<string, unknown>;

await knowledge.ready().catch(() => {
  console.error(`the knowledge is not reachable at ${knowledge.info.location}; run: npm run lorebase:up`);
  process.exit(1);
});

console.log(`schema: ${await knowledge.ensureSchema()} change(s)`);
const seed = loadSeed(ROOT, cfg.knowledge.seed);
const existing = await loadRules(knowledge, kinds).catch(() => ({ revision: '', rules: [], roles: [] }));
const haveRules = new Set(existing.rules.map((r) => r.key));
const haveRoles = new Map(existing.roles.map((r) => [r.key, r]));
// A role is (re)written when missing, or when the seed adds speed factors the stored record lacks.
const roleOutdated = (r: Row) => {
  const have = haveRoles.get(String(r.code));
  if (!have) return true;
  return (r.move_factor !== undefined && have.moveFactor === undefined) || (r.work_factor !== undefined && have.workFactor === undefined);
};
const haveCodes = async (kind: string) => new Set((await knowledge.readAll(kind).catch(() => ({ items: [] as Array<{ values: Row }> }))).items.map((r) => String(r.values.code)));
const have: Record<string, Set<string>> = { [eco.kinds.resource]: await haveCodes(eco.kinds.resource), [eco.kinds.recipe]: await haveCodes(eco.kinds.recipe) };
const keep = (kind: string, row: Row) => {
  if (reset) return true;
  if (kind === kinds.ruleKind) return !haveRules.has(String(row.code));
  if (kind === kinds.roleKind) return roleOutdated(row);
  return !have[kind]?.has(String(row.code));
};

// Laws, roles, then resources before recipes (recipes link to them): one write per batch.
const batches = [...lawChanges(seed, kinds, keep), ...economyChanges(seed, eco, keep)];
for (const kind of [kinds.ruleKind, kinds.roleKind, eco.kinds.resource, eco.kinds.recipe]) {
  const n = batches.flat().filter((c) => c.kind === kind).length;
  console.log(`${kind}: ${n ? `${n} record(s) to write` : 'all present (use --reset to restore seed values)'}`);
}
if (batches.length) {
  const [first, ...rest] = batches;
  const p = await knowledge.propose({
    draft: `seed/${Date.now().toString(36)}`, title: 'Seed the laws of the world', description: 'Default rules of the civilization demo.', message: 'Seed', changes: first!,
  });
  try {
    for (const b of rest) await knowledge.write(b, { scope: p.draft, message: `Seed ${b.length} ${b[0]!.kind} record(s)` });
    await knowledge.review(p.id, 'approve', 'Seed');
    const revision = await knowledge.accept(p.id, 'Seed the laws of the world');
    console.log(`accepted proposal ${p.id} into ${knowledge.info.live} @ ${revision.slice(0, 12)}`);
  } catch (err) {
    await knowledge.reject(p.id).catch(() => undefined);
    throw err;
  }
} else console.log('nothing to merge');

// The hidden catalog: rebuilt from the live world every time (it holds no state of its own).
const hidden = eco.hiddenBranch;
await knowledge.snapshot(hidden);
for (const b of hiddenChanges(seed, eco, await haveCodes(eco.kinds.technology))) {
  await knowledge.write(b, { scope: hidden, message: `Hidden catalog: ${b.length} record(s)` });
  console.log(`hidden catalog ${hidden}: ${b.length} ${b[0]!.kind} record(s)`);
}

const now = await loadRules(knowledge, kinds);
console.log(`${now.rules.length} rules and ${now.roles.length} roles on ${knowledge.info.live} @ ${now.revision.slice(0, 12)}`);
for (const r of now.rules) console.log(`  ${r.category.padEnd(8)} ${r.key.padEnd(30)} ${r.value} ${r.unit}`);
await knowledge.close();
