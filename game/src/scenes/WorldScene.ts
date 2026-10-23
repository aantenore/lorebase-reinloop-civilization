import Phaser from 'phaser';
import { config } from '../config';
import { t } from '../i18n';
import { Atmosphere, burst } from '../render/effects';
import { EntityView } from '../render/entityView';
import { toScreen } from '../render/iso';
import { WorldView } from '../render/worldView';
import { store } from '../state/store';
import { bus } from '../ui/bus';
import { getPref, setPref } from '../ui/prefs';
import { WorldLabels, type Anchor } from '../ui/worldLabels';

const ZOOMS = [1, 1.5, 2, 3, 4, 5];

export class WorldScene extends Phaser.Scene {
  private views = new Map<string, EntityView>();
  private world!: WorldView;
  private atmo!: Atmosphere;
  private labels = new WorldLabels();
  private follow = getPref('follow', true);
  private dragging = false;
  private downAt: { x: number; y: number } | null = null;
  private hoverId: string | null = null;
  private groupFocus: string | null = null;
  private hpLoss = new Map<string, number>();
  private unsubs: (() => void)[] = [];

  constructor() {
    super('world');
  }

  create(): void {
    const cam = this.cameras.main;
    cam.setBackgroundColor('#141c2c');
    cam.setRoundPixels(true);
    cam.setZoom(getPref('zoom', config.zoom.initial));

    this.world = new WorldView(this, store);
    this.atmo = new Atmosphere(this);
    this.world.onFiresChanged = () => this.atmo.setLights(this.world.fires, this.world.windows);

    this.subscribe();
    this.setupPointer();
    if (store.hasHello) this.onHello();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.unsubs.forEach((u) => u()));
  }

  // ------------------------------------------------------------------ store wiring

  private subscribe(): void {
    const u = this.unsubs;
    u.push(store.on('hello', () => this.onHello()));
    u.push(store.on('entity_added', (e) => {
      this.addView(e.id);
      const v = this.views.get(e.id);
      if (v) burst(this, v.sx, v.sy - 10, 'birth');
    }));
    u.push(store.on('entity_removed', ({ id, reason }) => {
      const v = this.views.get(id);
      if (v) {
        burst(this, v.sx, v.sy - 10, /death|died|morto|starv|cold/i.test(reason) ? 'death' : 'act');
        v.destroy();
        this.views.delete(id);
      }
      this.labels.tag(id, null);
    }));
    u.push(store.on('entity_delta', ({ e, prevHp, prevInv, prevAlive }) => {
      const anchor = this.anchorFor(e.id);
      const dw = e.inventory.wood - prevInv.wood;
      const df = e.inventory.food - prevInv.food;
      if (dw > 0) this.labels.floater(anchor, t('float.wood', { n: dw }), '#e0bf8c');
      if (dw < 0 && e.id === store.youId) this.labels.floater(anchor, t('float.woodLoss', { n: -dw }), '#c9b79a');
      if (df > 0) this.labels.floater(anchor, t('float.food', { n: df }), '#ff7088');
      const lost = (this.hpLoss.get(e.id) ?? 0) + Math.max(0, prevHp - e.hp);
      if (lost >= 3) {
        this.labels.floater(anchor, t('float.hp', { n: -Math.round(lost) }), '#ff5a4a');
        this.hpLoss.set(e.id, 0);
      } else this.hpLoss.set(e.id, lost);
      if (prevAlive && !e.alive) {
        const v = this.views.get(e.id);
        if (v) burst(this, v.sx, v.sy - 10, 'death');
      }
      if ((dw > 0 || df > 0) && this.views.get(e.id)) {
        const v = this.views.get(e.id)!;
        burst(this, v.sx, v.sy - 6, 'act');
      }
    }));
    u.push(store.on('say', (line) => {
      if (!this.views.has(line.from)) return;
      const to = line.to !== 'all' && line.kind === 'speech' ? store.name(line.to) : undefined;
      this.labels.bubble(line.from, this.anchorFor(line.from), line.text, { kind: line.kind, to });
    }));
    u.push(store.on('say_stream', (s) => {
      if (!s.done) this.labels.bubble(s.from, this.anchorFor(s.from), `${s.text}…`, { kind: 'stream', ms: 4000 });
    }));
    u.push(store.on('group', () => this.views.forEach((v) => v.refreshGroup())));
    u.push(store.on('group_removed', () => this.views.forEach((v) => v.refreshGroup())));
    u.push(store.on('tile', (tile) => this.world.updateTile(tile)));
    u.push(store.on('time', (tm) => {
      this.atmo.setTime(tm.minute, tm.season);
      if (tm.seasonChanged) this.world.setSeason(tm.season);
    }));
    u.push(store.on('world_event', (ev) => {
      if (ev.at) {
        const tile = store.tileAt(ev.at.x, ev.at.y);
        const p = toScreen(ev.at.x, ev.at.y, tile?.elev ?? 1);
        burst(this, p.sx, p.sy - 6, ev.kind === 'build' ? 'build' : ev.kind === 'death' ? 'death' : 'birth');
      }
      if (ev.kind === 'season' || ev.kind === 'death' || ev.kind === 'group') bus.emit('toast', { text: ev.text });
    }));
    u.push(store.on('rules_changed', ({ revision }) => {
      bus.emit('toast', { text: t('laws.changed', { rev: revision.slice(0, 7) }), big: true });
      this.cameras.main.flash(250, 255, 216, 74, false);
    }));
    u.push(store.on('select', ({ id }) => this.views.forEach((v) => v.root.setData('sel', v.e.id === id))));
    u.push(bus.on('center', ({ x, y }) => {
      this.setFollow(false);
      const tile = store.tileAt(x, y);
      const p = toScreen(x, y, tile?.elev ?? 1);
      this.cameras.main.centerOn(p.sx, p.sy);
    }));
    u.push(bus.on('follow', ({ on }) => this.setFollow(on ?? !this.follow)));
    u.push(bus.on('group', ({ id }) => {
      this.groupFocus = id;
      const g = id ? store.groups.get(id) : undefined;
      this.views.forEach((v) => v.setHighlight(g && g.members.includes(v.e.id) ? g.color : null));
    }));
  }

  private onHello(): void {
    this.views.forEach((v) => v.destroy());
    this.views.clear();
    this.labels.clearAll();
    this.world.build();
    for (const id of store.entities.keys()) this.addView(id);
    this.atmo.setTime(store.time.minute, store.time.season);
    const you = store.you();
    const focus = you ?? { x: store.mapW / 2, y: store.mapH / 2 };
    const p = toScreen(focus.x, focus.y, 1);
    this.cameras.main.centerOn(p.sx, p.sy);
    if (you) this.setFollow(true);
  }

  private addView(id: string): void {
    const e = store.entities.get(id);
    if (!e || this.views.has(id)) return;
    this.views.set(id, new EntityView(this, store, e));
  }

  private anchorFor(id: string): Anchor {
    return {
      pos: () => {
        const v = this.views.get(id);
        return v ? { x: v.sx, y: v.sy } : null;
      },
    };
  }

  private setFollow(on: boolean): void {
    this.follow = on;
    setPref('follow', on);
    bus.emit('followChanged', { on });
  }

  // ------------------------------------------------------------------ pointer

  private setupPointer(): void {
    const cam = this.cameras.main;
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.downAt = { x: p.x, y: p.y };
      this.dragging = false;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!p.isDown || !this.downAt) return;
      if (!this.dragging && Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y) > 5) {
        this.dragging = true;
        this.setFollow(false);
      }
      if (this.dragging) {
        cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
        cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
      }
    });
    this.input.on('pointerup', (_p: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
      const wasDrag = this.dragging;
      this.downAt = null;
      this.dragging = false;
      if (wasDrag) return;
      const obj = over[0];
      const gid = obj?.getData('groupId') as string | undefined;
      const eid = obj?.getData('entityId') as string | undefined;
      if (gid) bus.emit('group', { id: gid });
      else if (eid) store.select(eid);
      else store.select(null);
    });
    this.input.on('gameobjectover', (_p: unknown, obj: Phaser.GameObjects.GameObject) => {
      this.hoverId = (obj.getData('entityId') as string) ?? null;
    });
    this.input.on('gameobjectout', () => (this.hoverId = null));
    this.input.on('wheel', (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      const i = ZOOMS.findIndex((z) => z >= cam.zoom - 0.01);
      const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + (dy > 0 ? -1 : 1)))];
      if (next === cam.zoom) return;
      const before = cam.getWorldPoint(p.x, p.y);
      cam.setZoom(next);
      cam.preRender();
      const after = cam.getWorldPoint(p.x, p.y);
      cam.scrollX += before.x - after.x;
      cam.scrollY += before.y - after.y;
      setPref('zoom', next);
    });
  }

  // ------------------------------------------------------------------ frame

  update(_time: number, delta: number): void {
    const now = performance.now();
    const cam = this.cameras.main;
    for (const v of this.views.values()) v.update(now, delta, v.e.id === store.selectedId);

    const you = store.youId ? this.views.get(store.youId) : undefined;
    if (this.follow && you) {
      const mid = cam.midPoint;
      const k = Math.min(1, delta / 140);
      cam.centerOn(mid.x + (you.sx - mid.x) * k, mid.y + (you.sy - 14 - mid.y) * k);
    }

    this.world.update(delta);
    this.atmo.update(cam, delta);
    this.fadeOccluders(you);
    this.updateTags();

    const view = cam.worldView;
    this.labels.update((x, y) => ({ x: (x - view.x) * cam.zoom, y: (y - view.y) * cam.zoom }), cam.zoom);
    bus.emit('camera', { x: view.centerX, y: view.centerY, w: view.width, h: view.height });
  }

  /** Trees and huts turn see-through when they hide you or the selected inhabitant. */
  private fadeOccluders(you: EntityView | undefined): void {
    const watch: EntityView[] = [];
    if (you) watch.push(you);
    const sel = store.selectedId ? this.views.get(store.selectedId) : undefined;
    if (sel && sel !== you) watch.push(sel);
    for (const img of this.world.occluders) {
      let hide = false;
      for (const v of watch) {
        if (v.depth >= img.depth) continue;
        const left = img.x - img.displayWidth / 2;
        const top = img.y - img.displayHeight;
        if (v.sx > left && v.sx < left + img.displayWidth && v.sy - 8 > top && v.sy - 8 < img.y + 2) hide = true;
      }
      img.setAlpha(hide ? 0.45 : 1);
    }
  }

  private updateTags(): void {
    const show = new Set<string>();
    if (this.hoverId) show.add(this.hoverId);
    if (store.selectedId) show.add(store.selectedId);
    if (this.groupFocus) store.groups.get(this.groupFocus)?.members.forEach((m) => show.add(m));
    for (const v of this.views.values()) {
      if (!show.has(v.e.id)) {
        this.labels.tag(v.e.id, null);
        continue;
      }
      const e = v.e;
      const pct = Math.max(0, Math.min(100, (e.hp / Math.max(1, e.maxHp)) * 100));
      this.labels.tag(e.id, this.anchorFor(e.id), e.name, pct);
    }
  }
}
