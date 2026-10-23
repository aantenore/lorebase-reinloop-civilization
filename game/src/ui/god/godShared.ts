import { config } from '../../config';
import { t } from '../../i18n';
import type { GameTime } from '../../net/protocol';
import { store } from '../../state/store';
import { bus } from '../bus';
import { fmtClock, h } from '../dom';

/** "Apri in Lorebase" link to the explorer of the Lorebase web UI. */
export function lorebaseLink(): HTMLElement {
  return h('a', { class: 'btn god-link', href: `${config.lorebaseUi.base}${config.lorebaseUi.explorerPath}`, target: '_blank', rel: 'noopener' }, t('god.openLorebase'));
}

/** Point the camera at an entity and select it (opens the inspector). */
export function focusEntity(id: string): void {
  const e = store.resolve(id);
  if (!e) return;
  bus.emit('center', { x: e.x, y: e.y });
  store.select(e.id);
}

export function fmtAt(at: GameTime | undefined): string {
  return at ? `g${at.day} ${fmtClock(at.minute)}` : '';
}

/** Segmented control; `onPick` receives the chosen value. */
export function segmented<T extends string>(options: { value: T; label: string }[], current: T, onPick: (v: T) => void): HTMLElement {
  const seg = h('div', { class: 'seg' });
  const paint = (v: T) => [...seg.children].forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.v === v));
  for (const o of options)
    seg.append(
      h('button', { class: 'btn', 'data-v': o.value, onclick: () => (paint(o.value), onPick(o.value)) }, o.label),
    );
  paint(current);
  return seg;
}

/** Keystrokes inside god-mode fields never reach the game controls. */
export function isolateKeys(el: HTMLElement): void {
  el.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') ev.stopPropagation();
  });
}

/** Generic key/value rendering for server payloads whose nested shape may vary. */
export function kvTable(obj: Record<string, unknown> | undefined, path = ''): HTMLElement {
  const grid = h('div', { class: 'god-kv' });
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === undefined || v === null) continue;
    const p = path ? `${path}.${k}` : k;
    if (typeof v === 'object' && !Array.isArray(v)) {
      grid.append(h('div', { class: 'k' }, k), h('div', { class: 'v' }, kvTable(v as Record<string, unknown>, p)));
    } else grid.append(h('div', { class: 'k' }, k), h('div', { class: 'v' }, fmtValue(p, v)));
  }
  return grid;
}

/** Formats a leaf by its dotted path (`costUsd.byModel.opus` is money). */
function fmtValue(k: string, v: unknown): string {
  if (typeof v === 'number') {
    if (/cost|usd/i.test(k)) return `$${v.toFixed(v < 1 ? 4 : 2)}`;
    if (/bytes/i.test(k)) return fmtBytes(v);
    return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
  }
  return Array.isArray(v) ? v.join(', ') : String(v);
}

export function fmtBytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
