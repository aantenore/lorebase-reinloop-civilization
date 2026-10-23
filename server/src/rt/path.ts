// A* on the tile grid. Pure: walkability comes from the caller.
export interface Point {
  x: number;
  y: number;
}

export interface PathOptions {
  /** Allows diagonal steps (never cutting a blocked corner). */
  diagonal: boolean;
  /** Search budget: expanded nodes before giving up. */
  maxNodes: number;
}

const SQRT2 = Math.SQRT2;

/** Binary min-heap keyed by f-score. */
class Heap {
  private items: Array<{ id: number; f: number }> = [];
  get size(): number {
    return this.items.length;
  }
  push(id: number, f: number): void {
    const a = this.items;
    a.push({ id, f });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.f <= a[i]!.f) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.f < a[m]!.f) m = l;
        if (r < a.length && a[r]!.f < a[m]!.f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top.id;
  }
}

/**
 * Shortest path from `from` to `to` (both tile coordinates), excluding `from`, including `to`.
 * Returns [] when already there, undefined when unreachable (or the budget runs out).
 */
export function findPath(
  width: number,
  height: number,
  walkable: (x: number, y: number) => boolean,
  from: Point,
  to: Point,
  opts: PathOptions,
): Point[] | undefined {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
  if (!inside(to.x, to.y) || !walkable(to.x, to.y)) return undefined;
  if (from.x === to.x && from.y === to.y) return [];
  const id = (x: number, y: number) => y * width + x;
  const h = (x: number, y: number) => {
    const dx = Math.abs(x - to.x);
    const dy = Math.abs(y - to.y);
    return opts.diagonal ? Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy) : dx + dy;
  };
  const g = new Map<number, number>();
  const came = new Map<number, number>();
  const closed = new Set<number>();
  const open = new Heap();
  const start = id(from.x, from.y);
  g.set(start, 0);
  open.push(start, h(from.x, from.y));
  const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  if (opts.diagonal) dirs.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
  const goal = id(to.x, to.y);
  let expanded = 0;
  while (open.size) {
    const cur = open.pop();
    if (closed.has(cur)) continue;
    if (cur === goal) {
      const path: Point[] = [];
      for (let n: number | undefined = cur; n !== undefined && n !== start; n = came.get(n)) path.push({ x: n % width, y: Math.floor(n / width) });
      return path.reverse();
    }
    closed.add(cur);
    if (++expanded > opts.maxNodes) return undefined;
    const cx = cur % width;
    const cy = Math.floor(cur / width);
    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inside(nx, ny) || !walkable(nx, ny)) continue;
      if (dx && dy && (!walkable(cx + dx, cy) || !walkable(cx, cy + dy))) continue;
      const nid = id(nx, ny);
      if (closed.has(nid)) continue;
      const cost = g.get(cur)! + (dx && dy ? SQRT2 : 1);
      if (cost < (g.get(nid) ?? Infinity)) {
        g.set(nid, cost);
        came.set(nid, cur);
        open.push(nid, cost + h(nx, ny));
      }
    }
  }
  return undefined;
}

/** Nearest walkable tile to `p` (by ring search), or undefined when none exists. */
export function nearestWalkable(width: number, height: number, walkable: (x: number, y: number) => boolean, p: Point): Point | undefined {
  const max = Math.max(width, height);
  for (let r = 0; r <= max; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = p.x + dx;
        const y = p.y + dy;
        if (x >= 0 && y >= 0 && x < width && y < height && walkable(x, y)) return { x, y };
      }
    }
  }
  return undefined;
}
