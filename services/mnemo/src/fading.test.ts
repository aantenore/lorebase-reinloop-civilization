import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fidelityAt, initialStability, strengthenOnRecall } from './fading.ts';
import { testConfig } from './testing.ts';

const cfg = testConfig();
const H = 3600e3;

test('fidelity decays exponentially from the anchor', () => {
  const m = { anchor_ms: 0, anchor_fidelity: 1, stability_ms: H };
  assert.equal(fidelityAt(m, 0), 1);
  assert.ok(Math.abs(fidelityAt(m, H) - Math.exp(-1)) < 1e-9);
});

test('stability grows with importance and emotion; gists last longer', () => {
  const base = initialStability(0, 0, cfg.fading);
  assert.equal(base, cfg.fading.baseStabilityHours * H);
  assert.ok(initialStability(1, 0, cfg.fading) > base);
  assert.ok(initialStability(0, -1, cfg.fading) > base);
  assert.equal(initialStability(0, 0, cfg.fading, 'gist'), base * cfg.fading.gistStabilityFactor);
});

test('recall raises fidelity and stability; reconsolidation flags and penalises', () => {
  const m = { anchor_ms: 0, anchor_fidelity: 1, stability_ms: H, recalls: 0, pending_blur: 0 };
  const calm = strengthenOnRecall(m, H, cfg, () => 0.99);
  const f = Math.exp(-1);
  assert.ok(Math.abs(calm.anchor_fidelity - (f + cfg.fading.strengthen * (1 - f))) < 1e-9);
  assert.equal(calm.stability_ms, H * cfg.fading.recallStabilityFactor);
  assert.equal(calm.recalls, 1);
  assert.equal(calm.pending_blur, 0);
  const distorted = strengthenOnRecall(m, H, cfg, () => 0);
  assert.equal(distorted.pending_blur, 1);
  assert.ok(Math.abs(distorted.anchor_fidelity - (calm.anchor_fidelity - cfg.reconsolidation.fidelityPenalty)) < 1e-9);
});
