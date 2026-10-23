import type {
  Agent,
  Biome,
  RosterEntry,
  Rule,
  RuleChange,
  Season,
  ServerEvent,
  SimStatus,
  Stats,
  Tier,
  Tile,
} from '../types';
import { TIERS } from '../types';
import { roleLabel, t } from '../i18n';
import { CHILD_NAMES, NAMES, SEASONS, messageFor, pick, thoughtFor } from './text';

// In-browser simulation that speaks the exact backend event contract.
// Deterministic per seed; timing is driven by setTimeout.

const W = 34;
const H = 22;

export const DEFAULT_RULES: Rule[] = [
  { key: 'gather_food_yield', value: 3, unit: t.mock.units.gather_food_yield, category: 'economy', text: t.mock.rules.gather_food_yield },
  { key: 'winter_food_yield_multiplier', value: 1, unit: t.mock.units.winter_food_yield_multiplier, category: 'climate', text: t.mock.rules.winter_food_yield_multiplier },
  { key: 'cold_damage_per_tick', value: 4, unit: t.mock.units.cold_damage_per_tick, category: 'climate', text: t.mock.rules.cold_damage_per_tick },
  { key: 'season_length_ticks', value: 10, unit: t.mock.units.season_length_ticks, category: 'climate', text: t.mock.rules.season_length_ticks },
  { key: 'hunger_per_tick', value: 6, unit: t.mock.units.hunger_per_tick, category: 'survival', text: t.mock.rules.hunger_per_tick },
  { key: 'starvation_damage', value: 8, unit: t.mock.units.starvation_damage, category: 'survival', text: t.mock.rules.starvation_damage },
  { key: 'shelter_wood_cost', value: 6, unit: t.mock.units.shelter_wood_cost, category: 'society', text: t.mock.rules.shelter_wood_cost },
  { key: 'birth_food_threshold', value: 24, unit: t.mock.units.birth_food_threshold, category: 'society', text: t.mock.rules.birth_food_threshold },
  { key: 'forest_regrowth_rate', value: 0.25, unit: t.mock.units.forest_regrowth_rate, category: 'economy', text: t.mock.rules.forest_regrowth_rate },
];

const SCRIPTED_CHANGE_TICK = 26;

export const MOCK_MODELS: Record<Tier, string> = { opus: 'claude-opus', sonnet: 'claude-sonnet', haiku: 'claude-haiku' };
export const MOCK_ROLES = ['gatherer', 'builder', 'explorer', 'elder', 'healer'];
const DEFAULT_ROSTER: RosterEntry[] = NAMES.map((n, i) => ({ id: `a${i + 1}`, name: n.name, role: n.role, tier: n.tier }));

type Emit = (e: ServerEvent) => void;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex(r: () => number, n = 7) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(r() * 16).toString(16);
  return s;
}

export class MockEngine {
  private rnd = mulberry32(1);
  private tiles: Tile[] = [];
  private agents: Agent[] = [];
  private rules: Rule[] = [];
  private history: Stats[] = [];
  private tick = 0;
  private running = true;
  private tickMs = 1800;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private loop: ReturnType<typeof setTimeout> | null = null;
  private revision = 'a1b2c3d';
  private branch = 'main';
  private stock = { food: 0, wood: 0 };
  private childIdx = 0;
  private emit: Emit = () => {};
  private roster: RosterEntry[] = DEFAULT_ROSTER.map((r) => ({ ...r }));
  private spawnIdx = 0;
  private thinkSeq: Record<string, number> = {};

  constructor(private seed = 7) {}

  attach(emit: Emit) {
    this.emit = emit;
    this.init(this.seed);
    this.emit(this.snapshot());
    this.schedule();
  }

  detach() {
    this.clearTimers();
    this.emit = () => {};
  }

  // ---- controls ---------------------------------------------------------
  start() {
    this.running = true;
    this.emitStatus();
    this.schedule();
  }
  pause() {
    this.running = false;
    if (this.loop) clearTimeout(this.loop);
    this.loop = null;
    this.emitStatus();
  }
  reset(seed?: number) {
    this.clearTimers();
    this.init(seed ?? Math.floor(Math.random() * 1e6));
    this.emit(this.snapshot());
    this.schedule();
  }
  getRoster(): RosterEntry[] {
    return this.roster.map((r) => ({ ...r }));
  }

