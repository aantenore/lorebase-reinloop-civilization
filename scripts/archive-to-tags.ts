// Turns the `archive/` branches of the shared knowledge (Lorebase) into tags of the same name at the same
// head, then deletes the branches: tags do not count against the Keeper's materialized-branch cap
// (`keeper.branches.max_materialized_per_domain`). Dry run by default; safe to run again.
// A name cannot be both, so each branch is deleted and then tagged at its recorded head revision; if the
// tag cannot be created the revision is printed so that it can be tagged by hand.
//   node scripts/archive-to-tags.ts [--apply] [--prefix archive/]
import { loadConfig } from '../server/src/config.ts';
import { LorebaseClient } from '../server/src/adapters/knowledge/lorebase/client.ts';
import { planArchiveToTags } from '../server/src/adapters/knowledge/lorebase/archive.ts';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const at = argv.indexOf('--prefix');
const prefix = at >= 0 && argv[at + 1] ? argv[at + 1] : 'archive/';
const cfg = loadConfig([]);
if (cfg.knowledge.adapter !== 'lorebase') {
  console.error('knowledge.adapter is not "lorebase": nothing to migrate');
  process.exit(2);
}
const client = new LorebaseClient(cfg.knowledge.lorebase.url, cfg.knowledge.lorebase.domain);
await client.ready().catch(() => {
  console.error(`the Keeper is not reachable at ${client.url}; run: npm run lorebase:up`);
  process.exit(1);
});

const steps = planArchiveToTags(await client.listBranches(), await client.listTags(), prefix);
console.log(`${apply ? 'apply' : 'dry run'}: ${steps.length} branch(es) under "${prefix}" in domain "${client.domain}"`);
let failed = 0;
for (const s of steps) {
  if (s.action === 'skip') {
    console.log(`  skip ${s.name}: ${s.reason}`);
    continue;
  }
  console.log(`  ${apply ? '' : 'would '}tag ${s.name} @ ${s.head.slice(0, 12)} and delete the branch`);
  if (!apply) continue;
  try {
    await client.deleteBranch(s.name);
    await client.createTag(s.name, { revision: s.head });
  } catch (err) {
    failed++;
    console.error(`  FAILED ${s.name}: ${(err as Error).message}; head revision to tag by hand: ${s.head}`);
  }
}
if (!apply && steps.some((s) => s.action === 'tag')) console.log('dry run only: pass --apply to execute');
process.exit(failed ? 1 : 0);
