/** Runtime configuration. Everything comes from Vite env vars or the URL; no endpoints are hardcoded elsewhere. */
const env = import.meta.env;
const params = new URLSearchParams(location.search);

function wsUrl(): string {
  if (env.VITE_WS_URL) return String(env.VITE_WS_URL);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${env.VITE_WS_PATH || '/ws'}`;
}

export const config = {
  wsUrl: wsUrl(),
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
};
