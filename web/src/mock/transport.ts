import { t } from '../i18n';
import type { ConnState, Transport } from '../api/transport';
import type { RosterEntry, RuleMode, Scenario, ServerEvent } from '../types';
import { MOCK_MODELS, MOCK_ROLES, MockEngine } from './engine';

const SCENARIOS: Scenario[] = [
  {
    name: 'long_winter',
    title: t.mock.scenarios.long_winter.title,
    description: t.mock.scenarios.long_winter.description,
    changes: [
      { key: 'winter_food_yield_multiplier', value: 0.2 },
      { key: 'cold_damage_per_tick', value: 9 },
    ],
  },
  {
    name: 'golden_age',
    title: t.mock.scenarios.golden_age.title,
    description: t.mock.scenarios.golden_age.description,
    changes: [
      { key: 'gather_food_yield', value: 6 },
      { key: 'shelter_wood_cost', value: 3 },
      { key: 'birth_food_threshold', value: 14 },
    ],
  },
  {
    name: 'famine',
    title: t.mock.scenarios.famine.title,
    description: t.mock.scenarios.famine.description,
    changes: [
      { key: 'gather_food_yield', value: 1 },
      { key: 'hunger_per_tick', value: 12 },
    ],
  },
];

const tick = () => new Promise((r) => setTimeout(r, 120));

/** Transport backed by the in-browser MockEngine. Same contract as the HTTP backend. */
export class MockTransport implements Transport {
  readonly kind = 'mock' as const;
  private engine = new MockEngine(7);

  connect(onEvent: (e: ServerEvent) => void, onState: (s: ConnState) => void) {
    onState('mock');
    this.engine.attach(onEvent);
    return () => this.engine.detach();
  }
  async start() { this.engine.start(); }
  async pause() { this.engine.pause(); }
  async reset(seed?: number) { this.engine.reset(seed); }
  async speed(ms: number) { this.engine.speed(ms); }
  async scenarios() { return SCENARIOS; }
  async applyScenario(name: string) {
    const s = SCENARIOS.find((x) => x.name === name);
    if (!s) return { ok: false, error: t.mock.errors.unknownScenario(name) };
    await tick();
    return this.engine.writeRules(s.changes, 'proposal', s.title);
  }
  async writeRule(key: string, value: number, mode: RuleMode, message: string) {
    await tick();
    if (!Number.isFinite(value)) return { ok: false, error: t.mock.errors.notNumber };
    return this.engine.writeRules([{ key, value }], mode, message || key);
  }
  async roster() {
    return { agents: this.engine.getRoster(), models: MOCK_MODELS, roles: MOCK_ROLES };
  }
  async setRoster(agents: RosterEntry[]) {
    await tick();
    return this.engine.setRoster(agents);
  }
  async spawnAgent(entry: RosterEntry) {
    await tick();
    return this.engine.spawn(entry);
  }
  async removeAgent(id: string) {
    await tick();
    return this.engine.remove(id);
  }
}
