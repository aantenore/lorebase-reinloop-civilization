import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Revision } from '../../../ports/knowledge.ts';
import { MemoryKnowledge } from './index.ts';

const cfg = { space: 'world', live: 'main', historyMax: 100 };
const rule = (code: string, value: number) => ({ action: 'upsert' as const, kind: 'Rule', key: code, values: { code, value, text: `law ${code}`, category: 'survival' } });

function seeded(): MemoryKnowledge {
  return new MemoryKnowledge(cfg, {
    live: [[rule('max_hp', 10), rule('food_per_tick', 1)]],
    scopes: { 'nature/hidden': [[{ action: 'upsert', kind: 'Technology', key: 'fire', values: { code: 'fire', name: 'Fuoco' } }]] },
  });
}

test('memory knowledge: seed, direct writes as revisions, history and overview', async () => {
  const k = seeded();
  const before = await k.readAll('Rule');
  assert.equal(before.items.length, 2);
  const rev = await k.write([{ action: 'update', kind: 'Rule', key: 'max_hp', values: { value: 12 } }], { message: 'Set max_hp' });
  assert.notEqual(rev, before.revision);
  assert.equal((await k.read('Rule', 'max_hp'))?.values.value, 12);
  assert.equal((await k.read('Rule', 'max_hp'))?.values.text, 'law max_hp');
  const h = await k.history(5);
  assert.equal(h[0]!.message, 'Set max_hp');
  assert.deepEqual(h[0]!.kinds, ['Rule']);
  assert.deepEqual((await k.overview(['Rule', 'Role'])).counts, { Rule: 2, Role: 0 });
  await assert.rejects(k.write([{ action: 'create', kind: 'Rule', key: 'max_hp', values: {} }], { message: 'dup' }));
  assert.equal((await k.read('Rule', 'max_hp'))?.values.value, 12, 'a refused change leaves the live world untouched');
});

test('memory knowledge: the hidden scope is separate, consultations read the live world only', async () => {
  const k = seeded();
  assert.equal(await k.hasScope('nature/hidden'), true);
  assert.equal((await k.readAll('Technology', { scope: 'nature/hidden' })).items.length, 1);
  assert.equal((await k.readAll('Technology')).items.length, 0);
  assert.equal((await k.readAll('Rule', { scope: 'nature/hidden' })).items.length, 2, 'a scope starts as a copy of the live world');
  const tools = new Map(k.consult.tools().map((t) => [t.name, t]));
  const search = await tools.get('conoscenza_cerca')!.call({ query: 'fuoco fire' });
  assert.equal(search.content, 'no results');
  const read = await tools.get('conoscenza_leggi')!.call({ ref: 'Rule/max_hp' });
  assert.ok(read.content.includes('value=10'), read.content);
  assert.equal((await tools.get('conoscenza_leggi')!.call({ ref: 'Technology/fire' })).isError, true);
});

test('memory knowledge: propose -> review -> accept replays the draft as one revision and notifies watchers', async () => {
  const k = seeded();
  const seen: Array<Revision | undefined> = [];
  let head = (await k.readAll('Rule')).revision;
  const w = k.watch({ kinds: ['Rule'], since: () => head }, { onRevision: (r) => seen.push(r), onStatus: () => undefined });
  const p = await k.propose({
    draft: 'law/new-x', title: 'New law', message: 'New law x',
    changes: [{ action: 'create', kind: 'Rule', key: 'x', values: { code: 'x', value: 1, text: 'x', category: 'society' } }],
  });
  assert.deepEqual(await k.drafts('law/'), ['law/new-x']);
  assert.equal((await k.read('Rule', 'x', { scope: p.draft }))?.values.value, 1);
  assert.equal(await k.read('Rule', 'x'), undefined, 'not live before acceptance');
  await k.write([{ action: 'update', kind: 'Rule', key: 'x', values: { value: 2 } }], { scope: p.draft, message: 'revise' });
  await k.review(p.id, 'approve', 'ok');
  head = await k.accept(p.id, 'Accept x');
  assert.equal((await k.read('Rule', 'x'))?.values.value, 2);
  assert.equal((await k.proposal(p.id))?.status, 'accepted');
  assert.deepEqual(await k.drafts('law/'), []);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(seen.some((r) => r?.message === 'Accept x'), JSON.stringify(seen));
  w.stop();
  await assert.rejects(k.accept(p.id, 'again'));
});

test('memory knowledge: reject discards the draft; snapshot + removeMany + propose with a prepared draft', async () => {
  const k = seeded();
  const p = await k.propose({ draft: 'role/x', title: 't', message: 'm', changes: [{ action: 'create', kind: 'Insight', key: 'i1', values: { code: 'i1' } }] });
  await k.reject(p.id, 'no');
  assert.equal((await k.proposal(p.id))?.status, 'rejected');
  assert.equal(await k.hasScope('role/x'), false);
  assert.deepEqual((await k.proposals('rejected')).map((x) => x.id), [p.id]);

  await k.snapshot('reset/1');
  assert.equal(await k.removeMany('Rule', ['max_hp', 'missing'], { scope: 'reset/1', message: 'remove' }), 2);
  const r = await k.propose({ draft: 'reset/1', title: 'Reset', message: 'Reset', changes: [] });
  await k.accept(r.id, 'Reset');
  assert.deepEqual((await k.readAll('Rule')).items.map((x) => x.key), ['food_per_tick']);
  await assert.rejects(k.discardDraft('main'));
});
