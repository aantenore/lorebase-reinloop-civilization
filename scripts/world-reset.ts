// Returns the world data of the live world of the shared knowledge to the seed state, through the
// governed flow only (changes on a `reset/` draft, accepted through a single proposal; never direct
// storage access). Deletes go through the bulk removal, batched as the backend needs:
//   - laws not in the seed (knowledge.seed.rules) are repealed, seed laws get their seed value and
//     wording back (missing ones are re-created), roles get their seed values back;
//   - discovered technologies and their recipes leave the live world (back to the hidden catalog, rebuilt by the seed);
//   - Chronicle, Insight and Family records are archived on the tag `archive/<timestamp>` and removed from the live world;
//   - stale drafts (role/, law/, tech/, seed/, reset/, probe/) and their open proposals are closed.
// Then the private memory database of mnemo (config/mnemo.json db.path, MNEMO_DB) is deleted
// (the downloaded embedding model in data/models is kept). Stop the game and mnemo first.
//   node scripts/world-reset.ts [--dry-run] [--keep-memory] [--force]
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scriptKnowledge } from '../server/src/composition.ts';
import { loadConfig, ROOT } from '../server/src/config.ts';
import type { Change, KnowledgeRecord } from '../server/src/ports/knowledge.ts';
import { loadGameConfig } from '../server/src/rt/config.ts';
import { loadSeed } from '../server/src/seed.ts';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');
const keepMemory = argv.includes('--keep-memory');
const force = argv.includes('--force');
const cfg = loadConfig([]);
const game = loadGameConfig();
const kn = cfg.knowledge;
const knowledge = scriptKnowledge(cfg, game);
const main = knowledge.info.live;
const STALE_PREFIXES = [game.insights.branchPrefix, kn.proposalPrefix, game.economy.discoveryBranchPrefix, 'seed/', 'reset/', 'probe/'];
const ARCHIVE_KINDS = [game.chronicle.kind, game.insights.kind, game.society.families.kind];
type Row = Record<string, unknown>;
const seed = loadSeed(ROOT, kn.seed);

interface Action {
  change: Change;
  what: string;
}

/** Records of one kind leaving the live world (one bulk removal per kind). */
interface Removal {
  kind: string;
  key: string;
  what: string;
}

const records = async (kind: string): Promise<KnowledgeRecord[]> => (await knowledge.readAll(kind).catch(() => ({ items: [] as KnowledgeRecord[] }))).items;
const same = (a: unknown, b: unknown) => (a ?? '') === (b ?? '') || (typeof b === 'number' && Number(a) === b);

await knowledge.ready().catch(() => {
  console.error(`the knowledge is not reachable at ${knowledge.info.location}; run: npm run lorebase:up`);
  process.exit(1);
});

// ---- plan ----------------------------------------------------------------------
const actions: Action[] = [];
const removals: Removal[] = [];
const rules = await records(kn.ruleKind);
const seedRules = new Map(seed.rules.map((r) => [String(r.code), r]));
for (const r of rules) {
  const code = String(r.values.code ?? r.key);
  const s = seedRules.get(code);
  if (!s) {
    removals.push({ kind: kn.ruleKind, key: r.key, what: `repeal law ${code}` });
    continue;
  }
  const changed = (['value', 'text', 'category', 'unit'] as const).filter((k) => !same(r.values[k], s[k]));
  if (changed.length) actions.push({ change: { action: 'update', kind: kn.ruleKind, key: r.key, values: { value: s.value, text: s.text, category: s.category, unit: s.unit ?? null } }, what: `restore law ${code} (${changed.join(', ')})` });
}
const have = new Set(rules.map((r) => String(r.values.code ?? r.key)));
for (const s of seed.rules) {
  if (have.has(String(s.code))) continue;
  actions.push({ change: { action: 'create', kind: kn.ruleKind, key: String(s.code), values: { code: s.code, value: s.value, text: s.text, category: s.category, ...(s.unit ? { unit: s.unit } : {}) } }, what: `re-create law ${s.code}` });
}

for (const r of await records(kn.roleKind)) {
  const s = seed.roles.find((x: Row) => String(x.code) === String(r.values.code ?? r.key));
  if (!s) continue;
  const changed = (['title', 'description', 'move_factor', 'work_factor'] as const).filter((k) => s[k] !== undefined && !same(r.values[k], s[k]));
  if (changed.length) actions.push({ change: { action: 'update', kind: kn.roleKind, key: r.key, values: Object.fromEntries(changed.map((k) => [k, s[k]])) }, what: `restore role ${s.code} (${changed.join(', ')})` });
}

