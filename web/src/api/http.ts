import { config } from '../config';
import type { OkResult, RosterEntry, RosterInfo, RuleMode, RuleWriteResult, Scenario, ServerEvent } from '../types';
import type { ConnState, Transport } from './transport';

const url = (p: string) => `${config.apiBase}/api${p}`;

async function post<T = unknown>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(url(path), {
    method,
    headers: { 'content-type': 'application/json', ...(config.apiToken ? { authorization: `Bearer ${config.apiToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { ok: false, error: text };
  }
  if (!res.ok) {
    const err = (data as { error?: string }).error || `${res.status} ${res.statusText}`;
    return { ok: false, error: err } as T;
  }
  return data as T;
}

export class HttpTransport implements Transport {
  readonly kind = 'http' as const;

  connect(onEvent: (e: ServerEvent) => void, onState: (s: ConnState) => void) {
    let es: EventSource | null = null;
    let closed = false;
    let gotData = false;
    const open = () => {
      onState(gotData ? 'reconnecting' : 'connecting');
      es = new EventSource(url('/stream'));
      es.onmessage = (m) => {
        try {
          const ev = JSON.parse(m.data) as ServerEvent;
          if (ev.type === 'snapshot') {
            gotData = true;
            onState('live');
          }
          onEvent(ev);
        } catch {
          /* ignore malformed frame */
        }
      };
      es.onerror = () => {
        if (closed) return;
        onState(gotData ? 'reconnecting' : 'offline');
        // EventSource auto-retries; nothing else to do.
      };
    };
    open();
    return () => {
      closed = true;
      es?.close();
    };
  }

  async start() { await post('/sim/start'); }
  async pause() { await post('/sim/pause'); }
  async reset(seed?: number) { await post('/sim/reset', seed === undefined ? {} : { seed }); }
  async speed(tickMs: number) { await post('/sim/speed', { tickMs }); }

  async scenarios(): Promise<Scenario[]> {
    const res = await fetch(url('/scenarios'));
    if (!res.ok) return [];
    return res.json();
  }

  applyScenario(name: string) {
    return post<RuleWriteResult>(`/scenarios/${encodeURIComponent(name)}/apply`);
  }

  writeRule(key: string, value: number, mode: RuleMode, message: string) {
    return post<RuleWriteResult>('/rules', { key, value, mode, message });
  }

  async roster(): Promise<RosterInfo> {
    const res = await fetch(url('/roster'));
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  setRoster(agents: RosterEntry[]) {
    return post<OkResult>('/roster', { agents }, 'PUT');
  }

  spawnAgent(entry: RosterEntry) {
    return post<OkResult>('/agents', entry);
  }

  removeAgent(id: string) {
    return post<OkResult>(`/agents/${encodeURIComponent(id)}`, undefined, 'DELETE');
  }
}
