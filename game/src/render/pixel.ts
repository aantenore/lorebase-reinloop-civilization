/** Tiny pixel buffer: draw with palette strings, auto-outline, then blit to a canvas. */
export class Pix {
  readonly buf: (string | null)[];
  constructor(readonly w: number, readonly h: number) {
    this.buf = new Array(w * h).fill(null);
  }

  set(x: number, y: number, c: string | null): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.buf[y * this.w + x] = c;
  }

  get(x: number, y: number): string | null {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    return this.buf[y * this.w + x];
  }

  rect(x: number, y: number, w: number, h: number, c: string): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }

  /** Filled ellipse; `shade` picks the colour per pixel from its normalised offset. */
  ellipse(cx: number, cy: number, rx: number, ry: number, c: string | ((nx: number, ny: number) => string)): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const nx = (x + 0.5 - cx) / rx;
        const ny = (y + 0.5 - cy) / ry;
        if (nx * nx + ny * ny <= 1) this.set(x, y, typeof c === 'string' ? c : c(nx, ny));
      }
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, c: string): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) this.set(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c);
  }

  /** 1px outline around every opaque pixel (4-neighbour). */
  outline(c: string): void {
    const add: number[] = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.get(x, y)) continue;
        if (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1)) add.push(y * this.w + x);
      }
    }
    for (const i of add) this.buf[i] = c;
  }

  blit(ctx: CanvasRenderingContext2D, ox = 0, oy = 0): void {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const c = this.buf[y * this.w + x];
        if (!c) continue;
        ctx.fillStyle = c;
        ctx.fillRect(ox + x, oy + y, 1, 1);
      }
    }
  }

  /** Copy with horizontal mirror. */
  mirrored(): Pix {
    const p = new Pix(this.w, this.h);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) p.buf[y * this.w + (this.w - 1 - x)] = this.buf[y * this.w + x];
    return p;
  }
}

export function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

/** Register a horizontal strip of equal frames as one texture with numbered frames. */
export function addStrip(scene: Phaser.Scene, key: string, frames: Pix[]): void {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const fw = frames[0].w;
  const fh = frames[0].h;
  const { canvas, ctx } = makeCanvas(fw * frames.length, fh);
  frames.forEach((f, i) => f.blit(ctx, i * fw, 0));
  const tex = scene.textures.addCanvas(key, canvas)!;
  frames.forEach((_, i) => tex.add(i, 0, i * fw, 0, fw, fh));
}
