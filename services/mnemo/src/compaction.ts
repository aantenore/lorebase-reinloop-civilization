// Pure compaction scheduling for one agent: decides which memories to forget, merge into a gist
// or blur. A memory lands in at most one bucket per pass (forget > merge > blur).
import type { CompactionConfig } from './config.ts';
import { fidelityAt } from './fading.ts';
import { cosine } from './score.ts';

export interface PlanMemory {
  id: string;
  kind: 'episodic' | 'gist';
  importance: number;
  blur_level: number;
  pending_blur: number;
  anchor_ms: number;
  anchor_fidelity: number;
  stability_ms: number;
  embedding: Float32Array;
}

export interface CompactionPlan {
  blur: string[];
  merge: string[][];
  forget: string[];
}

export function planCompaction(mems: PlanMemory[], nowMs: number, cfg: CompactionConfig): CompactionPlan {
  const fid = new Map(mems.map((m) => [m.id, fidelityAt(m, nowMs)]));
  const f = (m: PlanMemory) => fid.get(m.id)!;
  const taken = new Set<string>();

  const forget: string[] = [];
  for (const m of mems) if (f(m) < cfg.forgetBelow) forget.push(m.id);
  const excess = mems.length - cfg.maxMemoriesPerAgent;
  if (excess > forget.length) {
    const gone = new Set(forget);
    const value = (m: PlanMemory) => f(m) * (0.5 + m.importance);
    const rest = mems.filter((m) => !gone.has(m.id)).sort((a, b) => value(a) - value(b));
    for (const m of rest.slice(0, excess - forget.length)) forget.push(m.id);
  }
  for (const id of forget) taken.add(id);

  const merge: string[][] = [];
  const weak = mems.filter((m) => !taken.has(m.id) && f(m) < cfg.mergeBelow).sort((a, b) => f(a) - f(b));
  for (const seed of weak) {
    if (taken.has(seed.id)) continue;
    const cluster = [seed.id];
    for (const other of weak) {
      if (other === seed || taken.has(other.id)) continue;
      if (cosine(seed.embedding, other.embedding) >= cfg.mergeCosine) cluster.push(other.id);
    }
    if (cluster.length >= cfg.mergeMinCluster) {
      merge.push(cluster);
      for (const id of cluster) taken.add(id);
    }
  }

  const blur: string[] = [];
  for (const m of mems) {
    if (taken.has(m.id)) continue;
    const threshold = cfg.blurBelow[m.blur_level];
    if (m.pending_blur === 1 || (threshold !== undefined && f(m) < threshold)) blur.push(m.id);
  }
  return { blur, merge, forget };
}
