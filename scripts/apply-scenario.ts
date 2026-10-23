// Applies a scenario preset (config/scenarios.json) as one branch -> Proposal -> merge in Lorebase.
//   node scripts/apply-scenario.ts <name>      (no name: list scenarios)
import { loadConfig } from '../server/src/config.ts';
import { LorebaseClient } from '../server/src/lorebase/client.ts';
import { loadScenarios } from '../server/src/lorebase/scenarios.ts';
import { writeRules } from '../server/src/lorebase/writer.ts';

const name = process.argv[2];
const scenarios = loadScenarios();
const scenario = scenarios.find((s) => s.name === name);
if (!scenario) {
  console.log('scenarios:');
  for (const s of scenarios) console.log(`  ${s.name.padEnd(12)} ${s.title}: ${s.description}`);
  process.exit(name ? 2 : 0);
}
const cfg = loadConfig([]);
const client = new LorebaseClient(cfg.lorebase.url, cfg.lorebase.domain);
const out = await writeRules(client, cfg.lorebase, scenario.changes, 'proposal', `Scenario: ${scenario.title}`, scenario.title);
if (!out.ok) {
  console.error(`failed: ${out.error}`);
  process.exit(1);
}
console.log(`applied "${scenario.title}" via proposal ${out.proposalId} @ ${out.revision?.slice(0, 12)}: ${scenario.changes.map((c) => `${c.key}=${c.value}`).join(', ')}`);