const eco = game.economy.kinds;
for (const t of await records(eco.technology)) removals.push({ kind: eco.technology, key: t.key, what: `re-hide technology ${t.key}` });
for (const r of await records(eco.recipe)) {
  if (String(r.values.tech ?? '')) removals.push({ kind: eco.recipe, key: r.key, what: `re-hide recipe ${r.key}` });
}
const archived: Record<string, number> = {};
for (const kind of ARCHIVE_KINDS) {
  const items = await records(kind);
  archived[kind] = items.length;
  for (const x of items) removals.push({ kind, key: x.key, what: `archive ${kind} ${x.key}` });
}

const stale = (await Promise.all(STALE_PREFIXES.map((p) => knowledge.drafts(p)))).flat();
const open = (await knowledge.proposals('open')).filter((p) => stale.includes(p.draft));

// ---- report ----------------------------------------------------------------------
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').toLowerCase();
const byKind = (prefix: string) => [...actions, ...removals].filter((a) => a.what.startsWith(prefix));
// One bulk removal per kind (the adapter splits it as its backend needs).
const batches: Array<{ kind: string; keys: string[] }> = [...new Set(removals.map((x) => x.kind))].map((kind) => ({ kind, keys: removals.filter((x) => x.kind === kind).map((x) => x.key) }));
console.log(`world reset of ${knowledge.info.space}/${main} (${knowledge.info.adapter})${dry ? ' (dry run)' : ''}:`);
for (const prefix of ['repeal law', 'restore law', 're-create law', 'restore role', 're-hide technology', 're-hide recipe']) {
  const list = byKind(prefix);
  if (list.length) console.log(`  ${prefix}: ${list.map((a) => a.what.slice(prefix.length + 1)).join('; ')}`);
}
for (const [kind, n] of Object.entries(archived)) console.log(`  archive ${kind}: ${n} record(s) -> archive/${stamp}, removed from ${main}`);
if (batches.length) console.log(`  bulk removal: ${batches.map((b) => `${b.kind} ${b.keys.length}`).join(', ')}`);
console.log(`  close ${open.length} open proposal(s) and discard ${stale.length} stale draft(s)${stale.length ? `: ${stale.join(', ')}` : ''}`);
const mnemoDb = resolve(ROOT, process.env.MNEMO_DB || (JSON.parse(readFileSync(resolve(ROOT, process.env.MNEMO_CONFIG ?? 'config/mnemo.json'), 'utf8')) as { db: { path: string } }).db.path);
console.log(`  private memory: ${keepMemory ? 'kept' : `delete ${mnemoDb} (models kept)`}`);
if (dry) process.exit(0);

// ---- apply ----------------------------------------------------------------------
if (!keepMemory && !force) {
  const up = await fetch(game.services.mnemo.healthUrl, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
  if (up) {
    console.error('mnemo is running: stop the game first (or pass --force, or --keep-memory)');
    process.exit(1);
  }
}
for (const p of open) await knowledge.reject(p.id).catch((err) => console.warn(`  close ${p.id}: ${err.message}`));
for (const d of stale) await knowledge.discardDraft(d).catch(() => undefined);
const changes = actions.length + removals.length;
if (changes) {
  if (Object.values(archived).some((n) => n > 0)) await knowledge.archive(`archive/${stamp}`);
  const work = `reset/${stamp}`;
  await knowledge.snapshot(work);
  for (const a of actions) await knowledge.write([a.change], { scope: work, message: `World reset: ${a.what}` });
  for (const b of batches) await knowledge.removeMany(b.kind, b.keys, { scope: work, message: `World reset: remove ${b.keys.length} ${b.kind} record(s)` });
  const pr = await knowledge.propose({ draft: work, title: 'World reset', description: `Back to the seed state: ${changes} change(s). History archived on tag archive/${stamp}.`, message: 'World reset', changes: [] });
  await knowledge.review(pr.id, 'approve', 'World reset');
  const revision = await knowledge.accept(pr.id, 'World reset');
  console.log(`accepted ${pr.id} into ${main} @ ${revision.slice(0, 12)} (${actions.length} change(s), ${batches.length} bulk removal(s))`);
} else console.log(`${main} already matches the seed`);

// The hidden catalog is rebuilt from the live world (and anything missing is seeded back).
const seeded = spawnSync(process.execPath, [resolve(ROOT, 'scripts/lorebase-seed.ts')], { stdio: 'inherit', env: process.env });
if (seeded.status !== 0) console.warn('seed step failed: run npm run lorebase:seed');

if (!keepMemory) {
  for (const f of [mnemoDb, `${mnemoDb}-wal`, `${mnemoDb}-shm`]) if (existsSync(f)) rmSync(f);
  console.log(`private memory deleted (${mnemoDb})`);
}
