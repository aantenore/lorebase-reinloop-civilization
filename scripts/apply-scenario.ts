// Applies a scenario preset (config/scenarios.json) as one draft -> proposal -> accept in the shared knowledge.
//   node scripts/apply-scenario.ts <name>      (no name: list scenarios)
import { scriptKnowledge } from '../server/src/composition.ts';
import { loadConfig } from '../server/src/config.ts';
import { loadScenarios } from '../server/src/laws/scenarios.ts';
import { writeRules } from '../server/src/laws/writer.ts';

const name = process.argv[2];
const cfg = loadConfig([]);
const scenarios = loadScenarios(cfg.knowledge.seed.rules);
const scenario = scenarios.find((s) => s.name === name);
if (!scenario) {
  console.log('scenarios:');
  for (const s of scenarios) console.log(`  ${s.name.padEnd(12)} ${s.title}: ${s.description}`);
  process.exit(name ? 2 : 0);
}
const knowledge = scriptKnowledge(cfg);
const out = await writeRules(knowledge, { ruleKind: cfg.knowledge.ruleKind, proposalPrefix: cfg.knowledge.proposalPrefix }, scenario.changes, 'proposal', `Scenario: ${scenario.title}`, scenario.title);
if (!out.ok) {
  console.error(`failed: ${out.error}`);
  process.exit(1);
}
console.log(`applied "${scenario.title}" via proposal ${out.proposalId} @ ${out.revision?.slice(0, 12)}: ${scenario.changes.map((c) => `${c.key}=${c.value}`).join(', ')}`);
