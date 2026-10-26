import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdapters } from '../composition.ts';
import { loadConfig } from '../config.ts';
import { loadGameConfig } from '../rt/config.ts';
import { RT_RULE_KEYS } from '../rt/world.ts';
import type { RuleChange } from './laws.ts';
import { LawWatcher } from './watcher.ts';
import { createRule, repealRule, writeRules } from './writer.ts';

const sim = loadConfig([], { KNOWLEDGE_ADAPTER: 'memory' });
const game = loadGameConfig({ MEMORY_ADAPTER: 'inmem' });
const writer = { ruleKind: sim.knowledge.ruleKind, proposalPrefix: sim.knowledge.proposalPrefix };
const tick = () => new Promise((r) => setTimeout(r, 5));

test('offline adapters: the seed gives every law of the world and the hidden catalog', async () => {
  const { knowledge, memory } = createAdapters(sim, game);
  assert.equal(knowledge.info.adapter, 'memory');
  assert.equal(memory.info.adapter, 'inmem');
  const laws = new Set((await knowledge.readAll(sim.knowledge.ruleKind)).items.map((r) => r.key));
  for (const k of RT_RULE_KEYS) assert.ok(laws.has(k), k);
  assert.ok((await knowledge.readAll(game.economy.kinds.resource)).items.length > 0);
  assert.equal((await knowledge.readAll(game.economy.kinds.technology)).items.length, 0);
  assert.ok((await knowledge.readAll(game.economy.kinds.technology, { scope: game.economy.hiddenBranch })).items.length > 0);
});

test('law watcher sees direct and proposed law changes through the change feed', async () => {
  const { knowledge } = createAdapters(sim, game);
  const seen: RuleChange[][] = [];
  const w = new LawWatcher(knowledge, sim.knowledge, { onChange: (_s, changes) => seen.push(changes), onStatus: () => undefined });
  const first = await w.start();
  const hp = first.rules.find((r) => r.key === 'max_hp')!;
  assert.equal((await writeRules(knowledge, writer, [{ key: 'max_hp', value: hp.value + 1 }], 'direct', 'raise')).ok, true);
  await tick();
  const out = await createRule(knowledge, writer, { key: 'obbligo_saluto', value: 1, text: 'Salutare', category: 'society' }, 'proposal', 'Greet');
  assert.equal(out.ok, true);
  assert.ok(out.proposalId && out.branch?.startsWith('law/'));
  await tick();
  assert.equal((await repealRule(knowledge, writer, 'obbligo_saluto', 'direct', 'Repeal')).ok, true);
  await tick();
  assert.deepEqual(seen.map((c) => c.map((x) => [x.key, x.old, x.new])), [
    [['max_hp', hp.value, hp.value + 1]],
    [['obbligo_saluto', null, 1]],
    [['obbligo_saluto', 1, null]],
  ]);
  assert.equal(w.connected, true);
  assert.equal((await createRule(knowledge, writer, { key: 'Bad Key', value: 1, text: 't', category: 'society' }, 'direct', 'x')).ok, false);
  w.stop();
});
