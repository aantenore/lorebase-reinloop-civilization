import type { Biome, Season } from '../net/protocol';
import { TILE_H, TILE_SIDE, TILE_W } from './iso';
import { P, rng } from './palette';
import { addStrip, makeCanvas, Pix } from './pixel';

/** Visual look of the land per season. */
export type Look = Season;
export const LOOKS: Look[] = ['spring', 'summer', 'autumn', 'winter'];
export const TILE_VARIANTS = 4;
export const WATER_FRAMES = 3;

export const tileKey = (biome: Biome, look: Look, v: number) => `tile_${biome}_${look}_${v}`;

const pick = <T,>(arr: T[], r: () => number): T => arr[Math.floor(r() * arr.length)];

// ------------------------------------------------------------------ tiles

/** Row half-width of the top diamond at row py (0..TILE_H-1). */
function halfWidth(py: number): number {
  return py < TILE_H / 2 ? (py + 1) * 2 : (TILE_H - py) * 2;
}

function inDiamond(x: number, y: number): boolean {
  if (y < 0 || y >= TILE_H) return false;
  const hw = halfWidth(y);
  return x >= TILE_W / 2 - hw && x <= TILE_W / 2 + hw - 1;
}

function bottomOf(x: number): number {
  for (let y = TILE_H - 1; y >= 0; y--) if (inDiamond(x, y)) return y;
  return TILE_H / 2;
}

interface TopStyle {
  base: string[];
  side: [string, string];
  rim?: string;
  sideTop?: [string, string];
}

function topStyle(biome: Biome, look: Look): TopStyle {
  const winter = look === 'winter';
  switch (biome) {
    case 'grass':
      return {
        base: winter ? [P.snow[0], P.snow[1], P.snow[0], P.snow[3]] : look === 'autumn' ? P.grassAutumn : P.grass,
        side: [P.dirt[1], P.dirt[2]],
        sideTop: winter ? [P.snow[3], P.snow[4]] : look === 'autumn' ? [P.grassAutumn[0], '#6f7a38'] : [P.grass[0], P.grassDark],
      };
    case 'forest':
      return {
        base: winter ? [P.snow[0], P.snow[3], P.snow[0], P.snow[1]] : P.forestFloor,
        side: [P.dirt[2], P.dirt[3]],
        sideTop: winter ? [P.snow[3], P.snow[4]] : [P.forestFloor[0], '#244a2c'],
      };
    case 'sand':
      return {
        base: winter ? [P.snow[1], P.snow[0], P.sand[0], P.snow[3]] : P.sand,
        side: [P.sand[3], '#a8844f'],
      };
    case 'rock':
      return {
        base: winter ? [P.snow[0], P.rock[1], P.snow[3], P.rock[2]] : [P.rock[0], P.rock[1], P.rock[2], P.rock[0]],
        side: [P.rock[3], P.rock[4]],
      };
    case 'water':
      return {
        base: winter ? P.ice : [P.water[1], P.water[1], P.water[2], P.water[0]],
        side: winter ? [P.ice[3], '#6f9cbd'] : [P.water[0], '#244f96'],
      };
  }
}

