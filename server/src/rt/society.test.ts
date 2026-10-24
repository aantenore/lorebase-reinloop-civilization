import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askError, giveAsked, offerError, OfferBook, offerMinutes, swap } from './barter.ts';
import { type Catalog, resourceFrom } from './economy.ts';
import { lawDraft } from './law-proposals.ts';
import { bagOf } from './plan.ts';
import { computeEsteem, esteemWeight, rankPeople, Society, Testimonies, weightedWinner } from './society.ts';
import { type RtEntity, type RtRuleKey, tooComplexForChild } from './world.ts';

const RULES: Partial<Record<RtRuleKey, number>> = {
  esteem_prior: 0.5, esteem_prior_weight: 2, opinion_half_life_days: 3, esteem_judge_weight: 1, elder_esteem_weight: 1.5,
  reputation_inheritance: 0.3, fame_gift: 1, fame_recipe_supply: 2, fame_insight_accepted: 3, fame_discovery: 5, fame_law_enacted: 4,
  fame_law_respected: 0.5, fame_law_breached: -1.5,
  fame_half_life_days: 10, esteem_vote_weight: 1,
};
const r = (k: RtRuleKey) => RULES[k] ?? 0;

const catalog = (): Catalog => ({
  resources: new Map([
    resourceFrom({ code: 'food', name: 'Cibo', category: 'food', perishable: false, nourish: 1, source: 'tile' }),
    resourceFrom({ code: 'flint', name: 'Selce', category: 'material', perishable: false, source: 'biome' }),
  ].map((x) => [x.code, x])),
  recipes: new Map(),
  techs: new Map(),
});
const person = (id: string, inv: Record<string, number>, kind: RtEntity['kind'] = 'agent') =>
  ({ id, name: id, role: 'gatherer', kind, alive: true, inventory: { food: 0, wood: 0, ...inv }, tools: [] }) as unknown as RtEntity;

test('barter: offers are validated, swapped all or nothing, and expire', () => {
  const c = catalog();
  const a = person('a', { flint: 2 });
  const b = person('b', { food: 3 });
  const limits = { maxKinds: 2, maxPending: 1 };
  assert.equal(offerError(c, a, b, { flint: 1 }, { food: 1 }, limits, 0), undefined);
  assert.equal(offerError(c, a, b, { flint: 5 }, { food: 1 }, limits, 0), 'nothing_to_give');
  assert.equal(offerError(c, a, b, {}, { food: 1 }, limits, 0), 'empty_offer');
  assert.equal(offerError(c, a, b, { stone: 1 }, { food: 1 }, limits, 0), 'unknown_item');
  assert.equal(offerError(c, a, a, { flint: 1 }, { food: 1 }, limits, 0), 'no_such_person');
  assert.equal(offerError(c, a, b, { flint: 1 }, { food: 1 }, limits, 1), 'too_many_offers');
  assert.equal(swap(c, { give: { flint: 1 }, want: { food: 5 } }, a, b), 'missing_inputs');
  assert.deepEqual([a.inventory.flint, b.inventory.food], [2, 3]);
  assert.equal(swap(c, { give: { flint: 2 }, want: { food: 3 } }, a, b), undefined);
  assert.deepEqual([a.inventory.flint, a.inventory.food, b.inventory.flint, b.inventory.food], [0, 3, 2, 0]);
  const book = new OfferBook();
  const o = book.add({ from: 'a', to: 'b', give: { flint: 1 }, want: { food: 1 }, madeAt: 0, expiresAt: 60 });
  assert.equal(book.pendingFor('b').length, 1);
  assert.deepEqual(book.stale(30, () => true), []);
  assert.deepEqual(book.stale(60, () => true).map((x) => x.id), [o.id]);
  book.close(o, 'expired');
  assert.equal(book.pendingFor('b').length, 0);
  assert.equal(offerMinutes(60, 1, 0.5), 60);
  assert.equal(offerMinutes(60, 1, 1), 120);
  assert.equal(offerMinutes(60, 1, 0), 15);
});

test('bagOf reads objects, lists and strings', () => {
  assert.deepEqual(bagOf({ flint: 2, 'Bad Code': 1, food: 0 }), { flint: 2 });
  assert.deepEqual(bagOf([{ item: 'rope', amount: 2 }, 'food']), { rope: 2, food: 1 });
  assert.deepEqual(bagOf('flint:2, food'), { flint: 2, food: 1 });
  assert.equal(bagOf({}), undefined);
});

