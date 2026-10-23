import { t } from '../i18n';
import type { ToolState } from '../net/protocol';
import { store, type EntityState } from '../state/store';
import { h } from './dom';
import { itemIcon } from './itemIcons';

/** Items with a positive amount, food and wood first, then by amount. */
export function inventoryItems(e: EntityState): [string, number][] {
  const order = (k: string) => (k === 'food' ? 0 : k === 'wood' ? 1 : 2);
  return Object.entries(e.inventory ?? {})
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .sort((a, b) => order(a[0]) - order(b[0]) || b[1] - a[1]);
}

/** Icon + amount chips (HUD and inspector). `max` caps the count, the rest is summed into "+N". */
export function inventoryChips(e: EntityState, max = Infinity): HTMLElement[] {
  const items = inventoryItems(e);
  const shown = items.slice(0, max);
  const chips = shown.map(([code, n]) => h('span', { class: 'chip', title: store.itemName(code) }, itemIcon(code, store.itemName(code)), h('b', {}, String(n))));
  if (items.length > shown.length) chips.push(h('span', { class: 'chip muted' }, `+${items.length - shown.length}`));
  if (!items.length) chips.push(h('span', { class: 'chip muted' }, '—'));
  return chips;
}

/** Tool rows with a durability bar. */
export function toolRows(tools: ToolState[] | undefined): HTMLElement | null {
  if (!tools?.length) return null;
  return h(
    'div',
    { class: 'tools' },
    h('div', { class: 'section-title' }, t('insp.tools')),
    ...tools.map((tl) => {
      const pct = Math.max(0, Math.min(100, (tl.durability / Math.max(1, tl.max)) * 100));
      const color = pct > 50 ? 'var(--green)' : pct > 20 ? 'var(--gold-d)' : 'var(--red)';
      return h(
        'div',
        { class: 'tool-row', title: `${Math.round(tl.durability)}/${tl.max}` },
        itemIcon(tl.item, store.itemName(tl.item)),
        h('span', {}, store.itemName(tl.item)),
        h('div', { class: 'bar dura' }, h('i', { style: `width:${pct}%;background:${color}` })),
        h('span', { class: 'muted' }, `${Math.round(tl.durability)}/${tl.max}`),
      );
    }),
  );
}

/** Compact "2× icon name" list for an item bag (recipes, trades, banners). */
export function bagChips(bag: Record<string, number> | undefined): HTMLElement[] {
  return Object.entries(bag ?? {})
    .filter(([, n]) => n > 0)
    .map(([code, n]) => h('span', { class: 'chip', title: store.itemName(code) }, itemIcon(code, store.itemName(code)), n > 1 ? h('b', {}, `${n}`) : null));
}

/** "2 legna, 1 coltello" for a bag of goods. */
export function bagText(bag: Record<string, number>): string {
  return Object.entries(bag ?? {})
    .filter(([, n]) => n > 0)
    .map(([code, n]) => `${n} ${store.itemName(code).toLowerCase()}`)
    .join(', ');
}
