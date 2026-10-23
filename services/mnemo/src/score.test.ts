import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bm25Norm, cosine, recallScore, recency } from './score.ts';
import { testConfig } from './testing.ts';

test('cosine', () => {
  assert.equal(cosine(Float32Array.of(1, 0), Float32Array.of(1, 0)), 1);
  assert.equal(cosine(Float32Array.of(1, 0), Float32Array.of(0, 1)), 0);
  assert.equal(cosine(Float32Array.of(1, 0), Float32Array.of(1, 0, 0)), 0);
  assert.equal(cosine(Float32Array.of(0, 0), Float32Array.of(1, 0)), 0);
});

test('bm25Norm maps negative lower-is-better to 0..1', () => {
  assert.deepEqual(bm25Norm([-4, -2, -1]), [1, 1 / 3, 0]);
  assert.deepEqual(bm25Norm([-3]), [1]);
  assert.deepEqual(bm25Norm([]), []);
});

test('recency halves every half-life', () => {
  assert.equal(recency(0, 0, 6), 1);
  assert.ok(Math.abs(recency(6 * 3600e3, 0, 6) - 0.5) < 1e-9);
});

test('recallScore is the weighted sum', () => {
  const w = testConfig().recall.weights;
  const all = recallScore({ cosine: 1, bm25: 1, fidelity: 1, recency: 1, importance: 1 }, w);
  assert.ok(Math.abs(all - (w.cosine + w.bm25 + w.fidelity + w.recency + w.importance)) < 1e-9);
});