test('esteem: decayed weighted opinions, judges weigh by their esteem, elders more', () => {
  const people = [{ id: 'a', prior: 0.5 }, { id: 'b', prior: 0.5 }, { id: 'c', prior: 0.5 }];
  const none = computeEsteem(people, [], r, 0, new Map(), () => 'adult');
  assert.equal(none.get('a'), 0.5);
  const ops = [{ from: 'a', to: 'b', score: 1, reason: '', at: 0 }, { from: 'c', to: 'b', score: -1, reason: '', at: 0 }];
  const even = computeEsteem(people, ops, r, 0, new Map(), () => 'adult');
  assert.equal(even.get('b'), 0.5);
  const respected = computeEsteem(people, ops, r, 0, new Map([['a', 0.9], ['c', 0.2]]), () => 'adult');
  assert.ok(respected.get('b')! > 0.5);
  const elder = computeEsteem(people, ops, r, 0, new Map(), (id) => (id === 'a' ? 'elder' : 'adult'));
  assert.ok(elder.get('b')! > 0.5);
  // The latest opinion of a judge replaces its earlier ones; old opinions fade.
  const changed = computeEsteem(people, [...ops, { from: 'a', to: 'b', score: -1, reason: '', at: 10 }], r, 10, new Map(), () => 'adult');
  assert.ok(changed.get('b')! < 0.5);
  const faded = computeEsteem(people, [{ from: 'a', to: 'b', score: 1, reason: '', at: 0 }], r, 1440 * 30, new Map(), () => 'adult');
  assert.ok(faded.get('b')! - 0.5 < 0.01);
  assert.equal(esteemWeight(0.5, 1), 1);
  assert.equal(esteemWeight(0, 2), 0);
  assert.deepEqual([...rankPeople([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], new Map([['a', 0.4], ['b', 0.6]]), new Map()).entries()], [['b', 1], ['a', 2]]);
  assert.deepEqual(weightedWinner([0, 1, 1], [3, 1, 1], 2).winner, 0);
});

test('society: inheritance, fame, families and hearsay', () => {
  const s = new Society(r, { maxOpinions: 10, hearsayKept: 2 });
  s.add({ id: 'a', name: 'Ada', role: 'gatherer', tier: 'haiku', kind: 'agent', bornAt: 0, parents: null });
  s.add({ id: 'b', name: 'Bruno', role: 'builder', tier: 'haiku', kind: 'agent', bornAt: 0, parents: null });
  s.esteem.set('a', 0.8);
  const kid = s.add({ id: 'k', name: 'Kai', role: 'gatherer', tier: 'haiku', kind: 'agent', bornAt: 0, parents: ['a', 'b'] });
  assert.equal(kid.prior, 0.3 * 0.65);
  const { family, founded } = s.familyForBirth('k', 'a', 'b', 3, (n) => `Casata di ${n}`, 's1');
  assert.ok(founded);
  assert.equal(family.founder, 'a');
  assert.equal(family.name, 'Casata di Ada');
  assert.deepEqual(family.members, ['a', 'b', 'k']);
  s.add({ id: 'k2', name: 'Lia', role: 'gatherer', tier: 'haiku', kind: 'agent', bornAt: 0, parents: ['a', 'b'] });
  const again = s.familyForBirth('k2', 'a', 'b', 4, (n) => n, 's1');
  assert.equal(again.founded, false);
  assert.equal(again.family.id, family.id);
  s.deed('a', 'gift', 0);
  s.deed('a', 'discovery', 0);
  assert.equal(s.fameOf('a', 0), 6);
  assert.equal(s.fameOf('a', 1440 * 10), 3);
  s.died('b', 100);
  assert.equal(s.familyDto(family).alive, 3);
  s.hear(['b', 'k'], { about: 'a', from: 'Bruno', text: 'generosa', at: 0 });
  assert.equal(s.hearsayOf('k', 'a').length, 1);
  s.recompute(0);
  assert.ok(s.ranks.has('a') && !s.ranks.has('b'));
});

test('law drafts and children recipes', () => {
  assert.deepEqual(lawDraft({ text: 'Si divide il cibo', category: 'society' }, 100, 1), { key: 'legge_si_divide_il_cibo', text: 'Si divide il cibo', category: 'society', value: 1 });
  assert.deepEqual(lawDraft({ text: 'x', category: 'magic' }, 100, 1), { error: 'category' });
  assert.deepEqual(lawDraft({ text: '', category: 'society' }, 100, 1), { error: 'empty' });
  assert.equal(lawDraft({ key: 'sharing_allowed', text: 'no', category: 'society', value: 0 }, 100, 1).key, 'sharing_allowed');
  assert.equal(tooComplexForChild({ tools: [], station: null, inputs: { a: 1, b: 1 } }, 2), false);
  assert.equal(tooComplexForChild({ tools: ['knife'], station: null, inputs: { a: 1 } }, 2), true);
  assert.equal(tooComplexForChild({ tools: [], station: null, inputs: { a: 3 } }, 2), true);
});

test('ask: nothing offered, the target gives what was asked all or nothing', () => {
  const c = catalog();
  const a = person('a', {});
  const b = person('b', { food: 2, flint: 1 });
  const limits = { maxKinds: 2, maxPending: 1 };
  assert.equal(askError(c, a, b, { food: 1 }, limits, 0), undefined);
  assert.equal(askError(c, a, b, {}, limits, 0), 'empty_ask');
  assert.equal(askError(c, a, b, { stone: 1 }, limits, 0), 'unknown_item');
  assert.equal(askError(c, a, a, { food: 1 }, limits, 0), 'no_such_person');
  assert.equal(askError(c, a, b, { food: 1 }, limits, 1), 'too_many_offers');
  assert.equal(giveAsked(c, { food: 1, flint: 2 }, b, a), 'nothing_to_give');
  assert.deepEqual([a.inventory.food, b.inventory.food], [0, 2]);
  assert.equal(giveAsked(c, { food: 2 }, b, a), undefined);
  assert.deepEqual([a.inventory.food, b.inventory.food], [2, 0]);
});

