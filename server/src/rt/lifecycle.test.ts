import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../config.ts';
import { loadTemplates, translator } from '../i18n.ts';
import { ROOT } from '../config.ts';
import { canAddAgentMind, childSpec } from './births.ts';
import { loadGameConfig } from './config.ts';
import { lastHeard } from './decide.ts';
import { Game } from './game.ts';
import { proclamation, recalledBlock } from './prompt.ts';

const game = loadGameConfig({});
const t = translator(loadTemplates(ROOT, 'it'));

test('childSpec: tier of a random parent, crowd children of crowds, cap blocks or makes crowd', () => {
  const cfg = { ...game, births: { maxAgentMinds: 3, childTier: 'random-parent' as const, atCap: 'block' as const } };
  const opus = { tier: 'opus' as const, kind: 'agent' as const };
  const haiku = { tier: 'haiku' as const, kind: 'agent' as const };
  const extra = { tier: 'haiku' as const, kind: 'crowd' as const };
  assert.deepEqual(childSpec(cfg, opus, haiku, 2, () => 0.1), { tier: 'opus', kind: 'agent' });
  assert.deepEqual(childSpec(cfg, opus, haiku, 2, () => 0.9), { tier: 'haiku', kind: 'agent' });
  assert.deepEqual(childSpec(cfg, opus, extra, 2, () => 0.9), { tier: 'opus', kind: 'agent' });
  assert.deepEqual(childSpec(cfg, extra, extra, 99, () => 0.5), { tier: game.crowd.tier, kind: 'crowd' });
  assert.equal(childSpec(cfg, opus, haiku, 3, () => 0.1), undefined);
  assert.deepEqual(childSpec({ ...cfg, births: { ...cfg.births, atCap: 'crowd' } }, opus, haiku, 3, () => 0.1), { tier: game.crowd.tier, kind: 'crowd' });
  assert.deepEqual(childSpec({ ...cfg, births: { ...cfg.births, childTier: 'sonnet' } }, opus, haiku, 0, () => 0.1), { tier: 'sonnet', kind: 'agent' });
  assert.equal(canAddAgentMind(cfg, 2), true);
  assert.equal(canAddAgentMind(cfg, 3), false);
});

test('proclamation carries the full text of the law; recalled memories form a block', () => {
  const text = "Prima di parlare a qualcuno bisogna dire 'Salve, fratello'";
  const born = proclamation(t, { key: 'obbligo_saluto', old: null, new: 1, text });
  assert.ok(born.includes(text) && born.includes('obbligo_saluto') && born.includes('1'), born);
  const gone = proclamation(t, { key: 'obbligo_saluto', old: 1, new: null, text });
  assert.ok(gone.includes(text) && gone !== born, gone);
  const changed = proclamation(t, { key: 'obbligo_saluto', old: 1, new: 2, text });
  assert.ok(changed.includes('2') && changed !== born && changed !== gone, changed);
  assert.equal(recalledBlock(t, []), '');
  assert.ok(recalledBlock(t, ['giorno 1: una legge']).includes('- giorno 1: una legge'));
});

test('lastHeard finds what the speaker last said to this person', () => {
  const inbox = [
    { from: 'a1', fromName: 'Ilse', to: 'a2', text: 'prima', day: 1, minute: 1 },
    { from: 'a3', fromName: 'Mara', to: 'all', text: 'altro', day: 1, minute: 2 },
    { from: 'a1', fromName: 'Ilse', to: 'a2', text: 'ultima', day: 1, minute: 3 },
  ];
  assert.equal(lastHeard({ inbox }, { id: 'a1' }), 'ultima');
  assert.equal(lastHeard({ inbox }, { id: 'zz' }), '');
});

test('a death frees the mind, the group and the private memory', async () => {
  const sim = loadConfig(['--mock'], {});
  const g = new Game(sim, { ...game, death: { forgetMemories: true, epitaph: false } });
  const forgot: Array<[string, unknown]> = [];
  const mnemo = g.mnemo as unknown as { forget: (a: string, o: unknown) => Promise<unknown>; list: () => Promise<unknown[]> };
  mnemo.forget = async (a, o) => {
    forgot.push([a, o]);
    return { memories: 3, conversations: 1, runs: 0 };
  };
  mnemo.list = async () => [];
  g.world.rules = new Proxy({}, { get: () => 1 }) as typeof g.world.rules;
  const e = g.world.spawn({ name: 'Mara Bianca', role: 'elder', tier: 'haiku', model: 'mock', kind: 'agent' });
  const internals = g as unknown as { awaken(e: unknown): void; minds: Map<string, { stop(): void }> };
  internals.awaken(e);
  assert.ok(internals.minds.has(e.id));
  e.alive = false;
  await g.release(e);
  assert.equal(internals.minds.has(e.id), false);
  assert.deepEqual(forgot, [['mara-bianca', { speaker: 'Mara Bianca', runAgent: e.id }]]);
  g.stopLoop();
});
