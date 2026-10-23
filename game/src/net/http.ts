import { config } from '../config';

/** Authorization header for the optional shared token. */
export function authHeaders(): Record<string, string> {
  return config.apiToken ? { authorization: `Bearer ${config.apiToken}` } : {};
}

/** WebSocket URL with the token appended as `?token=` when configured. */
export function withToken(url: string): string {
  if (!config.apiToken) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(config.apiToken)}`;
}

/** GET a JSON resource under the API base. Rejects on network or HTTP errors. */
export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${config.apiBase}${path}`, { headers: { accept: 'application/json', ...authHeaders() } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** JSON request with a body under the API base. Rejects with `status message` on HTTP errors. */
export async function requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${config.apiBase}${path}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200) || res.statusText}`);
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    return {} as T;
  }
}