  setRoster(entries: RosterEntry[]) {
    const err = validateRoster(entries);
    if (err) return { ok: false, error: err };
    this.roster = entries.map((e, i) => ({ ...e, id: e.id || `a${i + 1}` }));
    this.reset(this.seed);
    return { ok: true };
  }

  spawn(entry: RosterEntry) {
    const alive = this.agents.filter((a) => a.alive);
    if (alive.length >= 16) return { ok: false, error: t.mock.errors.full };
    if (this.agents.some((a) => a.alive && a.name.toLowerCase() === entry.name.trim().toLowerCase())) return { ok: false, error: t.mock.errors.nameTaken };
    const anchor = alive[0] ?? { x: Math.floor(W / 2), y: Math.floor(H / 2) };
    const a = this.makeAgent(`s${++this.spawnIdx}`, entry.name.trim(), entry.role, entry.tier, entry.model || MOCK_MODELS[entry.tier], anchor.x + 1, anchor.y, 1);
    this.agents.push(a);
    this.roster.push({ ...entry, id: a.id });
    this.emit({ type: 'agent_update', agent: { ...a, inventory: { ...a.inventory } } });
    this.emit({ type: 'world_event', tick: this.tick, kind: 'birth', text: t.mock.events.joins(a.name, roleLabel(a.role).toLowerCase(), a.tier ?? '') });
    return { ok: true };
  }

  remove(id: string) {
    const a = this.agents.find((x) => x.id === id);
    if (!a) return { ok: false, error: t.mock.errors.unknownAgent };
    this.agents = this.agents.filter((x) => x.id !== id);
    this.roster = this.roster.filter((x) => x.id !== id);
    this.emit(this.snapshot());
    this.emit({ type: 'world_event', tick: this.tick, kind: 'death', text: t.mock.events.leaves(a.name) });
    return { ok: true };
  }

  speed(ms: number) {
    this.tickMs = ms;
    this.emitStatus();
    this.schedule();
  }

  writeRules(changes: { key: string; value: number }[], mode: 'direct' | 'proposal', label: string) {
    const rev = hex(this.rnd);
    const proposalId = mode === 'proposal' ? `prop-${hex(this.rnd, 5)}` : undefined;
    if (mode === 'proposal') {
      // branch → review → merge
      this.branch = `proposal/${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) || 'change'}`;
      this.emitStatus();
      this.later(1400, () => {
        this.branch = 'main';
        this.commit(changes, rev);
      });
    } else {
      this.later(550, () => this.commit(changes, rev));
    }
    return { ok: true, revision: mode === 'direct' ? rev : undefined, proposalId };
  }

  // ---- internals --------------------------------------------------------
  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private clearTimers() {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    if (this.loop) clearTimeout(this.loop);
    this.loop = null;
  }

  private schedule() {
    if (this.loop) clearTimeout(this.loop);
    this.loop = null;
    if (!this.running) return;
    this.loop = setTimeout(() => {
      this.step();
      this.schedule();
    }, this.tickMs);
  }

  private rule(key: string) {
    return this.rules.find((r) => r.key === key)?.value ?? 0;
  }

  private season(t = this.tick): Season {
    const len = Math.max(1, this.rule('season_length_ticks'));
    return SEASONS[Math.floor(t / len) % 4];
  }

  private tileAt(x: number, y: number) {
    return this.tiles[y * W + x];
  }

