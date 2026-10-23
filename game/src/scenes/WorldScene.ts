import Phaser from 'phaser';
import { config } from '../config';
import { t, type I18nKey } from '../i18n';
import { Atmosphere, burst } from '../render/effects';
import { EntityView } from '../render/entityView';
import { toScreen } from '../render/iso';
import { WorldView } from '../render/worldView';
import { store, type Offer } from '../state/store';
import { bus } from '../ui/bus';
import { getPref, setPref } from '../ui/prefs';
import { itemIcon } from '../ui/itemIcons';
import { bagText } from '../ui/inventory';
import { WorldLabels, type Anchor } from '../ui/worldLabels';
import type { ItemBag, TilePos } from '../net/protocol';

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
    u.push(store.on('consult', ({ agentId, query }) => {
      if (!this.views.has(agentId)) return;
      const key = `${agentId}#consult`;
      const dy = this.labels.hasBubble(agentId) ? -80 : -46;
      this.labels.bubble(key, this.anchorFor(agentId), `💭 ${t('consult.bubble', { q: query })}`, { kind: 'consult', ms: config.minds.consultBubbleMs, dy });
    }));
    u.push(store.on('craft', ({ by, outputs, at }) => {
      const anchor = this.anchorForRef(by, at);
      this.labels.floater(anchor, this.bagNodes(outputs, '+'), '#ffd84a', 1900);
      const p = anchor.pos();
      if (p) burst(this, p.x, p.y - 8, 'build');
    }));
    u.push(store.on('trade', ({ from, to, give, get, kind }) => {
      const a = this.anchorForRef(from);
      const b = this.anchorForRef(to);
      if (!a.pos() || !b.pos()) return;
      this.labels.traveler(a, b, this.bagNodes(give, ''), 1400);
      if (kind === 'barter' && Object.keys(get ?? {}).length) setTimeout(() => this.labels.traveler(b, a, this.bagNodes(get, ''), 1400), 350);
    }));
    u.push(store.on('decay', ({ id, item, amount, reason }) => {
      if (!this.views.has(id)) return;
      const word = t(reason === 'spoiled' ? 'float.spoiled' : reason === 'broken' ? 'float.broken' : 'float.worn');
      this.labels.floater(this.anchorFor(id), [`-${amount} `, itemIcon(item, store.itemName(item), 'ico float-ico'), ` ${word}`], '#b8a8c0', 1800);
    }));
    u.push(store.on('discovery', ({ by, at }) => {
      this.cameras.main.flash(400, 255, 230, 140, false);
      const pos = at && 'x' in at ? at : undefined;
      const p = this.anchorForRef(by, pos).pos();
      if (p) {
        burst(this, p.x, p.y - 10, 'birth');
        burst(this, p.x, p.y - 14, 'build');
      }
    }));
    u.push(store.on('reputation', ({ changes }) => {
      for (const c of changes) {
        const d = c.esteem - c.prev;
        if (!this.views.has(c.id) || Math.abs(d) < config.society.esteemFloatDelta) continue;
        this.labels.floater(this.anchorFor(c.id), t(d > 0 ? 'float.esteemUp' : 'float.esteemDown'), d > 0 ? '#9ae07a' : '#ff8a7a', 1900);
      }
    }));
    u.push(store.on('aged', ({ id, stage }) => {
      const v = this.views.get(id);
      if (!v) return;
      this.labels.floater(this.anchorFor(id), t(`float.aged.${stage}` as I18nKey), '#c9d8ff', 2200);
      burst(this, v.sx, v.sy - 10, 'birth');
    }));
    u.push(store.on('family', () => this.views.forEach((v) => v.refreshGroup())));
    u.push(store.on('offer', (o) => this.showOffer(o)));
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

  /** Anchor on an entity (id or name), else on a fixed tile. */
  private anchorForRef(ref: string, at?: TilePos): Anchor {
    const e = store.resolve(ref);
    if (e && this.views.has(e.id)) return this.anchorFor(e.id);
    if (!at) return { pos: () => null };
    const tile = store.tileAt(at.x, at.y);
    const p = toScreen(at.x, at.y, tile?.elev ?? 1);
    return { pos: () => ({ x: p.sx, y: p.sy }) };
  }

  /** Barter offer: a bubble while pending, then the outcome (goods change hands when accepted). */
  private showOffer(o: Offer): void {
    if (!this.views.has(o.from)) return;
    const key = `${o.from}#offer`;
    const a = this.anchorFor(o.from);
    const to = store.personName(o.to);
    if (o.status === 'pending') {
      const text = o.kind === 'ask' ? `🙏 ${t('offer.ask', { want: bagText(o.want) })}` : `🤝 ${t('offer.bubble', { give: bagText(o.give), want: bagText(o.want) })}`;
      this.labels.bubble(key, a, text, { kind: 'offer', to, ms: config.society.offerBubbleMs });
      return;
    }
    const ok = o.status === 'accepted';
    this.labels.bubble(key, a, `${o.kind === 'ask' ? '🙏' : '🤝'} ${t(`offer.${o.status}` as I18nKey)}`, { kind: ok ? 'offer-ok' : 'offer-no', to, ms: 2200 });
    const b = this.anchorFor(o.to);
    if (ok && b.pos()) {
      this.labels.traveler(a, b, this.bagNodes(o.give, ''), 1400);
      setTimeout(() => this.labels.traveler(b, a, this.bagNodes(o.want, ''), 1400), 350);
      const p = a.pos();
      if (p) burst(this, p.x, p.y - 8, 'act');
    } else if (!ok) this.labels.floater(a, '✗', '#ff8a7a', 1200);
  }

  /** "+2 [icon] +1 [icon]" nodes for an item bag. */
  private bagNodes(bag: ItemBag, sign: string): (Node | string)[] {
    const out: (Node | string)[] = [];
    for (const [code, n] of Object.entries(bag ?? {})) {
      if (!(n > 0)) continue;
      out.push(`${out.length ? ' ' : ''}${sign}${n}`, itemIcon(code, store.itemName(code), 'ico float-ico'));
    }
    return out;
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
    this.fadeOccluders(delta);
    this.updateTags();

    const view = cam.worldView;
    this.labels.update((x, y) => ({ x: (x - view.x) * cam.zoom, y: (y - view.y) * cam.zoom }), cam.zoom);
    bus.emit('camera', { x: view.centerX, y: view.centerY, w: view.width, h: view.height });
  }

  /**
   * Trees and huts turn see-through whenever they hide ANY inhabitant on screen (more for you and
   * the selected one); hidden inhabitants also get a silhouette drawn above the canopy.
   */
  private fadeOccluders(delta: number): void {
    const view = this.cameras.main.worldView;
    const cfg = config.render;
    const boxes: { l: number; r: number; t: number; b: number; d: number; focus: boolean; v: EntityView }[] = [];
    for (const v of this.views.values()) {
      v.occluded = false;
      if (v.sx < view.x - 24 || v.sx > view.right + 24 || v.sy < view.y - 8 || v.sy > view.bottom + 48) continue;
      const focus = v.e.id === store.youId || v.e.id === store.selectedId;
      boxes.push({ l: v.sx - 7, r: v.sx + 7, t: v.sy - 27, b: v.sy - 2, d: v.depth, focus, v });
    }
    const k = Math.min(1, delta / 120);
    for (const img of this.world.occluders) {
      const left = img.x - img.displayWidth / 2;
      const right = left + img.displayWidth;
      const top = img.y - img.displayHeight;
      const bottom = img.y;
      if (right < view.x || left > view.right || bottom < view.y || top > view.bottom + 48) {
        if (img.alpha !== 1) img.setAlpha(1);
        continue;
      }
      let target = 1;
      for (const b of boxes) {
        if (b.d >= img.depth) continue;
        if (b.r > left + 3 && b.l < right - 3 && b.b > top + 3 && b.t < bottom - 1) {
          b.v.occluded = true;
          target = Math.min(target, b.focus ? cfg.occluderAlphaFocus : cfg.occluderAlpha);
        }
      }
      if (img.alpha !== target) {
        const a = img.alpha + (target - img.alpha) * k;
        img.setAlpha(Math.abs(a - target) < 0.01 ? target : a);
      }
    }
    for (const v of this.views.values()) v.updateGhost(delta);
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
