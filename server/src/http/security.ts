// Request guards for the local API: the server spends paid model credits, so state-changing
// requests must come from an allowed origin, as JSON, and (when SIM_API_TOKEN is set) with
// the shared token. Pure helpers, used by the HTTP routes and the WebSocket upgrade.
import { timingSafeEqual } from 'node:crypto';

export interface GuardConfig {
  port: number;
  corsOrigins: string[];
  apiToken?: string;
  /** Extra Host header values accepted besides localhost/127.0.0.1 on `port` and the CORS origins' hosts. */
  allowedHosts?: string[];
}

/** Host header allowlist (blocks DNS rebinding): the server's own loopback names and the configured origins. */
export function hostAllowed(host: string | undefined, cfg: GuardConfig): boolean {
  if (!host) return false;
  const ok = new Set([`localhost:${cfg.port}`, `127.0.0.1:${cfg.port}`, `[::1]:${cfg.port}`, ...(cfg.allowedHosts ?? [])]);
  for (const o of cfg.corsOrigins) {
    try {
      ok.add(new URL(o).host);
    } catch {
      // not a URL: ignore
    }
  }
  return ok.has(host.toLowerCase());
}

export interface RequestLike {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface Refusal {
  status: number;
  error: string;
}

const header = (req: RequestLike, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Configured origins plus the server's own origin (UI served from the same port). */
export function allowedOrigins(cfg: GuardConfig): string[] {
  return [...new Set([...cfg.corsOrigins, `http://localhost:${cfg.port}`, `http://127.0.0.1:${cfg.port}`])];
}

/** A request without Origin (curl, scripts) passes; a browser request must come from an allowed origin. */
export function originAllowed(origin: string | undefined, cfg: GuardConfig): boolean {
  return origin === undefined || allowedOrigins(cfg).includes(origin);
}

export function tokenMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearer(req: RequestLike): string | undefined {
  const auth = header(req, 'authorization');
  const m = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null;
  return m?.[1];
}

export const isMutation = (method: string | undefined) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes((method ?? 'GET').toUpperCase());

/**
 * Guards a state-changing API request: allowed Origin (blocks cross-site forms), JSON body
 * (blocks text/plain and form posts), bearer token when configured.
 */
export function checkMutation(req: RequestLike, cfg: GuardConfig): Refusal | undefined {
  if (!originAllowed(header(req, 'origin'), cfg)) return { status: 403, error: 'origin not allowed' };
  const type = (header(req, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return { status: 415, error: 'Content-Type must be application/json' };
  if (!tokenMatches(bearer(req), cfg.apiToken)) return { status: 401, error: 'missing or invalid token' };
  return undefined;
}
