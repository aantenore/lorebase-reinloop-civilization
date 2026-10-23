import Phaser from 'phaser';
import type { EntityState, Store } from '../state/store';
import { CHAR_FEET, CHAR_H, ensureCharacter, frameFor } from './characters';
import { depthOf, toScreen } from './iso';
import { hash, hexToInt } from './palette';
import { ensureBanner } from './textures';

/** All the sprites that make up one inhabitant on screen. */
export class EntityView {
  readonly root: Phaser.GameObjects.Container;
  readonly body: Phaser.GameObjects.Sprite;
  private shadow: Phaser.GameObjects.Image;
  private ring: Phaser.GameObjects.Image;
  private aura: Phaser.GameObjects.Image | null = null;
  private marker: Phaser.GameObjects.Image | null = null;
  private thought: Phaser.GameObjects.Sprite;
  private banner: Phaser.GameObjects.Image | null = null;
  private you: Phaser.GameObjects.Image | null = null;
  private selArrow: Phaser.GameObjects.Image;
  private glow: Phaser.FX.Glow | null = null;
  private phase: number;
  private elev = 1;
  private zzzT = 0;
  /** Screen position of the feet (world pixels). */
  sx = 0;
  sy = 0;
  depth = 0;

  constructor(private scene: Phaser.Scene, private store: Store, public e: EntityState) {
    this.phase = hash(e.id) % 1000;
    this.root = scene.add.container(0, 0);
    this.shadow = scene.add.image(0, 0, 'shadow');
    this.ring = scene.add.image(0, 1, 'ring').setVisible(false);
    if (e.tier === 'opus') {
      this.aura = scene.add.image(0, 0, 'glow').setTint(0xffd84a).setBlendMode(Phaser.BlendModes.ADD).setScale(0.55, 0.26).setAlpha(0.5);
    }
    const key = ensureCharacter(scene, e);
    this.body = scene.add.sprite(0, 0, key, 0).setOrigin(0.5, CHAR_FEET / CHAR_H);
    this.body.setInteractive({ useHandCursor: true });
    this.body.setData('entityId', e.id);
    if (e.tier !== 'human' && e.kind !== 'crowd') this.marker = scene.add.image(0, -27, `tier_${e.tier}`).setOrigin(0.5, 1);
    if (e.id === store.youId) this.you = scene.add.image(0, -29, 'arrow').setOrigin(0.5, 1);
    this.thought = scene.add.sprite(7, -24, 'thought', 0).setOrigin(0, 1).setVisible(false);
    this.selArrow = scene.add.image(0, -33, 'arrow').setOrigin(0.5, 1).setVisible(false).setTint(0xffffff);
    const parts: Phaser.GameObjects.GameObject[] = [this.shadow, this.ring];
    if (this.aura) parts.push(this.aura);
    parts.push(this.body);
    if (this.marker) parts.push(this.marker);
    if (this.you) parts.push(this.you);
    parts.push(this.thought, this.selArrow);
    this.root.add(parts);
    this.refreshGroup();
  }

  /** Group ring colour, and the banner if this entity carries the group flag. */
  refreshGroup(): void {
    const g = this.e.groupId ? this.store.groups.get(this.e.groupId) : undefined;
    this.ring.setVisible(!!g);
    if (g) this.ring.setTint(hexToInt(g.color)).setAlpha(0.85);
    const carrier = g && (g.leader ?? g.members[0]) === this.e.id;
    this.banner?.destroy();
    this.banner = null;
    if (g && carrier) {
      this.banner = this.scene.add.image(-9, -4, ensureBanner(this.scene, g.color)).setOrigin(0.5, 1);
      this.banner.setInteractive({ useHandCursor: true });
      this.banner.setData('groupId', g.id);
      this.root.addAt(this.banner, this.root.getIndex(this.body));
    }
  }

  setHighlight(color: string | null): void {
    const fx = this.body.preFX;
    if (!fx) return;
    if (this.glow) {
      fx.remove(this.glow);
      this.glow = null;
    }
    if (color) this.glow = fx.addGlow(hexToInt(color), 3, 0, false, 0.1, 6);
  }

  update(now: number, dt: number, selected: boolean): void {
    const e = this.e;
    const pos = this.store.renderPos(e, now);
    const tile = this.store.tileAt(pos.x, pos.y);
    const targetElev = tile ? Math.max(tile.elev, 0) : 1;
    this.elev += (targetElev - this.elev) * Math.min(1, dt / 90);
    const { sx, sy } = toScreen(pos.x, pos.y, this.elev);
    this.sx = sx;
    this.sy = sy;
    this.root.setPosition(Math.round(sx), Math.round(sy));
    this.depth = depthOf(pos.x, pos.y, 5);
    this.root.setDepth(this.depth);

    const anim = e.alive ? e.anim : 'sleep';
    const { frame, flip } = frameFor(anim, e.dir, now, this.phase);
    this.body.setFrame(frame).setFlipX(flip);
    this.root.setAlpha(e.alive ? 1 : 0.45);
    if (!e.alive) this.body.setTint(0x9a9aaa);

    const t = now / 1000;
    if (this.aura) this.aura.setAlpha(0.35 + Math.sin(t * 2 + this.phase) * 0.15);
    if (this.marker) this.marker.y = -27 + Math.round(Math.sin(t * 2.4 + this.phase) * 1);
    if (this.you) this.you.y = -30 + Math.round(Math.sin(t * 5) * 2);
    this.thought.setVisible(e.thinking);
    if (e.thinking) this.thought.setFrame(Math.floor(t * 3) % 3);
    this.selArrow.setVisible(selected && !this.you);
    if (selected) this.selArrow.y = (this.marker ? -35 : -30) + Math.round(Math.sin(t * 6) * 2);
    this.shadow.setScale(anim === 'sleep' ? 1.5 : 1, 1);

    if (anim === 'sleep' && e.alive) {
      this.zzzT -= dt;
      if (this.zzzT <= 0) {
        this.zzzT = 1400;
        const z = this.scene.add.image(this.sx + 6, this.sy - 12, 'zzz').setDepth(this.depth + 1);
        this.scene.tweens.add({ targets: z, y: z.y - 16, x: z.x + 6, alpha: 0, duration: 1800, onComplete: () => z.destroy() });
      }
    }
  }

  destroy(): void {
    this.root.destroy();
  }
}
