/** Small seeded PRNG (mulberry32): the world is reproducible from its seed. */
export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  state(): number;
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    state: () => s,
  };
}

/** Bilinear value noise in [0, 1] on a coarse lattice of `scale`-sized cells. */
export function valueNoise(rng: Rng, width: number, height: number, scale: number): number[][] {
  const cw = Math.ceil(width / scale) + 2;
  const ch = Math.ceil(height / scale) + 2;
  const lattice = Array.from({ length: ch }, () => Array.from({ length: cw }, () => rng.next()));
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const out: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) {
      const gx = x / scale;
      const gy = y / scale;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const tx = smooth(gx - x0);
      const ty = smooth(gy - y0);
      const a = lattice[y0]![x0]!;
      const b = lattice[y0]![x0 + 1]!;
      const c = lattice[y0 + 1]![x0]!;
      const d = lattice[y0 + 1]![x0 + 1]!;
      row.push((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
    }
    out.push(row);
  }
  return out;
}
