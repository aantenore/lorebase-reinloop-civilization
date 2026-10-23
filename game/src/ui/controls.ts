import { config } from '../config';
import { t } from '../i18n';
import type { ActAction } from '../net/protocol';
import { session } from '../net/session';
import { screenDirToTile } from '../render/iso';
import { store } from '../state/store';
import { bus } from './bus';
import { isTyping } from './dom';
import { panels } from './panels';

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};
// G is reserved for god mode; gathering stays on E/Space (context action)
const ACT_KEYS: Record<string, ActAction> = { KeyC: 'chop', KeyB: 'build', KeyQ: 'eat' };
/** Panel id of the god-mode overlay: while open the player body does not move or act. */
const GOD_PANEL = 'god';
const godOn = () => panels.isOpen(GOD_PANEL);

let dialogOpen = false;
const held = new Set<string>();
let lastSent = { dx: 0, dy: 0 };

function sendInput(): void {
  let sx = 0;
  let sy = 0;
  if (!dialogOpen && !godOn()) for (const k of held) {
    const v = MOVE_KEYS[k];
    if (v) {
      sx += v[0];
      sy += v[1];
    }
  }
  const { dx, dy } = screenDirToTile(Math.sign(sx), Math.sign(sy));
  if (dx === lastSent.dx && dy === lastSent.dy) return;
  lastSent = { dx, dy };
  if (store.youId) session.send({ type: 'input', dx, dy });
}

/** Nearest living agent within talking range of the player. */
function nearestAgent(): string | null {
  const you = store.you();
  if (!you) return null;
  let best: string | null = null;
  let bestD = config.talkRange;
  for (const e of store.entities.values()) {
    if (e.id === you.id || !e.alive || e.kind === 'player') continue;
    const d = Math.hypot(e.x - you.x, e.y - you.y);
    if (d < bestD) {
      bestD = d;
      best = e.id;
    }
  }
  return best;
}

/** Tile the player is facing plus its own tile: pick what makes sense there. */
function contextAct(forced?: ActAction): void {
  const you = store.you();
  if (!you) return;
  if (forced === 'eat') return session.send({ type: 'act', action: 'eat', args: {} });
  const facing: Record<string, [number, number]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
  const [fx, fy] = facing[you.dir] ?? [0, 0];
  const around = [
    [Math.round(you.x + fx), Math.round(you.y + fy)],
    [Math.round(you.x), Math.round(you.y)],
    [Math.round(you.x) + 1, Math.round(you.y)],
    [Math.round(you.x) - 1, Math.round(you.y)],
    [Math.round(you.x), Math.round(you.y) + 1],
    [Math.round(you.x), Math.round(you.y) - 1],
  ];
  for (const [x, y] of around) {
    const tile = store.tileAt(x, y);
    if (!tile) continue;
    const action: ActAction | null =
      forced ?? (tile.biome === 'forest' && tile.wood > 0 ? 'chop' : tile.food > 0 ? 'gather' : null);
    if (!action) continue;
    if (action === 'chop' && !(tile.biome === 'forest' && tile.wood > 0)) continue;
    if (action === 'gather' && tile.food <= 0) continue;
    return session.send({ type: 'act', action, args: { x, y } });
  }
  if (forced === 'build') return session.send({ type: 'act', action: 'build', args: { x: Math.round(you.x + fx), y: Math.round(you.y + fy) } });
  bus.emit('toast', { text: t('act.nothing') });
}

export function installControls(): void {
  panels.onChange((id, open) => {
    if (id !== GOD_PANEL) return;
    held.clear();
    sendInput();
    if (open) bus.emit('follow', { on: false });
  });
  bus.on('dialog', ({ id }) => {
    dialogOpen = !!id;
    if (dialogOpen) {
      held.clear();
      sendInput();
    }
  });
  window.addEventListener('keydown', (ev) => {
    if (isTyping(ev) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (MOVE_KEYS[ev.code]) {
      ev.preventDefault();
      if (godOn()) return;
      held.add(ev.code);
      sendInput();
      return;
    }
    if (ev.repeat) return;
    // C and E are actions while playing: panels then answer to Shift+C / Shift+E (Shift+O mirrors them)
    if ((ev.shiftKey || !store.youId || godOn()) && (ev.code === 'KeyC' || ev.code === 'KeyE' || ev.code === 'KeyO')) {
      const p = panels.byKey(ev.code.slice(3).toLowerCase());
      if (p) return panels.toggle(p.id);
    }
    if (ev.code === 'KeyE' || ev.code === 'Space') {
      ev.preventDefault();
      if (!store.youId || godOn()) return;
      const target = nearestAgent();
      if (target) {
        store.select(target);
        bus.emit('dialog', { id: target });
      } else contextAct();
      return;
    }
    if (ACT_KEYS[ev.code] && !godOn()) return contextAct(ACT_KEYS[ev.code]);
    if (ev.code === 'KeyF') return bus.emit('follow', {});
    if (ev.code === 'Escape') {
      if (dialogOpen) return bus.emit('dialog', { id: null });
      if (store.selectedId) return store.select(null);
      for (const p of panels.all()) if (p.id !== 'hud' && panels.isOpen(p.id)) return panels.set(p.id, false);
      return;
    }
    const panel = panels.byKey(ev.key.toLowerCase());
    if (panel) panels.toggle(panel.id);
  });
  window.addEventListener('keyup', (ev) => {
    if (held.delete(ev.code)) sendInput();
  });
  window.addEventListener('blur', () => {
    held.clear();
    sendInput();
  });
}
