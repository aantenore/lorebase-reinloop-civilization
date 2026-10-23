import type { Biome } from '../net/protocol';
import { TILE_W } from '../render/iso';
import { store } from '../state/store';
import { bus } from './bus';
import { h, uiRoot } from './dom';
import { panels } from './panels';

const BIOME: Record<Biome, string> = { grass: '#5ea94f', forest: '#2f5c37', water: '#3874c9', rock: '#8f8c99', sand: '#e4c58c' };
const WINTER: Partial<Record<Biome, string>> = { grass: '#e6edf6', forest: '#9fb4a8', water: '#a9d3ea', sand: '#efe6d6' };
const SCALE = 2;

/** Isometric minimap: click to look somewhere. */
export function mountMinimap(): void {
  const canvas = h('canvas') as HTMLCanvasElement;
  const el = h('div', { class: 'px minimap hidden' }, canvas);
  uiRoot().append(el);
  panels.register({ id: 'minimap', key: 'm', defaultOpen: false, el, onOpen: () => draw() });
  let cam = { x: 0, y: 0, w: 0, h: 0 };
  const ctx = canvas.getContext('2d')!;

  const proj = (x: number, y: number) => ({ px: (x - y + store.mapH) * SCALE, py: (x + y) * (SCALE / 2) });

  const draw = () => {
    if (!store.hasHello || !panels.isOpen('minimap')) return;
    const W = (store.mapW + store.mapH) * SCALE + SCALE * 2;
    const H = (store.mapW + store.mapH) * (SCALE / 2) + SCALE;
    if (canvas.width !== W) {
      canvas.width = W;
      canvas.height = H;
      canvas.style.width = `${W * 1.5}px`;
      canvas.style.height = `${H * 1.5}px`;
    }
    ctx.clearRect(0, 0, W, H);
    const winter = store.time.season === 'winter';
    for (const tile of store.tiles) {
      const { px, py } = proj(tile.x, tile.y);
      ctx.fillStyle = tile.shelter ? '#c79a46' : (winter && WINTER[tile.biome]) || BIOME[tile.biome];
      ctx.fillRect(px, py, SCALE * 2, SCALE);
    }
    for (const e of store.entities.values()) {
      if (!e.alive) continue;
      const g = e.groupId ? store.groups.get(e.groupId) : undefined;
      const { px, py } = proj(e.x, e.y);
      ctx.fillStyle = '#17111a';
      ctx.fillRect(px, py - 1, 4, 4);
      ctx.fillStyle = e.id === store.youId ? '#ffffff' : g?.color ?? '#ffd84a';
      ctx.fillRect(px + 1, py, 2, 2);
    }
    // camera view: the minimap is the iso screen projection scaled by SCALE / (TILE_W / 2)
    const k = SCALE / (TILE_W / 2);
    const left = (cam.x - cam.w / 2) * k + store.mapH * SCALE + SCALE;
    const top = (cam.y - cam.h / 2) * k + SCALE / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.round(cam.w * k), Math.round(cam.h * k));
  };

  canvas.addEventListener('click', (ev) => {
    const r = canvas.getBoundingClientRect();
    const mx = ((ev.clientX - r.left) / r.width) * canvas.width;
    const my = ((ev.clientY - r.top) / r.height) * canvas.height;
    const a = mx / SCALE - store.mapH; // x - y
    const b = my / (SCALE / 2); // x + y
    bus.emit('center', { x: (a + b) / 2, y: (b - a) / 2 });
  });
  bus.on('camera', (c) => (cam = c));
  setInterval(draw, 300);
}
