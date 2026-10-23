import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { config } from '../config';
import { HttpTransport } from '../api/http';
import type { Transport } from '../api/transport';
import { MockTransport } from '../mock/transport';
import type { OkResult, RosterEntry, RosterInfo, RuleMode, RuleWriteResult, Scenario } from '../types';
import { initialState, reducer, type Action, type State } from './reducer';

export interface SimActions {
  start(): void;
  pause(): void;
  reset(seed?: number): void;
  speed(tickMs: number): void;
  writeRule(key: string, value: number, mode: RuleMode, message: string): Promise<RuleWriteResult>;
  applyScenario(s: Scenario): Promise<RuleWriteResult>;
  scenarios(): Promise<Scenario[]>;
  roster(): Promise<RosterInfo>;
  setRoster(agents: RosterEntry[]): Promise<OkResult>;
  spawnAgent(e: RosterEntry): Promise<OkResult>;
  removeAgent(id: string): Promise<OkResult>;
  dismissBanner(): void;
}

interface Ctx {
  state: State;
  dispatch: React.Dispatch<Action>;
  actions: SimActions;
  transportKind: Transport['kind'];
  /** UI-local selection (focused agent). */
  focusId: string | null;
  setFocus(id: string | null): void;
}

const SimContext = createContext<Ctx | null>(null);

function initialTransport(): Transport {
  return config.mock ? new MockTransport() : new HttpTransport();
}

const safe = async <T,>(p: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await p;
  } catch (e) {
    return { ...(fallback as object), error: e instanceof Error ? e.message : String(e) } as T;
  }
};

export function SimProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [transport, setTransport] = useState<Transport>(initialTransport);
  const [focusId, setFocus] = useState<string | null>(null);
  const gotSnapshot = useRef(false);

  // connect + fallback to mock when the backend never answers
  useEffect(() => {
    gotSnapshot.current = false;
    const stop = transport.connect(
      (ev) => {
        if (ev.type === 'snapshot') gotSnapshot.current = true;
        dispatch({ type: 'event', ev });
      },
      (st) => dispatch({ type: 'conn', state: st }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (transport.kind === 'http' && !config.live) {
      timer = setTimeout(() => {
        if (!gotSnapshot.current) {
          console.info('[civ] backend unreachable, switching to mock stream');
          setTransport(new MockTransport());
        }
      }, config.connectTimeoutMs);
    }
    return () => {
      stop();
      if (timer) clearTimeout(timer);
    };
  }, [transport]);

  // expire bubbles / banner
  useEffect(() => {
    const t = setInterval(() => dispatch({ type: 'gc', now: Date.now() }), 500);
    return () => clearInterval(t);
  }, []);

  const writeRule = useCallback(
    async (key: string, value: number, mode: RuleMode, message: string) => {
      dispatch({ type: 'pending', key, pending: { value, mode, since: Date.now() } });
      const res = await safe(transport.writeRule(key, value, mode, message), { ok: false } as RuleWriteResult);
      if (!res.ok) dispatch({ type: 'pending', key, pending: null });
      else if (res.proposalId) dispatch({ type: 'pending', key, pending: { value, mode, since: Date.now(), proposalId: res.proposalId } });
      return res;
    },
    [transport],
  );

  const applyScenario = useCallback(
    async (s: Scenario) => {
      for (const c of s.changes) dispatch({ type: 'pending', key: c.key, pending: { value: c.value, mode: 'proposal', since: Date.now() } });
      const res = await safe(transport.applyScenario(s.name), { ok: false } as RuleWriteResult);
      if (!res.ok) for (const c of s.changes) dispatch({ type: 'pending', key: c.key, pending: null });
      return res;
    },
    [transport],
  );

  const actions = useMemo<SimActions>(
    () => ({
      start: () => void transport.start().catch(() => {}),
      pause: () => void transport.pause().catch(() => {}),
      reset: (seed) => void transport.reset(seed).catch(() => {}),
      speed: (ms) => void transport.speed(ms).catch(() => {}),
      writeRule,
      applyScenario,
      scenarios: () => transport.scenarios().catch(() => []),
      roster: () => transport.roster(),
      setRoster: (agents) => safe(transport.setRoster(agents), { ok: false }),
      spawnAgent: (e) => safe(transport.spawnAgent(e), { ok: false }),
      removeAgent: (id) => safe(transport.removeAgent(id), { ok: false }),
      dismissBanner: () => dispatch({ type: 'dismiss_banner' }),
    }),
    [transport, writeRule, applyScenario],
  );

  const value = useMemo<Ctx>(
    () => ({ state, dispatch, actions, transportKind: transport.kind, focusId, setFocus }),
    [state, actions, transport.kind, focusId],
  );
  return <SimContext.Provider value={value}>{children}</SimContext.Provider>;
}

export function useSim() {
  const ctx = useContext(SimContext);
  if (!ctx) throw new Error('useSim outside SimProvider');
  return ctx;
}
