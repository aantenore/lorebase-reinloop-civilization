import Phaser from 'phaser';
import { config } from '../config';
import type { Season, Tile } from '../net/protocol';
import type { Store } from '../state/store';
import { depthOf, TILE_H, TILE_SIDE, toScreen } from './iso';
import { hash } from './palette';
import { TILE_VARIANTS, tileKey, WATER_FRAMES } from './textures';

interface TileProps {
  objs: Phaser.GameObjects.GameObject[];
  hadBush: boolean;
}

/** Ground tiles and the props standing on them (trees, bushes, huts, fires...). */
export class WorldView {
  private tileImgs: Phaser.GameObjects.Image[] = [];
  private props: TileProps[] = [];
  private waterFrame = 0;
  private waterTimer = 0;
  private season: Season = 'spring';
  /** Campfire positions (screen space) for lights and smoke. */
  fires: { x: number; y: number; sprite: Phaser.GameObjects.Sprite }[] = [];
  /** Lit windows (screen space). */
  windows: { x: number; y: number; tile: Tile }[] = [];
  /** Tall props that can hide characters behind them. */
  occluders: Phaser.GameObjects.Image[] = [];
  onFiresChanged: () => void = () => {};

  constructor(private scene: Phaser.Scene, private store: Store) {}

  build(): void {
    this.destroy();
    this.season = this.store.time.season;
    const { tiles } = this.store;
    for (const t of tiles) {
      const { sx, sy } = toScreen(t.x, t.y, t.elev);
      const img = this.scene.add.image(sx, sy, tileKey(t.biome, this.season, this.variant(t)), 0);
      img.setOrigin(0.5, TILE_H / 2 / (TILE_H + TILE_SIDE));
      img.setDepth(depthOf(t.x, t.y, -6));
      this.tileImgs.push(img);
    }
    this.props = tiles.map((t) => ({ objs: [], hadBush: t.food > 0 }));
    for (const t of tiles) this.buildProps(t);
    this.onFiresChanged();
  }

  destroy(): void {
    this.tileImgs.forEach((i) => i.destroy());
    this.tileImgs = [];
    this.props.forEach((p) => p.objs.forEach((o) => o.destroy()));
    this.props = [];
    this.fires = [];
    this.windows = [];
    this.occluders = [];
  }

  private variant(t: Tile): number {
    return hash(`${t.x},${t.y}`) % TILE_VARIANTS;
  }

  private idx(t: Tile): number {
    return t.y * this.store.mapW + t.x;
  }

  /** Re-skin everything for a new season (snow, autumn leaves...). */
  setSeason(season: Season): void {
    if (season === this.season) return;
    this.season = season;
    for (const t of this.store.tiles) {
      this.tileImgs[this.idx(t)]?.setTexture(tileKey(t.biome, season, this.variant(t)), t.biome === 'water' ? this.waterFrame : 0);
      this.buildProps(t);
    }
    this.onFiresChanged();
  }

  updateTile(t: Tile): void {
    this.buildProps(t);
    // a hut next door may have gained / lost a campfire
    const n = this.store.tileAt(t.x + 1, t.y + 1);
    if (n) this.buildProps(n);
    this.onFiresChanged();
  }

  private buildProps(t: Tile): void {
    const slot = this.props[this.idx(t)];
    if (!slot) return;
    slot.objs.forEach((o) => {
      this.occluders = this.occluders.filter((x) => x !== o);
      this.fires = this.fires.filter((f) => f.sprite !== o);
      o.destroy();
    });
    slot.objs = [];
    this.windows = this.windows.filter((w) => w.tile !== t);
    if (t.food > 0) slot.hadBush = true;
    const look = this.season;
    const { sx, sy } = toScreen(t.x, t.y, t.elev);
    const h = hash(`${t.x}:${t.y}`);
    const add = (key: string, frame: number, dx: number, dy: number, bias = 2, occluder = false) => {
      const img = this.scene.add.image(sx + dx, sy + dy, key, frame).setOrigin(0.5, 1);
      img.setDepth(depthOf(t.x, t.y, bias));
      if ((h >>> 5) % 2 === 0 && key.startsWith('pine')) img.setFlipX(true);
      slot.objs.push(img);
      if (occluder) this.occluders.push(img);
      return img;
    };

    if (t.shelter === 2) {
      add(`hut_${look}`, 0, 0, 5, 4, true);
      this.windows.push({ x: sx + 6, y: sy - 9, tile: t });
    } else if (t.shelter === 1) {
      add(`tent_${look}`, 0, 0, 4, 4, true);
    }
    if (t.shelter === 0) {
      if (t.biome === 'forest' && t.wood > 0) {
        // display density only: a share of forest tiles shows trees, the rest low undergrowth
        const roll = ((h >>> 8) % 1000) / 1000;
        const kind = h % 3 === 0 ? 'oak' : 'pine';
        const fr = (h >>> 3) % 2;
        if (roll >= config.render.forestTreeShare) {
          add(`undergrowth_${look}`, (h >>> 6) % 3, ((h >>> 4) % 7) - 3, 5, 1);
        } else if (t.wood >= 5 && roll < config.render.forestTreeShare * config.render.forestPairShare) {
          add(`${kind}_${look}`, fr, -6, 0, 2, true);
          add(`${h % 2 ? 'pine' : 'oak'}_${look}`, 1 - fr, 6, 5, 3, true);
        } else {
          add(`${kind}_${look}`, fr, ((h >>> 4) % 5) - 2, 3, 2, true);
        }
      } else if (t.biome === 'rock' && h % 3 === 0) {
        add(`rocks_${look}`, 0, 0, 4);
      }
      if (t.biome !== 'forest' && t.biome !== 'water') {
        if (t.food > 0 || slot.hadBush) add(`bush_${look}`, t.food > 0 ? 0 : 1, 0, 4);
        if (t.wood > 0) add('woodpile', 0, t.food > 0 ? 7 : 0, 5, 3);
      }
      const back = this.store.tileAt(t.x - 1, t.y - 1);
      if (back?.shelter === 2 && t.biome !== 'water') {
        const fire = this.scene.add.sprite(sx, sy + 4, 'campfire', 0).setOrigin(0.5, 1).setDepth(depthOf(t.x, t.y, 2));
        fire.play('campfire');
        slot.objs.push(fire);
        this.fires.push({ x: sx, y: sy, sprite: fire });
      }
    }
  }

  update(dt: number): void {
    this.waterTimer += dt;
    if (this.waterTimer > 420) {
      this.waterTimer = 0;
      this.waterFrame = (this.waterFrame + 1) % WATER_FRAMES;
      if (this.season !== 'winter') {
        for (const t of this.store.tiles) {
          if (t.biome === 'water') this.tileImgs[this.idx(t)]?.setFrame(this.waterFrame);
        }
      }
    }
  }
}