  private init(seed: number) {
    this.seed = seed;
    this.rnd = mulberry32(seed);
    this.tick = 0;
    this.history = [];
    this.childIdx = 0;
    this.stock = { food: 10, wood: 4 };
    this.rules = DEFAULT_RULES.map((r) => ({ ...r }));
    this.revision = hex(this.rnd);
    this.branch = 'main';
    // biomes from a few blob centers
    const blobs: { x: number; y: number; b: Biome; r: number }[] = [];
    const kinds: Biome[] = ['forest', 'forest', 'forest', 'water', 'water', 'rock', 'rock', 'forest'];
    for (const b of kinds) blobs.push({ x: this.rnd() * W, y: this.rnd() * H, b, r: 2.5 + this.rnd() * 4 });
    blobs.push({ x: W * 0.15, y: H * 0.5, b: 'water', r: 3 });
    this.tiles = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let biome: Biome = 'grass';
        let best = Infinity;
        for (const bl of blobs) {
          const d = Math.hypot(x - bl.x, y - bl.y) / bl.r + (this.rnd() - 0.5) * 0.35;
          if (d < 1 && d < best) {
            best = d;
            biome = bl.b;
          }
        }
        const food = biome === 'grass' ? Math.round(2 + this.rnd() * 8) : biome === 'forest' ? Math.round(this.rnd() * 5) : 0;
        const wood = biome === 'forest' ? Math.round(5 + this.rnd() * 10) : 0;
        this.tiles.push({ x, y, biome, food, wood, shelter: false });
      }
    const cx = Math.floor(W / 2);
    const cy = Math.floor(H / 2);
    const home = this.tileAt(cx, cy);
    home.biome = 'grass';
    home.shelter = true;
    this.agents = this.roster.map((n, i) =>
      this.makeAgent(n.id || `a${i + 1}`, n.name, n.role, n.tier, n.model || MOCK_MODELS[n.tier], cx + ((i % 4) - 1) * 2, cy + Math.floor(i / 4) - 1, 1),
    );
  }

  private makeAgent(id: string, name: string, role: string, tier: Tier, model: string, x: number, y: number, generation: number): Agent {
    x = Math.max(0, Math.min(W - 1, x));
    y = Math.max(0, Math.min(H - 1, y));
    const t = this.tileAt(x, y);
    if (t.biome === 'water' || t.biome === 'rock') t.biome = 'grass';
    return {
      id, name, role, x, y, hp: 100, maxHp: 100, hunger: Math.round(this.rnd() * 30),
      inventory: { food: 2, wood: 0 }, alive: true, sheltered: false, status: 'idle',
      thought: '', lastAction: null, generation, model, tier,
    };
  }

  private status(): SimStatus {
    return {
      running: this.running,
      tick: this.tick,
      tickMs: this.tickMs,
      provider: 'mock',
      model: t.mock.model,
      lorebase: { connected: true, url: 'mock://lorebase', domain: 'civilization', branch: this.branch, revision: this.revision },
    };
  }

  private emitStatus() {
    this.emit({ type: 'status', status: this.status() });
  }

  private stats(): Stats {
    const alive = this.agents.filter((a) => a.alive);
    const byTier: Stats['byTier'] = {};
    for (const t of TIERS) {
      const g = alive.filter((a) => a.tier === t);
      byTier[t] = { alive: g.length, avgHp: g.length ? Math.round(g.reduce((s, a) => s + a.hp, 0) / g.length) : 0 };
    }
    return {
      tick: this.tick,
      population: alive.length,
      food: Math.round(this.stock.food + alive.reduce((s, a) => s + a.inventory.food, 0)),
      wood: Math.round(this.stock.wood + alive.reduce((s, a) => s + a.inventory.wood, 0)),
      shelters: this.tiles.filter((t) => t.shelter).length,
      avgHp: alive.length ? Math.round(alive.reduce((s, a) => s + a.hp, 0) / alive.length) : 0,
      byTier,
    };
  }

  private snapshot(): ServerEvent {
    // seed some history so the chart is not empty on first paint
    if (!this.history.length) this.history.push(this.stats());
    return {
      type: 'snapshot',
      tick: this.tick,
      season: this.season(),
      world: { w: W, h: H, tiles: this.tiles.map((tile) => ({ ...tile })) },
      agents: this.agents.map((a) => ({ ...a, inventory: { ...a.inventory } })),
      rules: this.rules.map((r) => ({ ...r })),
      history: [...this.history],
      status: this.status(),
      roster: this.getRoster(),
    };
  }

  private commit(changes: { key: string; value: number }[], rev: string) {
    const out: RuleChange[] = [];
    for (const c of changes) {
      const r = this.rules.find((x) => x.key === c.key);
      if (!r || r.value === c.value) continue;
      out.push({ key: r.key, old: r.value, new: c.value, text: r.text });
      r.value = c.value;
    }
    if (!out.length) return;
    this.revision = rev;
    this.emit({ type: 'rules_changed', revision: rev, source: 'lorebase', changes: out });
    this.emit({
      type: 'world_event',
      tick: this.tick,
      kind: 'rules',
      text: t.mock.events.lawsShift(rev, out.map((c) => `${c.key} ${c.old} → ${c.new}`).join(', ')),
    });
    this.emitStatus();
  }

  private step() {
    const prevSeason = this.season();
    this.tick++;
    const season = this.season();
    if (season !== prevSeason) {
      this.emit({ type: 'world_event', tick: this.tick, kind: 'season', text: season === 'winter' ? t.mock.events.winter : t.mock.events.seasonTurns(t.seasons[season].toLowerCase()) });
    }
    if (this.tick === SCRIPTED_CHANGE_TICK) {
      this.writeRules([{ key: 'winter_food_yield_multiplier', value: 0.2 }, { key: 'cold_damage_per_tick', value: 9 }], 'proposal', t.mock.scriptedBranch);
    }

    // forest regrowth
    const regrow = this.rule('forest_regrowth_rate');
    for (const t of this.tiles) {
      if (t.biome === 'forest' && t.wood < 15 && this.rnd() < regrow) {
        t.wood += 1;
        if (this.rnd() < 0.15) this.emit({ type: 'tile_update', x: t.x, y: t.y, food: t.food, wood: t.wood, shelter: t.shelter });
      }
      if (t.biome === 'grass' && season !== 'winter' && t.food < 10 && this.rnd() < 0.08) {
        t.food += 1;
        this.emit({ type: 'tile_update', x: t.x, y: t.y, food: t.food, wood: t.wood, shelter: t.shelter });
      }
    }

    const alive = this.agents.filter((a) => a.alive);
    const window = this.tickMs * 0.8;
    alive.forEach((a, i) => {
      const startAt = (window / (alive.length + 1)) * i * 0.6;
      this.later(startAt, () => this.think(a, window * 0.55));
    });

    this.later(Math.min(this.tickMs * 0.92, window + 200), () => this.resolveSurvival());
    const st = this.stats();
    this.history.push(st);
    this.emit({ type: 'tick', tick: this.tick, season, stats: st });
    this.emitStatus();
  }

  private think(a: Agent, budgetMs: number) {
    if (!a.alive) return;
    const tier = a.tier ?? 'sonnet';
    const others = this.agents.filter((o) => o.alive && o.id !== a.id);
    const vars = {
      n: Math.max(0, this.rule('season_length_ticks') * 3 - (this.tick % (this.rule('season_length_ticks') * 4))),
      food: this.stats().food,
      other: others.length ? pick(others, this.rnd()).name : 'someone',
      mult: this.rule('winter_food_yield_multiplier'),
      hp: Math.round(a.hp),
      season: t.seasons[this.season()].toLowerCase(),
    };
    const text = thoughtFor(tier, this.rnd(), vars);
    const seq = (this.thinkSeq[a.id] = (this.thinkSeq[a.id] ?? 0) + 1);
    const current = () => a.alive && this.thinkSeq[a.id] === seq;
    a.status = 'thinking';
    a.thought = '';
    this.emit({ type: 'agent_update', agent: { ...a, inventory: { ...a.inventory } } });
    const words = text.split(' ');
    const per = Math.max(18, budgetMs / words.length);
    words.forEach((w, i) => this.later(per * i, () => current() && this.emit({ type: 'agent_thought', agentId: a.id, delta: (i ? ' ' : '') + w })));
    this.later(per * words.length + 60, () => {
      if (!current()) return;
      a.thought = text;
      this.act(a);
    });
  }

  private act(a: Agent) {
    if (!a.alive) return;
    const tier = a.tier ?? 'sonnet';
    const season = this.season();
    const here = this.tileAt(a.x, a.y);
    const smart = tier === 'opus' ? 0.95 : tier === 'sonnet' ? 0.8 : 0.55;
    let tool = 'wait';
    let args: Record<string, unknown> = {};
    let result: unknown = 'ok';
    let ok = true;

    const wantsShelter = season === 'winter' && !here.shelter && this.rnd() < smart;
    if (a.hunger > 60 && a.inventory.food > 0) {
      tool = 'eat';
      const n = Math.min(a.inventory.food, 3);
      a.inventory.food -= n;
      a.hunger = Math.max(0, a.hunger - n * 18);
      result = { ate: n, hunger: a.hunger };
    } else if (wantsShelter) {
      const s = this.nearest(a, (t) => t.shelter);
      if (s) {
        tool = 'move';
        this.moveToward(a, s.x, s.y, 2);
        args = { to: [s.x, s.y] };
      }
    } else if ((a.role === 'builder' || this.rnd() < 0.1) && this.stock.wood + a.inventory.wood >= this.rule('shelter_wood_cost') && !here.shelter && here.biome === 'grass') {
      tool = 'build_shelter';
      let cost = this.rule('shelter_wood_cost');
      const fromInv = Math.min(a.inventory.wood, cost);
      a.inventory.wood -= fromInv;
      cost -= fromInv;
      this.stock.wood -= cost;
      here.shelter = true;
      this.emit({ type: 'tile_update', x: here.x, y: here.y, food: here.food, wood: here.wood, shelter: true });
      this.emit({ type: 'world_event', tick: this.tick, kind: 'build', text: t.mock.events.shelter(a.name, here.x, here.y) });
    } else if (a.role === 'builder' && here.wood > 0) {
      tool = 'chop';
      const n = Math.min(here.wood, 3);
      here.wood -= n;
      a.inventory.wood += n;
      result = { wood: n };
      this.emit({ type: 'tile_update', x: here.x, y: here.y, food: here.food, wood: here.wood, shelter: here.shelter });
    } else if (here.food > 0 && a.role !== 'explorer') {
      tool = 'gather';
      const mult = season === 'winter' ? this.rule('winter_food_yield_multiplier') : 1;
      const n = Math.min(here.food, Math.max(0, Math.round(this.rule('gather_food_yield') * mult * (0.6 + this.rnd() * 0.8))));
      here.food -= n;
      a.inventory.food += n;
      if (a.inventory.food > 6) {
        this.stock.food += a.inventory.food - 4;
        a.inventory.food = 4;
      }
      result = { food: n };
      ok = n > 0;
      this.emit({ type: 'tile_update', x: here.x, y: here.y, food: here.food, wood: here.wood, shelter: here.shelter });
    } else if (a.role === 'healer') {
      const hurt = this.agents.filter((o) => o.alive && o.id !== a.id && o.hp < o.maxHp * 0.6).sort((p, q) => p.hp - q.hp)[0];
      if (hurt && Math.abs(hurt.x - a.x) + Math.abs(hurt.y - a.y) <= 1) {
        tool = 'heal';
        hurt.hp = Math.min(hurt.maxHp, hurt.hp + 15);
        args = { target: hurt.id };
        this.emit({ type: 'agent_update', agent: { ...hurt, inventory: { ...hurt.inventory } } });
      } else if (hurt) {
        tool = 'move';
        this.moveToward(a, hurt.x, hurt.y, 2);
        args = { toward: hurt.id };
      }
    }
    if (tool === 'wait') {
      // move toward resources; less smart agents wander
      const target =
        this.rnd() < smart
          ? this.nearest(a, (t) => (a.role === 'builder' ? t.wood > 2 : t.food > 2))
          : this.tileAt(Math.floor(this.rnd() * W), Math.floor(this.rnd() * H));
      if (target) {
        tool = 'move';
        this.moveToward(a, target.x, target.y, a.role === 'explorer' ? 3 : 2);
        args = { to: [target.x, target.y] };
      }
    }

    a.status = 'acting';
    a.lastAction = `${tool}${Object.keys(args).length ? ' ' + JSON.stringify(args) : ''}`;
    a.sheltered = this.tileAt(a.x, a.y).shelter;
    this.emit({ type: 'agent_action', agentId: a.id, tick: this.tick, tool, args, result, ok });
    this.emit({ type: 'agent_update', agent: { ...a, inventory: { ...a.inventory } } });

    if (this.rnd() < (tier === 'opus' ? 0.35 : tier === 'sonnet' ? 0.22 : 0.15)) {
      const others = this.agents.filter((o) => o.alive && o.id !== a.id);
      const to = this.rnd() < 0.6 || !others.length ? 'all' : pick(others, this.rnd()).id;
      this.emit({ type: 'message', tick: this.tick, from: a.id, to, text: messageFor(tier, this.rnd(), { food: 20 + Math.round(this.rnd() * 30) }) });
    }
    this.later(this.tickMs * 0.15, () => {
      if (!a.alive) return;
      a.status = 'idle';
      this.emit({ type: 'agent_update', agent: { ...a, inventory: { ...a.inventory } } });
    });
  }

  private resolveSurvival() {
    const season = this.season();
    for (const a of this.agents) {
      if (!a.alive) continue;
      a.hunger = Math.min(100, a.hunger + this.rule('hunger_per_tick'));
      if (a.hunger >= 100) {
        if (this.stock.food > 0) {
          this.stock.food -= 1;
          a.hunger -= 20;
        } else {
          a.hp -= this.rule('starvation_damage');
          if (this.rnd() < 0.3) this.emit({ type: 'world_event', tick: this.tick, kind: 'starvation', text: t.mock.events.starving(a.name) });
        }
      }
      a.sheltered = this.tileAt(a.x, a.y).shelter;
      if (season === 'winter' && !a.sheltered) {
        a.hp -= this.rule('cold_damage_per_tick');
        if (this.rnd() < 0.2) this.emit({ type: 'world_event', tick: this.tick, kind: 'cold', text: t.mock.events.shivers(a.name) });
      } else if (a.hunger < 70) {
        a.hp = Math.min(a.maxHp, a.hp + 2);
      }
      a.hp = Math.max(0, Math.round(a.hp));
      if (a.hp <= 0) {
        a.alive = false;
        a.status = 'dead';
        a.thought = '';
        this.emit({ type: 'world_event', tick: this.tick, kind: 'death', text: t.mock.events.died(a.name, roleLabel(a.role).toLowerCase(), a.tier ?? '') });
      }
      this.emit({ type: 'agent_update', agent: { ...a, inventory: { ...a.inventory } } });
    }
    // births
    const alive = this.agents.filter((a) => a.alive);
    if (alive.length >= 2 && alive.length < 12 && this.stock.food >= this.rule('birth_food_threshold')) {
      this.stock.food -= this.rule('birth_food_threshold');
      const parent = pick(alive, this.rnd());
      const tier = TIERS[Math.floor(this.rnd() * 3)];
      const child = this.makeAgent(
        `c${++this.childIdx}`,
        CHILD_NAMES[(this.childIdx - 1) % CHILD_NAMES.length],
        pick(['gatherer', 'builder', 'explorer', 'healer'], this.rnd()),
        tier,
        `claude-${tier}`,
        parent.x,
        parent.y,
        parent.generation + 1,
      );
      this.agents.push(child);
      this.emit({ type: 'agent_update', agent: { ...child, inventory: { ...child.inventory } } });
      this.emit({ type: 'world_event', tick: this.tick, kind: 'birth', text: t.mock.events.born(child.name, parent.name, child.generation, tier) });
    }
  }

  private nearest(a: Agent, pred: (t: Tile) => boolean) {
    let best: Tile | null = null;
    let bd = Infinity;
    for (const t of this.tiles) {
      if (!pred(t)) continue;
      const d = Math.abs(t.x - a.x) + Math.abs(t.y - a.y) + this.rnd() * 2;
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best;
  }

  private moveToward(a: Agent, tx: number, ty: number, steps: number) {
    for (let i = 0; i < steps; i++) {
      const dx = Math.sign(tx - a.x);
      const dy = Math.sign(ty - a.y);
      if (!dx && !dy) break;
      const opts = [
        [a.x + dx, a.y],
        [a.x, a.y + dy],
        [a.x + dx, a.y + dy],
      ].filter(([x, y]) => (x !== a.x || y !== a.y) && x >= 0 && y >= 0 && x < W && y < H && this.tileAt(x, y).biome !== 'water');
      if (!opts.length) break;
      const [nx, ny] = opts[Math.floor(this.rnd() * opts.length)];
      a.x = nx;
      a.y = ny;
    }
  }
}

export function validateRoster(entries: RosterEntry[]): string | null {
  if (entries.length < 1 || entries.length > 16) return t.mock.errors.rosterSize;
  const seen = new Set<string>();
  for (const e of entries) {
    const n = e.name.trim().toLowerCase();
    if (!n) return t.mock.errors.noName;
    if (seen.has(n)) return t.mock.errors.dupName(e.name);
    seen.add(n);
  }
  return null;
}
