import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planCompaction, type PlanMemory } from './compaction.ts';
import { testConfig } from './testing.ts';

const cfg = testConfig().compaction;
const now = 1e9;
let n = 0;
function mem(fidelity: number, emb: number[], extra: Partial<PlanMemory> = {}): PlanMemory {
  return { id: `m${n++}`, kind: 'episodic', importance: 0.5, blur_level: 0, pending_blur: 0, anchor_ms: now, anchor_fidelity: fidelity, stability_ms: 1e12, embedding: Float32Array.from(emb), ...extra };
}

test('forget below threshold wins over merge and blur', () => {
  const a = mem(0.05, [1, 0]);
  const b = mem(0.2, [1, 0]);
  const c = mem(0.2, [1, 0.01]);
  const plan = planCompaction([a, b, c], now, cfg);
  assert.deepEqual(plan.forget, [a.id]);
  assert.deepEqual(plan.merge, [[b.id, c.id]]);
  assert.deepEqual(plan.blur, []);
});

test('similar weak memories merge; dissimilar and singletons do not', () => {
  const a = mem(0.2, [1, 0]);
  const b = mem(0.25, [0, 1]);
  assert.deepEqual(planCompaction([a, b], now, cfg).merge, []);
});

test('blur follows blur_level thresholds and pending_blur', () => {
  const fresh = mem(0.9, [1, 0]);
  const mid = mem(0.5, [0, 1]);
  const done = mem(0.5, [1, 1], { blur_level: 1 });
  const low = mem(0.34, [1, -1], { blur_level: 1 });
  const flagged = mem(0.95, [-1, 1], { pending_blur: 1 });
  const exhausted = mem(0.31, [-1, -1], { blur_level: 2 });
  const plan = planCompaction([fresh, mid, done, low, flagged, exhausted], now, cfg);
  assert.deepEqual(plan.blur.sort(), [mid.id, low.id, flagged.id].sort());
});

test('cap forgets the lowest-value surplus', () => {
  const small = { ...cfg, maxMemoriesPerAgent: 2 };
  const ms = [mem(0.9, [1, 0]), mem(0.7, [0, 1]), mem(0.65, [1, 1])];
  assert.deepEqual(planCompaction(ms, now, small).forget, [ms[2]!.id]);
});