function drawTile(biome: Biome, look: Look, variant: number, frame: number): Pix {
  const p = new Pix(TILE_W, TILE_H + TILE_SIDE);
  const r = rng(variant * 7919 + biome.length * 104729 + LOOKS.indexOf(look) * 31);
  const st = topStyle(biome, look);
  const winter = look === 'winter';

  // Top surface: clustered noise so it reads as texture, not static.
  for (let y = 0; y < TILE_H; y++) {
    for (let x = 0; x < TILE_W; x++) {
      if (!inDiamond(x, y)) continue;
      const n = (Math.sin(x * 0.9 + variant * 3) + Math.cos(y * 1.3 + x * 0.4 + variant)) * 0.25 + r() * 0.6;
      const idx = n < 0.15 ? 0 : n < 0.55 ? 1 : n < 0.8 ? 2 : 3;
      p.set(x, y, st.base[Math.min(idx, st.base.length - 1)]);
    }
  }

  // Biome details.
  const spots = (count: number, fn: (x: number, y: number) => void) => {
    for (let i = 0; i < count; i++) {
      const x = 4 + Math.floor(r() * (TILE_W - 8));
      const y = 2 + Math.floor(r() * (TILE_H - 4));
      if (inDiamond(x, y) && inDiamond(x + 1, y + 1) && inDiamond(x - 1, y - 1)) fn(x, y);
    }
  };
  if (biome === 'grass' && !winter) {
    spots(4, (x, y) => {
      p.set(x, y, look === 'autumn' ? '#c0b860' : P.grass[3]);
      p.set(x - 1, y - 1, look === 'autumn' ? '#aab258' : P.grass[3]);
      p.set(x + 1, y - 1, look === 'autumn' ? '#aab258' : P.grass[2]);
    });
    if (look === 'spring' || (look === 'summer' && variant % 2 === 0))
      spots(look === 'spring' ? 3 : 1, (x, y) => p.set(x, y, pick([P.flowerY, P.flowerW, P.flowerP], r)));
    if (look === 'autumn') spots(3, (x, y) => p.set(x, y, pick(P.leafAutumn, r)));
  }
  if (biome === 'forest' && !winter) spots(5, (x, y) => p.set(x, y, look === 'autumn' ? pick(P.leafAutumn, r) : pick(['#2a4f30', P.dirt[2], '#4f8a4a'], r)));
  if (biome === 'sand') spots(4, (x, y) => p.set(x, y, pick([P.sand[3], P.stone[1], '#f5e3b8'], r)));
  if (biome === 'rock') {
    spots(2, (x, y) => {
      p.line(x - 2, y, x + 1, y + 1, P.rock[3]);
      p.set(x - 2, y - 1, P.rock[2]);
    });
    spots(3, (x, y) => p.set(x, y, P.rock[2]));
  }
  if (winter && (biome === 'grass' || biome === 'forest')) spots(3, (x, y) => p.set(x, y, P.snow[4]));
  if (winter && biome === 'grass') spots(1, (x, y) => (p.set(x, y, P.grass[0]), p.set(x + 1, y - 1, P.grass[1])));

  if (biome === 'water') {
    if (winter) {
      spots(2, (x, y) => p.line(x - 3, y, x + 2, y - 1, P.ice[3]));
      spots(3, (x, y) => p.set(x, y, P.white));
    } else {
      // Animated ripples: short horizontal highlights drifting with the frame.
      const rw = rng(variant * 13 + 5);
      for (let i = 0; i < 5; i++) {
        const bx = Math.floor(rw() * TILE_W);
        const by = 2 + Math.floor(rw() * (TILE_H - 4));
        const x = (bx + frame * 2) % TILE_W;
        const len = 2 + Math.floor(rw() * 3);
        for (let k = 0; k < len; k++) if (inDiamond(x + k, by)) p.set(x + k, by, k === 0 ? P.water[4] : P.water[3]);
      }
    }
  }

  // Bevel: soft light on the two top edges, so the grid is felt but not drawn.
  for (let y = 0; y < TILE_H / 2; y++) {
    const hw = halfWidth(y);
    const lx = TILE_W / 2 - hw;
    const rx = TILE_W / 2 + hw - 1;
    if (biome !== 'water' || winter) {
      p.set(lx, y, lighten(p.get(lx, y)));
      p.set(lx + 1, y, lighten(p.get(lx + 1, y)));
    }
    p.set(rx, y, lighten(p.get(rx, y), 0.06));
  }

  // Side walls (only visible where the neighbour in front is lower).
  for (let x = 0; x < TILE_W; x++) {
    const b = bottomOf(x);
    const left = x < TILE_W / 2;
    for (let k = 1; k <= TILE_SIDE; k++) {
      let c = left ? st.side[0] : st.side[1];
      if (st.sideTop && k <= 2) c = left ? st.sideTop[0] : st.sideTop[1];
      else if ((x * 7 + k * 3 + variant) % 11 === 0) c = darken(c, 0.12);
      else if (k > TILE_SIDE - 2) c = darken(c, 0.15);
      p.set(x, b + k, c);
    }
  }
  return p;
}

