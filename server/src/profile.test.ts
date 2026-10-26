import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheParams, loadGameConfig } from './rt/config.ts';
import { applyRosterTiers, deepMerge, loadProfile } from './profile.ts';

test('profile: deep merge replaces arrays and scalars, merges objects', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, e: 2 }), { a: { b: 1, c: [3] }, d: 1, e: 2 });
});

test('profile: roster tiers by name, then "*"; an explicit model is dropped when the tier changes', () => {
  const r = applyRosterTiers([{ name: 'Ilse', tier: 'opus' as const, model: 'x' }, { name: 'Nia', tier: 'sonnet' as const }, { name: 'Pell', tier: 'haiku' as const, model: 'y' }], { '*': 'haiku', Ilse: 'sonnet' });
  assert.deepEqual(r, [{ name: 'Ilse', tier: 'sonnet' }, { name: 'Nia', tier: 'haiku' }, { name: 'Pell', tier: 'haiku', model: 'y' }]);
});

test('profile: economy keeps one sonnet, no opus, haiku group members and caching; unknown or unsafe names fail', () => {
  const env = { GAME_PROFILE: 'economy' };
  const p = loadProfile(env);
  assert.deepEqual(p.rosterTiers, { '*': 'haiku', Ilse: 'sonnet' });
  const cfg = loadGameConfig(env);
  assert.equal(cfg.groups.memberTier, 'haiku');
  assert.equal(cfg.crowd.count, 0);
  assert.ok(cfg.decisions.tiers.haiku.horizonFactor > loadGameConfig({}).decisions.tiers.haiku.horizonFactor);
  assert.deepEqual(cacheParams(cfg), { cache: true, cacheTtl: '5m' });
  assert.deepEqual(cacheParams({ promptCache: { enabled: false, ttl: '5m' } }), { cache: false });
  assert.deepEqual(cacheParams({ promptCache: { enabled: true, ttl: '5m', groupTtl: '1h' } }, true), { cache: true, cacheTtl: '1h' });
  assert.deepEqual(loadProfile({}), {});
  assert.throws(() => loadProfile({ GAME_PROFILE: '../x' }));
  assert.throws(() => loadProfile({ GAME_PROFILE: 'missing' }));
});
