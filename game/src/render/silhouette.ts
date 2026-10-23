import Phaser from 'phaser';
import { makeCanvas } from './pixel';

/**
 * Outline-plus-faint-fill copy of a character strip, same frame layout. Drawn above trees and huts
 * (tinted per role) so a hidden inhabitant still reads through the canopy.
 */
export function ensureSilhouette(scene: Phaser.Scene, key: string): string {
  const out = `${key}__sil`;
  if (scene.textures.exists(out)) return out;
  const src = scene.textures.get(key);
  const img = src.getSourceImage() as HTMLCanvasElement | HTMLImageElement;
  const w = img.width;
  const h = img.height;
  const read = makeCanvas(w, h);
  read.ctx.drawImage(img, 0, 0);
  const a = read.ctx.getImageData(0, 0, w, h).data;
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && a[(y * w + x) * 4 + 3] > 0;
  const { canvas, ctx } = makeCanvas(w, h);
  const outImg = ctx.createImageData(w, h);
  const o = outImg.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let alpha = 0;
      if (solid(x, y)) alpha = 70;
      else if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) alpha = 255;
      if (!alpha) continue;
      o[i] = o[i + 1] = o[i + 2] = 255;
      o[i + 3] = alpha;
    }
  }
  ctx.putImageData(outImg, 0, 0);
  const tex = scene.textures.addCanvas(out, canvas)!;
  for (const name of src.getFrameNames()) {
    const f = src.get(name);
    tex.add(name, 0, f.cutX, f.cutY, f.cutWidth, f.cutHeight);
  }
  return out;
}
