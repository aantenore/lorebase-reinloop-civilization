import Phaser from 'phaser';
import { generateWorldTextures } from '../render/textures';

/** Builds every procedural texture and shared animation, then hands over to the world. */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot');
  }

  create(): void {
    generateWorldTextures(this);
    this.anims.create({
      key: 'campfire',
      frames: [0, 1, 2, 1].map((frame) => ({ key: 'campfire', frame })),
      frameRate: 7,
      repeat: -1,
    });
    this.scene.start('world');
  }
}
