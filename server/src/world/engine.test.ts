import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseYaml } from 'reinloop';
import { fileURLToPath } from 'node:url';
import { loadTemplates, translator } from '../i18n.ts';
import { missingRules, seasonOf, World } from './engine.ts';
import type { Rules, WorldGenConfig } from './types.ts';

const root = new URL('../../../', import.meta.url);
const sim = JSON.parse(readFileSync(new URL('config/sim.json', root), 'utf8'));
const seed = parseYaml(readFileSync(new URL('lorebase/rules.seed.yaml', root), 'utf8')) as { rules: Array<{ code: string; value: number }> };
const RULES: Rules = Object.fromEntries(seed.rules.map((r) => [r.code, r.value]));
const CFG: WorldGenConfig = sim.world;
const T = translator(loadTemplates(fileURLToPath(root), 'en'));
const spec = (name: string) => ({ name, role: 'gatherer', tier: 'haiku' as const, model: 'mock' });

test('seed rules cover every rule the engine reads', () => {
  assert.deepEqual(missingRules(RULES), []);
});

test('same seed gives the same world', () => {
  const a = new World(CFG, T, 42);
  const b = new World(CFG, T, 42);
  assert.deepEqual(a.tiles, b.tiles);
  assert.notDeepEqual(a.tiles, new World(CFG, T, 43).tiles);
});

test('seasons follow the year rules', () => {
  const r = { ...RULES, winter_every_ticks: 8, winter_length_ticks: 2 };
  assert.equal(seasonOf(1, r), 'spring');
  assert.equal(seasonOf(6, r), 'winter');
  assert.equal(seasonOf(7, r), 'winter');
  assert.equal(seasonOf(8, r), 'spring');
});

test('actions spend action points and gather from the tile', () => {
  const w = new World(CFG, T, 7);
  const p = w.spawn(spec('Ada'), RULES);
  w.beginTick(RULES);
  const t = w.tile(p.x, p.y)!;
  t.food = 10;
  const res = w.gather(p.id, 'food', RULES);
  assert.ok(res.ok, res.text);
  assert.equal(p.inventory.food, RULES.gather_food_yield);
  assert.equal(p.actionsLeft, RULES.actions_per_tick! - 1);
  w.rest(p.id, RULES);
  assert.equal(w.rest(p.id, RULES).ok, false);
});

test('starvation kills and sharing can be forbidden', () => {
  const w = new World(CFG, T, 9);
  const a = w.spawn(spec('Ada'), RULES);
  const b = w.spawn(spec('Bo'), RULES, { at: { x: a.x, y: a.y } });
  w.beginTick({ ...RULES, sharing_allowed: 0 });
  a.inventory.food = 3;
  assert.equal(w.give(a.id, 'Bo', 'food', 1, { ...RULES, sharing_allowed: 0 }).ok, false);
  assert.equal(w.give(a.id, 'Bo', 'food', 1, RULES).ok, true);
  assert.equal(b.inventory.food, 1);
  a.hp = 1;
  a.hunger = RULES.starvation_threshold!;
  const out = w.endTick({ ...RULES, winter_length_ticks: 0 });
  assert.equal(a.alive, false);
  assert.ok(out.events.some((e) => e.kind === 'death'));
});

test('cold hurts only the unsheltered in winter', () => {
  const w = new World(CFG, T, 11);
  const a = w.spawn(spec('Ada'), RULES);
  const b = w.spawn(spec('Bo'), RULES);
  w.tile(a.x, a.y)!.shelter = true;
  const winter = { ...RULES, winter_every_ticks: 2, winter_length_ticks: 2 };
  w.beginTick(winter);
  w.endTick(winter);
  assert.equal(a.hp, RULES.max_hp);
  assert.equal(b.hp, RULES.max_hp! - RULES.cold_damage_unsheltered!);
});

test('two fed people on a shelter with enough food have a child', () => {
  const w = new World(CFG, T, 13);
  const a = w.spawn(spec('Ada'), RULES);
  const b = w.spawn(spec('Bo'), RULES, { at: { x: a.x, y: a.y } });
  w.tile(a.x, a.y)!.shelter = true;
  a.inventory.food = RULES.birth_food_cost!;
  w.tick = RULES.winter_every_ticks!;
  w.beginTick(RULES);
  const out = w.endTick(RULES);
  assert.equal(out.births.length, 1);
  assert.equal(out.births[0]!.generation, 1);
  assert.equal(a.inventory.food + b.inventory.food, 0);
});
