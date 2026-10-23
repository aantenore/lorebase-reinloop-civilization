import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addItems, applyCraft, barter, canCraft, type Catalog, count, experiment, knownItem, newInventory, Flows, gatherTool, type Holder, matchDiscovery, recipeFrom, resourceFrom,
  spoil, stationsOf, techFrom, transfer, wearStructures,
} from './economy.ts';

const catalog = (): Catalog => ({
  resources: new Map([
    resourceFrom({ code: 'food', name: 'Cibo', category: 'food', perishable: true, decay_per_day: 0.5, nourish: 1, source: 'tile' }),
    resourceFrom({ code: 'flint', name: 'Selce', category: 'material', perishable: false, source: 'biome', biomes: ['sand'], gather_yield: 1 }),
    resourceFrom({ code: 'seeds', name: 'Semi', category: 'material', perishable: false, source: 'biome', biomes: ['grass'], min_distance: 9 }),
    resourceFrom({ code: 'axe', name: 'Ascia', category: 'tool', perishable: false, source: 'craft', durability: 2, boosts: ['wood'], boost: 2 }),
    resourceFrom({ code: 'hearth', name: 'Focolare', category: 'structure', perishable: false, source: 'craft', durability: 2, decay_per_day: 1 }),
  ].map((r) => [r.code, r])),
  recipes: new Map([
    recipeFrom({ code: 'axe', role: 'crafter', inputs: { flint: 2 }, outputs: { axe: 1 }, minutes: 10 }),
    recipeFrom({ code: 'hearth', role: 'builder', inputs: { flint: 1 }, outputs: { hearth: 1 }, tools: ['axe'], station: 'shelter', minutes: 10 }),
    recipeFrom({ code: 'sowing', role: 'gatherer', inputs: { seeds: 2, food: 1 }, outputs: { food: 8 }, minutes: 60 }, 'farming'),
  ].map((r) => [r.code, r])),
  techs: new Map([techFrom({ code: 'farming', name: 'Coltivazione', description: '' })].map((t) => [t.code, t])),
});

const holder = (role: string, inv: Record<string, number> = {}): Holder => ({ role, inventory: { food: 0, wood: 0, ...inv }, tools: [] });
const none = new Set<string>();

test('craft validation: role, station, tools, inputs, hidden recipes', () => {
  const c = catalog();
  const crafter = holder('crafter', { flint: 2 });
  assert.deepEqual(canCraft(c, crafter, 'nope', { stations: none, discovered: none }), { error: 'unknown_recipe' });
  assert.deepEqual(canCraft(c, holder('builder', { flint: 2 }), 'axe', { stations: none, discovered: none }), { error: 'wrong_role' });
  assert.deepEqual(canCraft(c, holder('gatherer', { seeds: 2, food: 1 }), 'sowing', { stations: none, discovered: none }), { error: 'unknown_recipe' });
  assert.ok('recipe' in canCraft(c, holder('gatherer', { seeds: 2, food: 1 }), 'sowing', { stations: none, discovered: new Set(['farming']) }));
  const ok = canCraft(c, crafter, 'axe', { stations: none, discovered: none });
  assert.ok('recipe' in ok);
  const out = applyCraft(c, crafter, ok.recipe, 1);
  assert.equal(crafter.inventory.flint, 0);
  assert.equal(crafter.inventory.axe, 1);
  assert.equal(crafter.tools.length, 1);
  assert.deepEqual(out.outputs, { axe: 1 });
  const builder = holder('builder', { flint: 2 });
  assert.deepEqual(canCraft(c, builder, 'hearth', { stations: none, discovered: none }), { error: 'missing_station' });
  const shelter = stationsOf({ shelter: 1 });
  assert.deepEqual(canCraft(c, builder, 'hearth', { stations: shelter, discovered: none }), { error: 'missing_tool' });
  assert.equal(transfer(c, crafter, builder, 'axe', 1), 1);
  assert.equal(builder.tools.length, 1);
  const r = canCraft(c, builder, 'hearth', { stations: shelter, discovered: none });
  assert.ok('recipe' in r);
  const built = applyCraft(c, builder, r.recipe, 1);
  assert.deepEqual(built.structures, { hearth: 1 });
  assert.equal(builder.tools[0]!.durability, 1);
  applyCraft(c, builder, r.recipe, 1);
  assert.equal(builder.tools.length, 0, 'tool broke');
  assert.equal(builder.inventory.axe, 0);
});

