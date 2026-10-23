import { getPref, setPref } from './prefs';

/** A closable overlay panel with a remembered open/closed state and a keyboard shortcut. */
export interface PanelDef {
  id: string;
  key: string;
  defaultOpen: boolean;
  el: HTMLElement;
  onOpen?: () => void;
  /** Panels sharing a slot: opening one closes the others in the same slot. */
  slot?: string;
}

type Listener = (id: string, open: boolean) => void;

class PanelRegistry {
  private panels = new Map<string, PanelDef>();
  private listeners: Listener[] = [];

  register(def: PanelDef): void {
    this.panels.set(def.id, def);
    // restore the remembered state silently: components render themselves once data arrives
    const slotTaken = !!def.slot && [...this.panels.values()].some((o) => o !== def && o.slot === def.slot && this.isOpen(o.id));
    def.el.classList.toggle('hidden', slotTaken || !getPref(`panel.${def.id}`, def.defaultOpen));
  }

  isOpen(id: string): boolean {
    const p = this.panels.get(id);
    return !!p && !p.el.classList.contains('hidden');
  }

  set(id: string, open: boolean, remember = true): void {
    const p = this.panels.get(id);
    if (!p) return;
    p.el.classList.toggle('hidden', !open);
    if (remember) setPref(`panel.${id}`, open);
    if (open && p.slot) for (const o of this.panels.values()) if (o !== p && o.slot === p.slot && this.isOpen(o.id)) this.set(o.id, false, remember);
    if (open) p.onOpen?.();
    this.listeners.forEach((l) => l(id, open));
  }

  toggle(id: string): void {
    this.set(id, !this.isOpen(id));
  }

  byKey(key: string): PanelDef | undefined {
    for (const p of this.panels.values()) if (p.key === key) return p;
    return undefined;
  }

  onChange(l: Listener): void {
    this.listeners.push(l);
  }

  all(): PanelDef[] {
    return [...this.panels.values()];
  }
}

export const panels = new PanelRegistry();
