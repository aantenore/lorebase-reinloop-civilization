import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryEvent } from '../../../ports/memory.ts';
import { InMemoryMemory, score } from './index.ts';

const settings = { enabled: true, recallLimit: 3, textMaxChars: 50, inmem: { pollMs: 60_000, fadePerHour: 1, forgetBelow: 0.2, maxPerOwner: 3, maxConversations: 10 } };
const at = { day: 1, minute: 10 };

test('score: shared words weighted by importance and fidelity', () => {
  const m = { text: 'Ho raccolto legna nel bosco', importance: 1, emotion: 0, fidelity: 1 };
  assert.ok(score(m, 'legna bosco') > score(m, 'legna mare'));
  assert.equal(score(m, 'pesce'), 0);
  assert.ok(score({ ...m, importance: 0 }, 'legna') < score(m, 'legna'));
  assert.ok(score({ ...m, fidelity: 0.5 }, 'legna') < score(m, 'legna'));
});

test('inmem memory: remember, recall by relevance, capacity, change feed', async () => {
  const mem = new InMemoryMemory(settings);
  const events: MemoryEvent[] = [];
  mem.watch((ev) => events.push(ev));
  await mem.remember('mara', 'Ho raccolto legna nel bosco a nord', { importance: 0.5, emotion: 0, at });
  await mem.remember('mara', 'Il fiume era gelato', { importance: 0.9, emotion: -0.5, at });
  await mem.remember('ilse', 'Legna secca vicino al fiume', { importance: 0.5, emotion: 0, at });
  const hits = await mem.recall('mara', 'dove trovo legna?');
  assert.deepEqual(hits!.map((h) => h.text), ['Ho raccolto legna nel bosco a nord']);
  assert.equal(hits![0]!.recalls, 1);
  assert.ok(events.some((e) => e.action === 'recalled' && e.agentId === 'mara'));
  for (const t of ['uno due tre', 'quattro cinque']) await mem.remember('mara', t, { importance: 0.1, emotion: 0, at });
  assert.equal((await mem.list('mara')).length, 3);
  assert.ok(events.some((e) => e.action === 'forgotten'));
  assert.equal((await mem.stats()).memories, 4);
  mem.stop();
});

test('inmem memory: fading blurs then forgets, important memories last longer', async () => {
  const mem = new InMemoryMemory(settings);
  const events: MemoryEvent[] = [];
  mem.watch((ev) => events.push(ev));
  const t0 = Date.now();
  mem.fade(t0);
  await mem.remember('a', 'banale', { importance: 0, emotion: 0, at });
  await mem.remember('a', 'importante', { importance: 1, emotion: 1, at });
  mem.fade(t0 + 0.6 * 3_600_000);
  assert.ok(events.some((e) => e.action === 'blurred' && e.memory.text === 'banale'));
  mem.fade(t0 + 0.9 * 3_600_000);
  const left = (await mem.list('a')).map((m) => m.text);
  assert.deepEqual(left, ['importante']);
  mem.stop();
});

test('inmem memory: conversations, deleteOwner, society persistence', async () => {
  const mem = new InMemoryMemory(settings);
  mem.converse({ from: 'Mara', to: 'Ilse', text: 'ciao', kind: 'speech', at });
  mem.converse({ from: 'Ilse', to: 'Mara', text: 'salve', kind: 'speech', at });
  assert.equal((await mem.conversations({ agent: 'Ilse' })).length, 2);
  await mem.remember('mara', 'x y z', { importance: 0.5, emotion: 0, at });
  assert.deepEqual(await mem.deleteOwner('mara', { speaker: 'Mara' }), { memories: 1, conversations: 1, runs: 0 });
  assert.equal((await mem.conversations({})).length, 1);
  const person = { name: 'Mara', prior: 0.5, esteem: 0.5, fame: 0, fameAt: 0, skills: {} };
  assert.equal(await mem.saveSociety('world/main', { clock: 1, people: [person, { ...person, name: 'Ilse' }], opinions: [{ from: 'Ilse', to: 'Mara', score: 1, reason: 'r', at: 1 }] }, 10), true);
  await mem.forgetPerson('world/main', 'Mara');
  const s = await mem.loadSociety('world/main');
  assert.deepEqual(s!.people.map((p) => p.name), ['Ilse']);
  assert.equal(s!.opinions.length, 0);
  assert.equal(await mem.loadSociety('other'), undefined);
});