test('society: snapshot and restore by name, with clocks shifted and the dead left out', () => {
  const s = new Society(r, { maxOpinions: 100, hearsayKept: 5, familyColors: ['#111', '#222'] });
  for (const id of ['a', 'b', 'c']) s.add({ id, name: id.toUpperCase(), role: 'gatherer', tier: 'haiku', kind: 'agent', bornAt: 0, parents: null });
  s.opinion({ from: 'a', to: 'b', score: 1, reason: 'brava', at: 900 });
  s.opinion({ from: 'c', to: 'a', score: -1, reason: 'avaro', at: 950 });
  s.deed('a', 'discovery', 1000);
  s.died('c', 1000);
  const snap = s.snapshot(1000, (id) => (id === 'a' ? { bread: 3 } : {}));
  assert.deepEqual(snap.people.map((p) => p.name), ['A', 'B']);
  assert.equal(snap.opinions.length, 2);
  const t = new Society(r, { maxOpinions: 100, hearsayKept: 5 });
  for (const id of ['x', 'y']) t.add({ id, name: id === 'x' ? 'A' : 'B', role: 'gatherer', tier: 'haiku', kind: 'agent', bornAt: 0, parents: null });
  const skills = t.restore(snap, 400);
  assert.deepEqual(skills.get('x'), { bread: 3 });
  assert.equal(t.fameOf('x', 400), 5);
  assert.deepEqual(t.opinions.map((o) => [o.from, o.to, o.at]), [['x', 'y', 300]]);
  const fam = s.familyForBirth('a', 'a', 'b', 1, (n) => `Casa ${n}`, 's');
  assert.equal(s.familyDto(fam.family).color, '#111');
});

test('society: families survive a restart with the members present, founder by name', () => {
  const s = new Society(r, { maxOpinions: 10, hearsayKept: 2, familyColors: ['#111', '#222'] });
  for (const [id, name] of [['a', 'Ada'], ['b', 'Bruno'], ['c', 'Cira']]) s.add({ id, name, role: 'gatherer', tier: 'haiku', kind: 'agent', bornAt: 0, parents: null });
  s.esteem.set('a', 0.9);
  const { family } = s.familyForBirth('c', 'a', 'b', 2, (n) => `Casata di ${n}`, 's1');
  s.died('b', 10);
  const snap = s.snapshot(100, () => ({}));
  assert.deepEqual(snap.families, [{ id: family.id, name: 'Casata di Ada', founder: 'Ada', members: ['Ada', 'Cira'], foundedDay: 2, color: '#111' }]);
  const t = new Society(r, { maxOpinions: 10, hearsayKept: 2, familyColors: ['#111', '#222'] });
  t.add({ id: 'x', name: 'Ada', role: 'gatherer', tier: 'haiku', kind: 'agent', bornAt: 0, parents: null });
  t.add({ id: 'y', name: 'Dino', role: 'gatherer', tier: 'haiku', kind: 'agent', bornAt: 0, parents: null });
  t.add({ id: 'z', name: 'Eva', role: 'gatherer', tier: 'haiku', kind: 'agent', bornAt: 0, parents: null });
  t.restore(snap, 0);
  const back = t.families.get(family.id)!;
  assert.deepEqual([back.founder, back.members, t.people.get('x')!.family], ['x', ['x'], family.id]);
  const next = t.familyForBirth('n', 'y', 'z', 3, (n) => n, 's2');
  assert.equal(t.familyDto(next.family).color, '#222');
});

test('testimonies: one per witness, fame both ways, a breach chronicled once at enough witnesses', () => {
  const s = new Society(r, { maxOpinions: 100, hearsayKept: 5 });
  s.add({ id: 'a', name: 'A', role: 'gatherer', tier: 'haiku', kind: 'agent', bornAt: 0, parents: null });
  s.deed('a', 'law_respected', 0);
  assert.equal(s.fameOf('a', 0), 0.5);
  s.deed('a', 'law_breached', 0);
  assert.equal(s.fameOf('a', 0), 0);
  const tm = new Testimonies({ windowMinutes: 100, minWitnesses: 2, maxKept: 50 });
  const tell = (witness: string, at: number, kept = false) => tm.add({ witness, who: 'a', law: 'tithe', kept, reason: '', at });
  assert.deepEqual(tell('w1', 10), { breachWitnesses: null });
  assert.deepEqual(tell('w1', 20), { error: 'duplicate' });
  assert.deepEqual(tell('w2', 30), { breachWitnesses: ['w1', 'w2'] });
  assert.deepEqual(tell('w3', 40), { breachWitnesses: null });
  assert.deepEqual(tell('w4', 50, true), { breachWitnesses: null });
  assert.deepEqual(tell('w1', 300), { breachWitnesses: null });
});
