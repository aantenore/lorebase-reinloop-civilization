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

test('forgetAgent removes the memories, events, spoken lines and runs of one agent only', async () => {
  const { svc, store } = setup();
  await svc.add({ agent: 'mara', text: 'La legge del saluto è stata proclamata' });
  await svc.add({ agent: 'ilse', text: 'Il fiume è in piena' });
  store.appendConversations([
    { from: 'Mara', to: 'Ilse', text: 'Salve', kind: 'speech', at: { day: 1, minute: 1 } },
    { from: 'Ilse', to: 'Mara', text: 'Salve, sorella', kind: 'speech', at: { day: 1, minute: 2 } },
  ], 1000, 100);
  store.appendRunEvents([{ runId: 'r1', type: 'run_start', data: { agent: 'a2' } }, { runId: 'r2', type: 'run_start', data: { agent: 'a1' } }], 1000);
  const out = store.forgetAgent('mara', { speaker: 'Mara', runAgent: 'a2', vacuum: true });
  assert.deepEqual(out, { memories: 1, conversations: 1, runs: 1 });
  assert.equal(svc.list('mara').length, 0);
  assert.equal(svc.list('ilse').length, 1);
  assert.deepEqual(await svc.recall({ agent: 'mara', query: 'legge saluto' }), []);
  assert.ok(store.eventsSince(0, 100).every((e) => e.agent !== 'mara'));
  assert.deepEqual(store.conversations({ limit: 10 }).map((c) => c.from), ['Ilse']);
  assert.deepEqual(store.listRuns(), ['r2']);
});

test('society: saved per world, opinions capped, a dead judge forgotten but opinions about it kept', () => {
  const { store } = setup();
  const p = (name: string, fame = 0) => ({ name, prior: 0.5, esteem: 0.6, fame, fameAt: 100, skills: { bread: 2 } });
  assert.equal(store.societyLoad('w/main'), undefined);
  store.societySave('w/main', { clock: 500, people: [p('Ilse', 3), p('Mara')], opinions: [{ from: 'Ilse', to: 'Mara', score: 0.8, reason: 'generosa', at: 400 }] }, 2, 1);
  store.societySave('w/main', { clock: 900, people: [p('Ilse', 4)], opinions: [{ from: 'Mara', to: 'Ilse', score: -0.2, reason: 'avara', at: 800 }, { from: 'Mara', to: 'Ilse', score: 0.1, reason: 'meglio', at: 850 }] }, 2, 2);
  store.societySave('other', { clock: 1, people: [p('Ilse')], opinions: [] }, 10, 3);
  const s = store.societyLoad('w/main')!;
  assert.equal(s.clock, 900);
  assert.deepEqual(s.people.map((x) => [x.name, x.fame, x.skills.bread]), [['Ilse', 4, 2], ['Mara', 0, 2]]);
  assert.deepEqual(s.opinions.map((o) => o.reason), ['avara', 'meglio']);
  store.societySave('w/main', { clock: 950, people: [], opinions: [{ from: 'Ilse', to: 'Mara', score: 1, reason: 'cara', at: 940 }] }, 10, 4);
  assert.deepEqual(store.societyForget('w/main', 'Mara'), { people: 1, opinions: 2 });
  const after = store.societyLoad('w/main')!;
  assert.deepEqual(after.people.map((x) => x.name), ['Ilse']);
  assert.deepEqual(after.opinions.map((o) => [o.from, o.to]), [['Ilse', 'Mara']]);
  assert.equal(store.societyLoad('other')!.people.length, 1);
  assert.deepEqual(after.families, []);
  const fam = { id: 's1-f1', name: 'Casata di Ilse', founder: 'Ilse', members: ['Ilse'], foundedDay: 2 };
  store.societySave('w/main', { clock: 990, people: [], opinions: [], families: [fam] }, 10, 5);
  assert.deepEqual(store.societyLoad('w/main')!.families, [fam]);
});
