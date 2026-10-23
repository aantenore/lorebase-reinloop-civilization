import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { config } from '../config';

// Per-viewer layout preferences (collapsed panels, sizes, focus mode), remembered in localStorage.

export type PanelId = 'laws' | 'roster' | 'feed' | 'vitals' | 'tiers';

export interface UiPrefs {
  collapsed: Record<PanelId, boolean>;
  lawsW: number;
  rosterW: number;
  lowerH: number;
  focus: boolean;
}

const DEFAULTS: UiPrefs = {
  collapsed: { laws: false, roster: false, feed: false, vitals: false, tiers: false },
  lawsW: config.layout.lawsW,
  rosterW: config.layout.rosterW,
  lowerH: config.layout.lowerH,
  focus: false,
};

function load(): UiPrefs {
  try {
    const raw = window.localStorage.getItem(config.layout.storageKey);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<UiPrefs>;
    return { ...DEFAULTS, ...p, collapsed: { ...DEFAULTS.collapsed, ...(p.collapsed ?? {}) } };
  } catch {
    return DEFAULTS;
  }
}

function save(p: UiPrefs) {
  try {
    window.localStorage.setItem(config.layout.storageKey, JSON.stringify(p));
  } catch {
    /* storage unavailable: prefs stay in memory */
  }
}

interface Ctx {
  prefs: UiPrefs;
  toggle(id: PanelId): void;
  setSize(k: 'lawsW' | 'rosterW' | 'lowerH', v: number): void;
  setFocus(on: boolean): void;
}

const UiContext = createContext<Ctx | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<UiPrefs>(load);
  useEffect(() => save(prefs), [prefs]);

  const toggle = useCallback((id: PanelId) => setPrefs((p) => ({ ...p, collapsed: { ...p.collapsed, [id]: !p.collapsed[id] } })), []);
  const setSize = useCallback((k: 'lawsW' | 'rosterW' | 'lowerH', v: number) => {
    const [min, max] = config.layout.bounds[k];
    setPrefs((p) => ({ ...p, [k]: Math.round(Math.max(min, Math.min(max, v))) }));
  }, []);
  const setFocus = useCallback((on: boolean) => setPrefs((p) => ({ ...p, focus: on })), []);

  // M toggles focus mode (ignored while typing), Escape leaves it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'm' || e.key === 'M') setPrefs((p) => ({ ...p, focus: !p.focus }));
      else if (e.key === 'Escape') setPrefs((p) => (p.focus ? { ...p, focus: false } : p));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const value = useMemo(() => ({ prefs, toggle, setSize, setFocus }), [prefs, toggle, setSize, setFocus]);
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi() {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error('useUi outside UiProvider');
  return ctx;
}
