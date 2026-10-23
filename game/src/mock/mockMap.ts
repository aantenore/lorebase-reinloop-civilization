import type { Biome, MapData, Tile } from '../net/protocol';
import { rng } from '../render/palette';

/** Smooth value noise in [0,1]. */
function valueNoise(seed: number, scale: number) {
  const r = rng(seed);
  const size = 64;
  const grid = Array.from({ length: size * size }, () => r());
  const at = (x: number, y: number) => grid[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const fx = x / scale;
    const fy = y / scale;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = smooth(fx - x0);
    const ty = smooth(fy - y0);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    return a + (b - a) * ty;
  };
}

export const VILLAGE = { x: 21, y: 21 };
export const STOCKPILE = { x: 22, y: 23 };
export const HUTS = [
  { x: 18, y: 19, level: 2 as const },
  { x: 24, y: 18, level: 2 as const },
  { x: 17, y: 24, level: 1 as const },
  { x: 25, y: 25, level: 1 as const },
];
/** Free plot the builders work on. */
export const BUILD_SITE = { x: 20, y: 26 };

export function generateMap(w = 44, h = 40, seed = 7): MapData {
  const forestN = valueNoise(seed, 6);
  const detail = valueNoise(seed + 1, 2.5);
  const hillN = valueNoise(seed + 2, 9);
  const r = rng(seed + 3);
  const tiles: Tile[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dv = Math.hypot(x - VILLAGE.x, y - VILLAGE.y);
      const lake = Math.hypot((x - 34) / 1.25, y - 9) < 6.2 + detail(x, y) * 1.6;
      // river from the lake down to the south-east edge, meandering
      const riverX = 33 + Math.sin(y * 0.35) * 2.2;
      const river = y > 12 && Math.abs(x - riverX) < 1.05 && y < h;
      const hill = hillN(x, y) + (x < 12 && y < 14 ? 0.35 : 0);
      let biome: Biome = 'grass';
      let elev = 1;
      if (lake || river) {
        biome = 'water';
        elev = 0;
      } else if (hill > 0.86 && dv > 9) {
        biome = 'rock';
        elev = hill > 0.97 ? 3 : 2;
      } else if (forestN(x, y) * 0.75 + detail(x, y) * 0.35 > 0.62 && dv > 6.5) {
        biome = 'forest';
      } else if (hill > 0.78 && dv > 9) {
        elev = 2;
      }
      // sandy banks
      if (biome === 'grass' && !lake && (Math.hypot((x - 34) / 1.25, y - 9) < 7.6 || (y > 12 && Math.abs(x - riverX) < 2))) biome = 'sand';
      // village paths
      const onPath = (Math.abs(y - VILLAGE.y) < 0.6 && Math.abs(x - VILLAGE.x) < 11) || (Math.abs(x - VILLAGE.x) < 0.6 && Math.abs(y - VILLAGE.y) < 10);
      if (onPath && biome !== 'water') {
        biome = 'sand';
        elev = 1;
      }
      if (dv < 5.5 && biome !== 'sand') {
        biome = 'grass';
        elev = 1;
      }
      const tile: Tile = { x, y, biome, elev, food: 0, wood: 0, shelter: 0 };
      if (biome === 'forest') tile.wood = 3 + Math.floor(r() * 6);
      if (biome === 'grass' && dv > 4 && r() < 0.06) tile.food = 3 + Math.floor(r() * 4);
      tiles.push(tile);
    }
  }
  const at = (x: number, y: number) => tiles[y * w + x];
  // bridge over the river on the village road
  for (let x = 28; x < 38; x++) {
    const t = at(x, VILLAGE.y);
    if (t.biome === 'water') Object.assign(t, { biome: 'sand', elev: 1 });
  }
  for (const hut of HUTS) Object.assign(at(hut.x, hut.y), { shelter: hut.level, biome: 'grass', food: 0, wood: 0 });
  Object.assign(at(STOCKPILE.x, STOCKPILE.y), { wood: 6, biome: 'sand' });
  return { w, h, tiles };
}