test('discovery: input set match, prerequisites, consumption', () => {
  const c = catalog();
  assert.equal(matchDiscovery(c, none, ['food', 'seeds'])?.tech.code, 'farming');
  assert.equal(matchDiscovery(c, none, ['seeds']), undefined);
  assert.equal(matchDiscovery(c, new Set(['farming']), ['food', 'seeds']), undefined);
  c.techs.get('farming')!.prerequisites.push('pottery');
  assert.equal(matchDiscovery(c, none, ['food', 'seeds']), undefined);
  c.techs.get('farming')!.prerequisites.pop();
  const h = holder('explorer', { seeds: 1, food: 2 });
  assert.deepEqual(experiment(c, h, ['seeds'], none, 2), { ok: false, error: 'too_few_items' });
  const out = experiment(c, h, ['seeds', 'food'], none, 2);
  assert.ok(out.ok && out.found?.tech.code === 'farming');
  assert.equal(h.inventory.seeds, 0);
  assert.equal(h.inventory.food, 1);
  assert.deepEqual(experiment(c, h, ['seeds', 'food'], none, 2), { ok: false, error: 'missing_inputs' });
});

test('decay: perishables spoil over days, structures wear out', () => {
  const c = catalog();
  const h = holder('gatherer', { food: 4, flint: 3 });
  const acc = {};
  assert.deepEqual(spoil(c, h, acc, 360, 1440), {}); // 4 * 0.5 * 0.25 = 0.5
  assert.deepEqual(spoil(c, h, acc, 360, 1440), { food: 1 });
  assert.equal(h.inventory.food, 3);
  assert.equal(h.inventory.flint, 3);
  const st = { hearth: 2 };
  assert.deepEqual(wearStructures(c, st, 1440, 1440), []);
  assert.deepEqual(wearStructures(c, st, 1440, 1440), ['hearth']);
  assert.deepEqual(st, {});
});

test('tools boost gathering; barter is all or nothing; flows aggregate', () => {
  const c = catalog();
  const h = holder('builder');
  addItems(h, 'axe', 1, c.resources.get('axe'));
  assert.equal(gatherTool(c, h, 'wood')?.boost, 2);
  assert.equal(gatherTool(c, h, 'food'), undefined);
  const a = holder('crafter', { flint: 2 });
  const b = holder('gatherer', { food: 3 });
  assert.equal(barter(c, a, b, { flint: 2 }, { food: 5 }), false);
  assert.equal(a.inventory.flint, 2);
  assert.equal(barter(c, a, b, { flint: 2 }, { food: 3 }), true);
  assert.deepEqual([a.inventory.food, b.inventory.flint], [3, 2]);
  const f = new Flows();
  f.add('gatherer', 'crafter', 'flint', 2);
  f.add('gatherer', 'crafter', 'flint', 1);
  f.add('crafter', 'builder', 'axe', 1);
  assert.deepEqual(f.take(), [{ fromRole: 'gatherer', toRole: 'crafter', item: 'flint', amount: 3 }, { fromRole: 'crafter', toRole: 'builder', item: 'axe', amount: 1 }]);
  assert.deepEqual(f.take(), []);
});

test('hostile item codes and amounts never reach object internals or fail open', () => {
  const c = catalog();
  const h: Holder = { role: 'crafter', inventory: newInventory(), tools: [] };
  assert.equal(Object.getPrototypeOf(h.inventory), null);
  for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(count(h, bad), 0);
    assert.equal(knownItem(c, bad), false);
    addItems(h, bad, 5);
  }
  assert.deepEqual(Object.keys(h.inventory).sort(), ['food', 'wood']);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  addItems(h, 'flint', Number.NaN);
  addItems(h, 'flint', Number.POSITIVE_INFINITY);
  assert.equal(count(h, 'flint'), 0);
  h.inventory.flint = Number.NaN;
  assert.equal(count(h, 'flint'), 0);
  h.inventory.flint = 3;
  const b: Holder = { role: 'builder', inventory: newInventory(), tools: [] };
  assert.equal(transfer(c, h, b, 'flint', Number.NaN), 0);
  assert.equal(transfer(c, h, b, 'flint', -2), 0);
  assert.equal(transfer(c, h, b, 'flint', Number.POSITIVE_INFINITY), 0);
  assert.equal(transfer(c, h, b, 'flint', 3), 3);
  assert.equal(transfer(c, h, b, 'constructor', 1), 0);
  assert.deepEqual(experiment(c, b, ['__proto__', 'flint'], none, 2), { ok: false, error: 'missing_inputs' });
  assert.equal(count(b, 'flint'), 3, 'nothing consumed by a rejected experiment');
});
