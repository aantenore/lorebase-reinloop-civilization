/** Runtime configuration. Everything comes from Vite env vars or the URL; no endpoints are hardcoded elsewhere. */
const env = import.meta.env;
const params = new URLSearchParams(location.search);

function wsUrl(): string {
  if (env.VITE_WS_URL) return String(env.VITE_WS_URL);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${env.VITE_WS_PATH || '/ws'}`;
}

/** Optional shared token (server `SIM_API_TOKEN`): `?token=` wins over `VITE_SIM_TOKEN`. Never hardcoded. */
const apiToken = params.get('token') || String(env.VITE_SIM_TOKEN ?? '');

export const config = {
  wsUrl: wsUrl(),
  apiToken,
  apiBase: String(env.VITE_API_BASE || '/api').replace(/\/$/, ''),
  /** `?mock=1` forces the in-browser simulated world. */
  forceMock: params.get('mock') === '1',
  /** Fall back to the mock world when the socket cannot open. */
  mockFallback: (env.VITE_MOCK_FALLBACK ?? '1') !== '0' && params.get('mock') !== '0',
  /** ms to wait for the first socket open before falling back. */
  connectTimeoutMs: 2500,
  /** Pre-fill join name from `?name=` (handy for demos). */
  presetName: params.get('name') ?? '',
  /** Auto-join without the join screen when `?autojoin=1`. */
  autoJoin: params.get('autojoin') === '1',
  /** Interpolation delay behind the newest state frame (ms). */
  interpDelayMs: 120,
  /** Distance (tiles) under which E/Space talks to an agent. */
  talkRange: 1.8,
  defaultRoles: ['gatherer', 'woodcutter', 'builder', 'healer', 'scout', 'elder'],
  zoom: { min: 1, max: 5, initial: 3, step: 0.5 },
  render: {
    /** Share of forest tiles drawn as trees; the rest is low undergrowth (display only, server data unchanged). */
    forestTreeShare: 0.42,
    /** Share of tree tiles that get a second tree. */
    forestPairShare: 0.25,
    /** Alpha of a tree/hut hiding any inhabitant, and one hiding you or the selected one. */
    occluderAlpha: 0.5,
    occluderAlphaFocus: 0.28,
    /** Opacity of the silhouette drawn over occluders for hidden inhabitants. */
    silhouetteAlpha: 0.55,
  },
  /** Lorebase web UI (link target from god mode). */
  lorebaseUi: {
    base: String(env.VITE_LOREBASE_UI_URL || 'http://localhost:5180').replace(/\/$/, ''),
    explorerPath: '/world/explorer',
    /** Review list of the Domain (`/<domain>/review`); a law proposal opens at `<reviewPath>/<proposal id>`. */
    reviewPath: String(env.VITE_LOREBASE_REVIEW_PATH || '/world/review').replace(/\/$/, ''),
  },
  society: {
    /** Esteem change (0-1 scale) that earns a floating "esteem up/down" label. */
    esteemFloatDelta: 0.05,
    /** How many top-ranked people get the laurel pip on the map. */
    laurelTop: 3,
    /** Pending barter offer bubble lifetime (ms), and how long resolved offers stay in the inspector. */
    offerBubbleMs: 6000,
    offerKeepMs: 30000,
  },
  god: {
    /** How long a law edit waits for `rules_changed` before it is reported as failed (ms). */
    pendingTimeoutMs: 20000,
    /** Conversation lines fetched per query and kept on screen. */
    conversationLimit: 200,
    /** Observatory auto-refresh while visible (ms). */
    observatoryRefreshMs: 10000,
    observatoryLogLimit: 15,
    /** Thoughts and consults kept in the mind view. */
    mindItemsKept: 20,
  },
  minds: {
    /** Lorebase consult bubble lifetime (ms) and how many consults the inspector keeps per agent. */
    consultBubbleMs: 4200,
    consultsKept: 12,
    /** Discovery banner lifetime (ms). */
    discoveryBannerMs: 6500,
  },
};