function shift(c: string | null, amt: number): string | null {
  if (!c) return c;
  const n = parseInt(c.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v + 255 * amt)));
  const r = f((n >> 16) & 255);
  const g = f((n >> 8) & 255);
  const b = f(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
export const lighten = (c: string | null, a = 0.1) => shift(c, a) as string;
export const darken = (c: string | null, a = 0.1) => shift(c, -a) as string;

// ------------------------------------------------------------------ props

function pine(look: Look, seed: number): Pix {
  const p = new Pix(22, 38);
  const r = rng(seed);
  const cx = 11;
  const autumn = look === 'autumn';
  const leaf = autumn ? [P.leaf[0], '#4f7a3a', P.leaf[1], '#7a9a4a'] : P.leaf;
  p.rect(cx - 1, 30, 3, 6, P.trunk[0]);
  p.set(cx + 1, 31, P.trunk[1]);
  p.set(cx + 1, 33, P.trunk[1]);
  const tiers = [
    { top: 2, h: 10, w: 6 },
    { top: 8, h: 11, w: 8 },
    { top: 15, h: 13, w: 10 },
  ];
  for (const t of tiers) {
    for (let j = 0; j < t.h; j++) {
      const hw = Math.round((j / (t.h - 1)) * t.w);
      for (let i = -hw; i <= hw; i++) {
        const side = i / Math.max(1, hw);
        let c = side < -0.35 ? leaf[2] : side > 0.4 ? leaf[0] : leaf[1];
        if (j === t.h - 1 && i > -hw + 1) c = leaf[0];
        if (r() < 0.07) c = leaf[3];
        p.set(cx + i, t.top + j, c);
      }
    }
    if (look === 'winter') {
      for (let j = 0; j < 3; j++) {
        const hw = Math.round((j / (t.h - 1)) * t.w);
        for (let i = -hw; i <= hw; i++) p.set(cx + i, t.top + j, j === 2 && i > 0 ? P.snow[3] : P.snow[1]);
      }
      p.set(cx - t.w + 1, t.top + t.h - 2, P.snow[1]);
      p.set(cx - t.w + 2, t.top + t.h - 2, P.snow[1]);
    }
  }
  p.outline(P.outline);
  return p;
}

function roundTree(look: Look, seed: number): Pix {
  const p = new Pix(24, 34);
  const r = rng(seed);
  const cx = 12;
  // trunk with a fork
  p.rect(cx - 1, 20, 3, 12, P.trunk[0]);
  p.set(cx + 1, 22, P.trunk[1]);
  p.set(cx + 1, 26, P.trunk[1]);
  p.set(cx - 1, 29, P.trunk[2]);
  if (look === 'winter') {
    p.line(cx, 20, cx - 6, 12, P.trunk[0]);
    p.line(cx, 21, cx + 6, 11, P.trunk[0]);
    p.line(cx, 20, cx + 1, 8, P.trunk[0]);
    p.line(cx - 4, 15, cx - 7, 15, P.trunk[0]);
    p.line(cx + 4, 15, cx + 8, 14, P.trunk[0]);
    for (const [x, y] of [[cx - 6, 11], [cx + 6, 10], [cx + 1, 7], [cx - 7, 14], [cx + 8, 13], [cx - 3, 15]]) p.set(x, y, P.snow[1]);
    p.outline(P.outline);
    return p;
  }
  const leaf = look === 'autumn' ? P.leafAutumn : P.leaf;
  const blob = (bx: number, by: number, rx: number, ry: number) =>
    p.ellipse(bx, by, rx, ry, (nx, ny) => {
      const l = -nx * 0.6 - ny * 0.8;
      let c = l > 0.55 ? leaf[3] : l > 0.05 ? leaf[2] : l > -0.5 ? leaf[1] : leaf[0];
      if (r() < 0.06) c = leaf[Math.max(0, leaf.indexOf(c) - 1)];
      return c;
    });
  blob(cx - 4, 15, 6, 5);
  blob(cx + 4, 15, 6, 5);
  blob(cx, 10, 8, 7);
  if (look === 'spring') for (let i = 0; i < 7; i++) p.set(cx - 7 + Math.floor(r() * 14), 5 + Math.floor(r() * 13), P.blossom);
  p.outline(P.outline);
  return p;
}

function bush(look: Look, full: boolean): Pix {
  const p = new Pix(16, 12);
  const r = rng(full ? 3 : 4);
  const leaf = look === 'autumn' ? [P.leafAutumn[0], P.leafAutumn[1], P.leafAutumn[2], P.leafAutumn[3]] : P.leaf;
  const shade = (nx: number, ny: number) => (-nx * 0.5 - ny > 0.3 ? leaf[2] : -nx * 0.5 - ny > -0.4 ? leaf[1] : leaf[0]);
  p.ellipse(5, 7, 4.5, 4, shade);
  p.ellipse(11, 7, 4.5, 4, shade);
  p.ellipse(8, 5, 5, 4, shade);
  if (look === 'winter') {
    p.ellipse(8, 3.5, 4.5, 1.6, P.snow[1]);
    p.set(3, 4, P.snow[1]);
    p.set(12, 4, P.snow[3]);
  }
  if (full) {
    for (let i = 0; i < 6; i++) {
      const x = 3 + Math.floor(r() * 10);
      const y = 4 + Math.floor(r() * 6);
      p.set(x, y, P.berry);
      p.set(x, y - 1 < 4 ? y : y - 1, p.get(x, y - 1) === P.berry ? P.berry : p.get(x, y - 1));
      p.set(x - 1, y, P.berryLight);
    }
  }
  p.outline(P.outline);
  return p;
}

/** Low forest undergrowth (ferns, saplings): reads as forest without hiding anyone. */
function undergrowth(look: Look, seed: number): Pix {
  const p = new Pix(18, 11);
  const r = rng(seed);
  const leaf = look === 'autumn' ? P.leafAutumn : P.leaf;
  const fronds = 4 + Math.floor(r() * 3);
  for (let i = 0; i < fronds; i++) {
    const bx = 3 + Math.floor(r() * 12);
    const h = 4 + Math.floor(r() * 5);
    const lean = r() < 0.5 ? -1 : 1;
    for (let j = 0; j < h; j++) {
      const x = bx + Math.round((j / h) * lean * 2);
      const y = 10 - j;
      p.set(x, y, j > h - 3 ? leaf[3] : leaf[1 + (j % 2)]);
      if (j > 1 && j % 2 === 0) p.set(x - lean, y, leaf[0]);
    }
  }
  if (seed % 2 === 0) {
    p.rect(8, 7, 1, 4, P.trunk[0]);
    p.ellipse(8.5, 5, 3, 2.6, (nx, ny) => (-nx - ny > 0 ? leaf[2] : leaf[1]));
  }
  if (look === 'winter') for (let x = 2; x < 16; x++) if (p.get(x, 10) || p.get(x, 9)) p.set(x, 10, P.snow[1]);
  p.outline(P.outline);
  return p;
}

function rockPile(look: Look): Pix {
  const p = new Pix(18, 12);
  const shade = (nx: number, ny: number) => (-nx * 0.5 - ny > 0.4 ? P.rock[2] : -nx * 0.5 - ny > -0.3 ? P.rock[1] : P.rock[3]);
  p.ellipse(6, 7, 5, 4, shade);
  p.ellipse(12, 8, 4.5, 3.5, shade);
  p.ellipse(9, 4.5, 3.5, 3, shade);
  if (look === 'winter') {
    p.ellipse(9, 2.6, 2.6, 1.2, P.snow[1]);
    p.ellipse(5, 4.2, 3, 1.1, P.snow[1]);
  }
  p.outline(P.outline);
  return p;
}

function woodPile(): Pix {
  const p = new Pix(16, 12);
  const logEnd = (x: number, y: number) => {
    p.ellipse(x, y, 2.2, 2.2, P.log[3]);
    p.set(Math.round(x - 0.5), Math.round(y - 0.5), P.log[2]);
  };
  p.rect(2, 6, 12, 4, P.log[0]);
  p.rect(2, 9, 12, 1, P.log[1]);
  p.rect(4, 2, 9, 4, P.log[0]);
  logEnd(2.5, 8);
  logEnd(6.5, 8);
  logEnd(4.5, 4);
  logEnd(8.5, 4);
  p.outline(P.outline);
  return p;
}

function tent(look: Look): Pix {
  const p = new Pix(28, 24);
  const cx = 14;
  for (let j = 0; j < 18; j++) {
    const hw = Math.round(j * 0.72) + 1;
    for (let i = -hw; i <= hw; i++) {
      let c = i < 0 ? P.hide[2] : P.hide[0];
      if (i === 0) c = P.hide[3];
      if (j % 6 === 4 && Math.abs(i) > 1) c = P.hide[1];
      p.set(cx + i, 4 + j, c);
    }
  }
  // door flap
  for (let j = 0; j < 7; j++) for (let i = -Math.floor(j / 2); i <= 0; i++) p.set(cx + i + 1, 15 + j, P.outlineSoft);
  p.line(cx - 1, 1, cx - 1, 5, P.log[1]);
  p.line(cx + 1, 1, cx + 2, 5, P.log[1]);
  if (look === 'winter') for (let j = 0; j < 6; j++) for (let i = -Math.round(j * 0.72); i <= Math.round(j * 0.72); i++) p.set(cx + i, 5 + j, j > 3 && i > 0 ? P.snow[3] : P.snow[1]);
  p.outline(P.outline);
  return p;
}

function hut(look: Look): Pix {
  const p = new Pix(34, 34);
  const cx = 17;
  // log walls (iso box front faces)
  for (let y = 18; y < 31; y++) {
    for (let x = 4; x < 30; x++) {
      const left = x < cx;
      const row = (y - 18) % 3;
      let c = left ? P.log[2] : P.log[0];
      if (row === 2) c = left ? P.log[0] : P.log[1];
      p.set(x, y + (left ? Math.floor((cx - x) / 2.6) - 4 : Math.floor((x - cx) / 2.6) - 4), c);
    }
  }
  // door
  p.rect(cx - 6, 20, 4, 7, P.outlineSoft);
  p.rect(cx - 6, 20, 4, 1, P.log[1]);
  // window
  p.rect(cx + 5, 19, 3, 3, '#ffd77a');
  p.set(cx + 6, 20, P.log[1]);
  // thatched roof cone
  const roof = look === 'winter' ? [P.snow[1], P.snow[0], P.snow[3], P.snow[4]] : P.thatch;
  for (let j = 0; j < 17; j++) {
    const hw = Math.round(j * 0.95) + 1;
    for (let i = -hw; i <= hw; i++) {
      let c = i < -2 ? roof[2] : i > 2 ? roof[1] : roof[0];
      if ((i + j * 3) % 7 === 0) c = roof[3];
      if (j === 16) c = roof[3];
      p.set(cx + i, 1 + j, c);
    }
  }
  p.set(cx, 0, P.log[1]);
  p.outline(P.outline);
  return p;
}

function campfire(frame: number): Pix {
  const p = new Pix(16, 20);
  const r = rng(frame * 17 + 1);
  // stones ring
  for (const [x, y] of [[2, 16], [5, 18], [10, 18], [13, 16], [4, 14], [11, 14]]) {
    p.ellipse(x, y, 1.6, 1.2, P.stone[1]);
    p.set(x, y + 1, P.stone[2]);
  }
  p.line(4, 16, 11, 13, P.log[0]);
  p.line(4, 13, 11, 16, P.log[2]);
  // flame
  const heights = [7, 9, 8];
  const h = heights[frame % 3];
  for (let j = 0; j < h; j++) {
    const hw = Math.max(0, Math.round((1 - j / h) * 3.4 + (r() - 0.5)));
    for (let i = -hw; i <= hw; i++) {
      const core = Math.abs(i) < hw - 1 && j < h - 3;
      p.set(8 + i + (j > h - 3 ? (frame % 2 ? 1 : -1) : 0), 14 - j, core ? (j < 3 ? P.fire[0] : P.fire[1]) : j > h - 3 ? P.fire[3] : P.fire[2]);
    }
  }
  return p;
}

// ------------------------------------------------------------------ fx sprites

function glow(size: number, scene: Phaser.Scene, key: string) {
  const { canvas, ctx } = makeCanvas(size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  scene.textures.addCanvas(key, canvas);
}

function shadow(): Pix {
  const p = new Pix(16, 7);
  p.ellipse(8, 3.5, 7.5, 3.2, 'rgba(23,17,26,0.32)');
  p.ellipse(8, 3.5, 5, 2, 'rgba(23,17,26,0.42)');
  return p;
}

function ring(): Pix {
  const p = new Pix(22, 11);
  p.ellipse(11, 5.5, 10.5, 5, '#ffffff');
  p.ellipse(11, 5.5, 8.5, 3.6, 'rgba(255,255,255,0.18)');
  return p;
}

function crown(): Pix {
  const p = new Pix(11, 8);
  const g = P.gold;
  p.rect(1, 4, 9, 3, g[1]);
  p.rect(1, 4, 9, 1, g[0]);
  for (const x of [1, 5, 9]) p.rect(x, 1, 1, 3, g[0]);
  for (const x of [3, 7]) p.rect(x, 2, 1, 2, g[1]);
  p.set(5, 5, '#d8344a');
  p.set(2, 5, g[2]);
  p.set(1, 1, g[2]);
  p.outline(P.outline);
  return p;
}

function star(c: string[]): Pix {
  const p = new Pix(9, 9);
  const pts = ['....x....', '...xxx...', 'xxxxxxxxx', '.xxxxxxx.', '..xxxxx..', '..xx.xx..', '.x.....x.'];
  pts.forEach((row, y) => [...row].forEach((ch, x) => ch === 'x' && p.set(x, y + 1, y < 3 ? c[0] : c[1])));
  p.set(4, 2, c[2]);
  p.outline(P.outline);
  return p;
}

function gem(c: string[]): Pix {
  const p = new Pix(7, 8);
  ['..x..', '.xxx.', 'xxxxx', '.xxx.', '..x..'].forEach((row, y) =>
    [...row].forEach((ch, x) => ch === 'x' && p.set(x + 1, y + 1, x < 2 ? c[2] : y < 2 ? c[0] : c[1])),
  );
  p.outline(P.outline);
  return p;
}

function thoughtFrames(): Pix[] {
  return [1, 2, 3].map((dots) => {
    const p = new Pix(18, 15);
    p.ellipse(9, 6, 8, 5.5, P.white);
    p.ellipse(4, 12.5, 1.6, 1.4, P.white);
    p.set(1, 14, P.white);
    for (let i = 0; i < dots; i++) p.rect(5 + i * 3, 6, 2, 2, P.outlineSoft);
    p.outline(P.outline);
    return p;
  });
}

function arrow(): Pix {
  const p = new Pix(9, 7);
  ['xxxxxxx', '.xxxxx.', '..xxx..', '...x...'].forEach((row, y) => [...row].forEach((ch, x) => ch === 'x' && p.set(x + 1, y + 1, y === 0 ? '#fff2a0' : '#ffd84a')));
  p.outline(P.outline);
  return p;
}

function snowflake(): Pix {
  const p = new Pix(3, 3);
  p.set(1, 0, P.white);
  p.set(0, 1, P.white);
  p.set(1, 1, '#ffffff');
  p.set(2, 1, P.white);
  p.set(1, 2, P.white);
  return p;
}

function dot(c: string, s = 2): Pix {
  const p = new Pix(s, s);
  p.rect(0, 0, s, s, c);
  return p;
}

function puff(): Pix {
  const p = new Pix(8, 8);
  p.ellipse(4, 4, 3.8, 3.8, '#cfc8d4');
  p.ellipse(3.4, 3.4, 2.2, 2.2, '#e8e2ec');
  return p;
}

function zzz(): Pix {
  const p = new Pix(6, 6);
  ['xxxx', '..x.', '.x..', 'xxxx'].forEach((row, y) => [...row].forEach((ch, x) => ch === 'x' && p.set(x + 1, y + 1, '#c9d8ff')));
  p.outline(P.outline);
  return p;
}

/** Group banner on a pole, cloth in the group colour, optional family stripe. Generated per colour on demand. */
export function ensureBanner(scene: Phaser.Scene, color: string, stripe?: string): string {
  const key = `banner_${color}${stripe ? `_${stripe}` : ''}`;
  if (scene.textures.exists(key)) return key;
  const p = new Pix(12, 22);
  p.rect(1, 1, 1, 20, P.log[1]);
  p.set(1, 0, P.gold[0]);
  for (let y = 2; y < 11; y++) {
    const w = y > 8 ? 9 - (y - 8) * 2 : 9;
    for (let x = 2; x < 2 + w; x++) p.set(x, y, x === 2 || y === 2 ? lighten(color, 0.12) : y > 6 && x > 7 ? darken(color, 0.12) : color);
  }
  p.set(5, 5, P.white);
  p.set(6, 5, P.white);
  p.set(5, 6, P.white);
  if (stripe) for (let x = 2; x < 11; x++) for (const y of [8, 9]) if (p.get(x, y)) p.set(x, y, y === 8 ? lighten(stripe, 0.1) : stripe);
  p.outline(P.outline);
  addStrip(scene, key, [p]);
  return key;
}

/** Small laurel pip for the most esteemed (white: tinted gold/silver/bronze by rank). */
export function ensureLaurel(scene: Phaser.Scene): string {
  const key = 'laurel';
  if (scene.textures.exists(key)) return key;
  const p = new Pix(11, 8);
  const rows = ['x.......x', 'xx.....xx', '.xx...xx.', '..xx.xx..', '...xxx...'];
  rows.forEach((row, y) => [...row].forEach((ch, x) => ch === 'x' && p.set(x + 1, y + 1, x % 2 ? '#ffffff' : '#d8d8d8')));
  p.set(5, 6, '#ffffff');
  p.outline(P.outline);
  addStrip(scene, key, [p]);
  return key;
}

/** Generate every static texture once at boot. */
export function generateWorldTextures(scene: Phaser.Scene): void {
  const biomes: Biome[] = ['grass', 'forest', 'water', 'rock', 'sand'];
  for (const look of LOOKS) {
    for (const b of biomes) {
      for (let v = 0; v < TILE_VARIANTS; v++) {
        const frames = b === 'water' ? [0, 1, 2].map((f) => drawTile(b, look, v, f)) : [drawTile(b, look, v, 0)];
        addStrip(scene, tileKey(b, look, v), frames);
      }
    }
    addStrip(scene, `pine_${look}`, [pine(look, 11), pine(look, 12)]);
    addStrip(scene, `oak_${look}`, [roundTree(look, 21), roundTree(look, 22)]);
    addStrip(scene, `bush_${look}`, [bush(look, true), bush(look, false)]);
    addStrip(scene, `undergrowth_${look}`, [undergrowth(look, 31), undergrowth(look, 32), undergrowth(look, 33)]);
    addStrip(scene, `rocks_${look}`, [rockPile(look)]);
    addStrip(scene, `tent_${look}`, [tent(look)]);
    addStrip(scene, `hut_${look}`, [hut(look)]);
  }
  addStrip(scene, 'woodpile', [woodPile()]);
  addStrip(scene, 'campfire', [0, 1, 2].map(campfire));
  addStrip(scene, 'shadow', [shadow()]);
  addStrip(scene, 'ring', [ring()]);
  addStrip(scene, 'tier_opus', [crown()]);
  addStrip(scene, 'tier_sonnet', [star(P.silver)]);
  addStrip(scene, 'tier_haiku', [gem(P.bronze)]);
  addStrip(scene, 'thought', thoughtFrames());
  addStrip(scene, 'arrow', [arrow()]);
  addStrip(scene, 'snowflake', [snowflake()]);
  addStrip(scene, 'spark', [dot('#fff2a0')]);
  addStrip(scene, 'ember', [dot('#ff9a3c')]);
  addStrip(scene, 'pixel', [dot('#ffffff', 1)]);
  addStrip(scene, 'puff', [puff()]);
  addStrip(scene, 'zzz', [zzz()]);
  glow(64, scene, 'glow');
}
