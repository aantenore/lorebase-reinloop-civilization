// Runtime configuration. Everything is overridable via env (VITE_*) or URL query.
const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');

export const config = {
  /** Base for API calls. Empty = same origin (dev proxy handles /api). */
  apiBase: (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') || '',
  /** Optional shared API token (server `SIM_API_TOKEN`): `?token=` wins over `VITE_SIM_TOKEN`. Never hardcoded. */
  apiToken: params.get('token') || (import.meta.env.VITE_SIM_TOKEN as string | undefined) || '',
  /** Force mock stream. */
  mock: params.get('mock') === '1',
  /** Never fall back to mock even if backend unreachable. */
  live: params.get('live') === '1',
  /** Milliseconds to wait for the first snapshot before falling back to mock. */
  connectTimeoutMs: Number(import.meta.env.VITE_CONNECT_TIMEOUT_MS || 3500),
  /** Max items kept in the feed / per-agent timeline. */
  feedLimit: 400,
  timelineLimit: 80,
  /** Speech bubble lifetime on the map. */
  bubbleMs: 4200,
  /** Max simultaneous speech bubbles drawn on the map. */
  maxBubbles: 3,
  /** Rule-change banner lifetime. */
  bannerMs: 9000,
  /** Speed slider bounds (tick duration). */
  minTickMs: 250,
  maxTickMs: 6000,
  /** Pending rule writes revert with an error if Lorebase does not confirm in time. */
  pendingTimeoutMs: Number(import.meta.env.VITE_PENDING_TIMEOUT_MS || 30000),
  /** Map rendering: berry flecks appear only above this share of the richest tile, up to N per tile. */
  map: { berryMinShare: 0.35, berryMaxDots: 3 },
  /** Default panel sizes (px) and drag bounds; user changes are remembered per browser. */
  layout: {
    storageKey: 'civ.ui.v1',
    lawsW: 290,
    rosterW: 310,
    lowerH: 230,
    bounds: { lawsW: [220, 520], rosterW: [240, 560], lowerH: [140, 480] } as Record<'lawsW' | 'rosterW' | 'lowerH', [number, number]>,
  },
};
