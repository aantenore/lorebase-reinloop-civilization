// Recall scoring helpers: cosine similarity, bm25 normalisation, recency decay, weighted sum.
import type { RecallWeights } from './config.ts';

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** FTS5 bm25() is negative and lower-is-better; map the candidate set to 0..1 (best = 1). */
export function bm25Norm(raw: number[]): number[] {
  if (raw.length === 0) return [];
  const s = raw.map((r) => -r);
  const min = Math.min(...s);
  const max = Math.max(...s);
  if (max === min) return s.map(() => 1);
  return s.map((v) => (v - min) / (max - min));
}

export function recency(nowMs: number, createdMs: number, halfLifeHours: number): number {
  const ageH = Math.max(0, nowMs - createdMs) / 3600e3;
  return Math.pow(0.5, ageH / halfLifeHours);
}

export type ScoreParts = Record<keyof RecallWeights, number>;

export function recallScore(parts: ScoreParts, w: RecallWeights): number {
  return parts.cosine * w.cosine + parts.bm25 * w.bm25 + parts.fidelity * w.fidelity + parts.recency * w.recency + parts.importance * w.importance;
}
