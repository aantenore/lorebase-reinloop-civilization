import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HashEmbedder } from './embed.ts';
import { HeuristicRewriter } from './llm.ts';
import { MnemoService } from './service.ts';
import { Store } from './store.ts';
import { testConfig } from './testing.ts';
import { initialStability } from './fading.ts';

const cfgStability = () => initialStability(0, 0, testConfig().fading);

function setup(clock = { t: 1_000_000 }) {
  const cfg = testConfig();
  const store = new Store(cfg);
  const svc = new MnemoService({
    cfg,
    store,
    embedder: new HashEmbedder(cfg.embedder.conceptDim),
    rewriter: new HeuristicRewriter(cfg.llm.heuristicMergeChars),
    now: () => clock.t,
    rng: () => 0.99,
  });
  return { cfg, store, svc, clock };
}

test('add then recall finds the memory, strengthens it and logs events', async () => {
  const { svc, store } = setup();
  const m = await svc.add({ agent: 'a1', text: 'Ho raccolto selce sulla spiaggia vicino al fiume', importance: 0.8, at: { day: 2, minute: 30 } });
  await svc.add({ agent: 'a1', text: 'Il fuoco si è spento durante la notte' });
  assert.deepEqual(Object.keys(m).sort(), ['createdAt', 'emotion', 'fidelity', 'id', 'importance', 'kind', 'recalls', 'text']);
  assert.deepEqual(m.createdAt, { day: 2, minute: 30 });
  const got = await svc.recall({ agent: 'a1', query: 'selce fiume' });
  assert.equal(got[0]!.id, m.id);
  assert.equal(svc.list('a1').find((x) => x.id === m.id)!.recalls, 1);
  assert.deepEqual(store.eventsSince(0, 10).map((e) => e.action), ['added', 'added', 'recalled', 'recalled']);
  assert.deepEqual(await svc.recall({ agent: 'other', query: 'selce' }), []);
});

test('static namespace ignores agent, never fades, logs no events', async () => {
  const { svc, store, clock } = setup();
  await svc.add({ agent: 'w', ns: 'world', text: 'Il pozzo è a nord del villaggio' });
  clock.t += 1e12;
  const got = await svc.recall({ ns: 'world', query: 'pozzo nord' });
  assert.equal(got.length, 1);
  assert.equal(got[0]!.fidelity, 1);
  assert.equal(got[0]!.recalls, 0);
  assert.equal(store.eventsSince(0, 10).length, 0);
});

test('compaction blurs, merges and forgets faded memories', async () => {
  const { svc, clock, store } = setup();
  await svc.add({ agent: 'a1', text: 'Ho trovato 13 bacche rosse vicino al fiume (12,7), erano mature.', importance: 0 });
  await svc.add({ agent: 'a1', text: 'Ho trovato 14 bacche rosse vicino al fiume (12,8), erano mature.', importance: 0 });
  await svc.add({ agent: 'a1', text: 'Ho costruito una capanna di legno con rami lunghi e fango', importance: 0 });
  await svc.add({ agent: 'a1', text: 'Il vento freddo ha portato via le foglie dal tetto del granaio', importance: 0 });
  const stab = cfgStability();
  clock.t += stab * 1.3; // fidelity ~0.27: below mergeBelow, above forgetBelow
  const events = await svc.compact(['a1']);
  const actions = events.map((e) => e.action);
  assert.ok(actions.includes('merged'), actions.join());
  const merged = events.find((e) => e.action === 'merged')!;
  assert.equal(merged.memory.kind, 'gist');
  assert.match(merged.memory.text, /^Ricordo vagamente che:/);
  clock.t += stab * 5;
  const later = await svc.compact(['a1']);
  assert.ok(later.some((e) => e.action === 'forgotten'));
  assert.ok(store.listByAgent('a1', 'mind').every((m) => m.kind === 'gist'));
});

test('stale embeddings are re-embedded', async () => {
  const { svc, store } = setup();
  const m = await svc.add({ agent: 'a1', text: 'prova di memoria' });
  store.update(m.id, { embedder: 'old', embedding: new Float32Array(3) });
  assert.equal(await svc.reembedStale(), 1);
  assert.equal(store.get(m.id)!.embedder, 'hash');
});

test('run events: ordered load, list, retention by maxRuns', async () => {
  const { store, cfg } = setup();
  cfg.runs.maxRuns = 2;
  cfg.runs.pruneEveryInserts = 1;
  store.appendRunEvents([{ runId: 'r1', n: 1 }, { runId: 'r1', n: 2 }], 1000);
  store.appendRunEvents([{ runId: 'r2', n: 1 }], 2000);
  store.appendRunEvents([{ runId: 'r3', n: 1 }], 3000);
  assert.deepEqual(store.listRuns(), ['r2', 'r3']);
  assert.deepEqual(store.loadRun('r2'), [{ runId: 'r2', n: 1 }]);
  store.appendRunEvents([{ runId: 'r3', n: 2 }], 3 * 3600e3 * 1000);
  assert.deepEqual(store.listRuns(), ['r3']);
});

test('size cap removes lowest-fidelity memories', async () => {
  const { store, svc, cfg } = setup();
  await svc.add({ agent: 'a1', text: 'uno due tre quattro' });
  cfg.db.maxBytes = 0;
  cfg.db.capBatch = 10;
  store.enforceCap(Date.now());
  assert.equal(store.count(), 0);
});
