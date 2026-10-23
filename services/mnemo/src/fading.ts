// Forgetting curve. A memory has an anchor (time + fidelity) and a stability; fidelity decays
// exponentially from the anchor. Recall re-anchors it higher and makes it more stable, and may
// flag it for a mild distortion at the next compaction (reconsolidation). Pure functions only.
import type { FadingConfig, ReconsolidationConfig } from './config.ts';

const HOUR_MS = 3600e3;

export interface FadingState {
  anchor_ms: number;
  anchor_fidelity: number;
  stability_ms: number;
  recalls: number;
  pending_blur: number;
}

export function fidelityAt(mem: Pick<FadingState, 'anchor_ms' | 'anchor_fidelity' | 'stability_ms'>, nowMs: number): number {
  const dt = Math.max(0, nowMs - mem.anchor_ms);
  return mem.anchor_fidelity * Math.exp(-dt / mem.stability_ms);
}

export function initialStability(importance: number, emotion: number, cfg: FadingConfig, kind: 'episodic' | 'gist' = 'episodic'): number {
  const base = cfg.baseStabilityHours * HOUR_MS * (1 + cfg.importanceWeight * importance + cfg.emotionWeight * Math.abs(emotion));
  return kind === 'gist' ? base * cfg.gistStabilityFactor : base;
}

export function strengthenOnRecall(
  mem: FadingState,
  nowMs: number,
  cfg: { fading: FadingConfig; reconsolidation: ReconsolidationConfig },
  rng: () => number,
): FadingState {
  let f = fidelityAt(mem, nowMs);
  f = f + cfg.fading.strengthen * (1 - f);
  let pending = mem.pending_blur;
  if (cfg.reconsolidation.enabled && rng() < cfg.reconsolidation.probability) {
    pending = 1;
    f = Math.max(0, f - cfg.reconsolidation.fidelityPenalty);
  }
  return {
    anchor_ms: nowMs,
    anchor_fidelity: f,
    stability_ms: mem.stability_ms * cfg.fading.recallStabilityFactor,
    recalls: mem.recalls + 1,
    pending_blur: pending,
  };
}
