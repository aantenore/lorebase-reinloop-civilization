/** Isometric projection helpers (2:1 diamonds). Integer tile coords are tile centres. */
export const TILE_W = 32;
export const TILE_H = 16;
/** Height of the visible side wall baked into each tile texture. */
export const TILE_SIDE = 12;
/** Screen pixels per elevation step. */
export const ELEV_PX = 6;

export function toScreen(x: number, y: number, elev = 0): { sx: number; sy: number } {
  return { sx: (x - y) * (TILE_W / 2), sy: (x + y) * (TILE_H / 2) - elev * ELEV_PX };
}

/** Inverse projection on the ground plane (elev 0). */
export function toTile(sx: number, sy: number): { x: number; y: number } {
  const a = sx / (TILE_W / 2);
  const b = sy / (TILE_H / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Painter's order: larger x+y is nearer to the viewer. */
export function depthOf(x: number, y: number, bias = 0): number {
  return (x + y) * 10 + bias;
}

/** Screen-space direction vector (e.g. from WASD) -> normalised tile-space vector. */
export function screenDirToTile(sx: number, sy: number): { dx: number; dy: number } {
  if (sx === 0 && sy === 0) return { dx: 0, dy: 0 };
  // Screen right = (+x,-y), screen down = (+x,+y). Equal weights keep diagonals on the grid axes.
  const dx = sx + sy;
  const dy = sy - sx;
  const len = Math.hypot(dx, dy) || 1;
  return { dx: +(dx / len).toFixed(3), dy: +(dy / len).toFixed(3) };
}
