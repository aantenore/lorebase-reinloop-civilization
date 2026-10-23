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
