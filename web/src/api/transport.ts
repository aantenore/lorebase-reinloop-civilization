import type { OkResult, RosterEntry, RosterInfo, RuleMode, RuleWriteResult, Scenario, ServerEvent } from '../types';

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'mock' | 'offline';

/** A source of world events + the control surface. Implemented by HTTP backend and the in-browser mock. */
export interface Transport {
  readonly kind: 'http' | 'mock';
  connect(onEvent: (e: ServerEvent) => void, onState: (s: ConnState) => void): () => void;
  start(): Promise<void>;
  pause(): Promise<void>;
  reset(seed?: number): Promise<void>;
  speed(tickMs: number): Promise<void>;
  scenarios(): Promise<Scenario[]>;
  applyScenario(name: string): Promise<RuleWriteResult>;
  writeRule(key: string, value: number, mode: RuleMode, message: string): Promise<RuleWriteResult>;
  roster(): Promise<RosterInfo>;
  setRoster(agents: RosterEntry[]): Promise<OkResult>;
  spawnAgent(entry: RosterEntry): Promise<OkResult>;
  removeAgent(id: string): Promise<OkResult>;
}
