import type Phaser from 'phaser';
import type { Entity } from '../net/protocol';
import { CHAR_H, CHAR_W, ensureCharacter } from './characters';

let scene: Phaser.Scene | null = null;

/** The overlay draws portraits from the same textures the world uses. */
export function setPortraitScene(s: Phaser.Scene): void {
  scene = s;
}

export function drawPortrait(canvas: HTMLCanvasElement, e: Pick<Entity, 'name' | 'role' | 'kind' | 'age'>): void {
  if (!scene) return;
  const key = ensureCharacter(scene, e);
  const src = scene.textures.get(key).getSourceImage() as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // head and shoulders, scaled 2x
  ctx.drawImage(src, 0, 0, CHAR_W, CHAR_H - 4, 0, 4, CHAR_W * 2, (CHAR_H - 4) * 2);
}
