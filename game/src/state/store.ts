import { config } from '../config';
import type {
  ConsultMsg,
  CraftMsg,
  DecayMsg,
  DeliberationMsg,
  DiscoveryMsg,
  Economy,
  Entity,
  EntityDelta,
  FlowsMsg,
  GameTime,
  Group,
  HelloMsg,
  Insight,
  InsightMsg,
  Inventory,
  Memory,
  MemoryMsg,
  Recipe,
  Resource,
  Tech,
  TradeMsg,
  LorebaseStatus,
  PlanMsg,
  Rule,
  RuleChange,
  ServerMsg,
  Tile,
  WorldEventMsg,
  WorldTime,
  AgedMsg,
  Family,
  LawProposalMsg,
  OfferMsg,
  OpinionMsg,
  Person,
  Society,
  SkillMsg,
} from '../net/protocol';
import type { ConnStatus } from '../net/transport';

export interface Snapshot {
  t: number;
  x: number;
  y: number;
}

export interface EntityState extends Entity {
  snaps: Snapshot[];
  thinking: boolean;
}

export interface LogLine {
  at: number;
  from: string;
  to: string;
  text: string;
  kind: 'speech' | 'thought';
}

export interface Plan {
  id: string;
  scope: 'entity' | 'group';
  steps: PlanMsg['steps'];
  current: number;
  reason: string;
  createdAt: number;
}

export interface Chronicle extends Omit<WorldEventMsg, 'type'> {
  id: number;
  day: number;
  minute: number;
}

export interface ConsultEntry {
  at: number;
  day: number;
  minute: number;
  tool: string;
  query: string;
}

/** Last known economy (hello, REST or live discoveries). */
export interface EconomyState {
  resources: Map<string, Resource>;
  recipes: Map<string, Recipe>;
  techs: Map<string, Tech>;
  hiddenRecipes: number;
  known: boolean;
}

export type LawProposal = Omit<LawProposalMsg, 'type'>;
export type Offer = Omit<OfferMsg, 'type'> & { at: number };
export interface OpinionState { from: string; to: string; score: number; reason?: string }
export interface EsteemChange { id: string; prev: number; esteem: number }

/** Events the store emits after applying a message. */
export interface StoreEvents {
  hello: HelloMsg;
  status: ConnStatus;
  entity_added: EntityState;
  entity_removed: { id: string; reason: string; entity?: EntityState };
  entity_delta: { e: EntityState; prevHp: number; prevInv: Inventory; prevAlive: boolean };
  thinking: { id: string; on: boolean };
  plan: Plan;
  plan_progress: Plan;
  say: LogLine;
  say_stream: { from: string; to: string; text: string; done: boolean };
  group: Group;
  group_removed: { id: string };
  tile: Tile;
  time: WorldTime & { seasonChanged: boolean };
  world_event: Chronicle;
  rules_changed: { revision: string; changes: RuleChange[] };
  lorebase: LorebaseStatus & { changed: boolean };
  select: { id: string | null };
  economy: EconomyState;
  insight: InsightMsg;
  consult: ConsultMsg & { entry: ConsultEntry };
  craft: CraftMsg;
  trade: TradeMsg;
  discovery: DiscoveryMsg;
  decay: DecayMsg;
  flows: FlowsMsg;
  memory: MemoryMsg;
  memories: { agentId: string };
  deliberation: DeliberationMsg;
  /** Any change to people, families or opinions (panel refresh). */
  society: void;
  reputation: { changes: EsteemChange[] };
  opinion: OpinionMsg;
  aged: AgedMsg;
  skill: SkillMsg;
  family: Family;
  law_proposal: LawProposal;
  offer: Offer;
  any: void;
}

type Handler<T> = (payload: T) => void;

const MAX_LOG = 60;
const MAX_CHRONICLE = 80;

export class Store {
  status: ConnStatus = 'connecting';
  youId: string | null = null;
  mapW = 0;
  mapH = 0;
  tiles: Tile[] = [];
  entities = new Map<string, EntityState>();
  groups = new Map<string, Group>();
  plans = new Map<string, Plan>();
  rules = new Map<string, Rule>();
  time: WorldTime = { day: 1, minute: 480, season: 'spring' };
  roles: string[] = [...config.defaultRoles];
  lorebase: LorebaseStatus = { connected: false, branch: '-', revision: '-' };
  logs = new Map<string, LogLine[]>();
  streams = new Map<string, string>();
  chronicle: Chronicle[] = [];
  selectedId: string | null = null;
  hasHello = false;
  economy: EconomyState = { resources: new Map(), recipes: new Map(), techs: new Map(), hiddenRecipes: 0, known: false };
  flows: FlowsMsg | null = null;
  /** Insights by code: accepted, pending, rejected and retired ones seen so far. */
  insights = new Map<string, Insight>();
  consults = new Map<string, ConsultEntry[]>();
  /** Private memories per agent: filled by REST on demand and kept current by `memory` events. */
  memories = new Map<string, Map<string, Memory>>();
  /** Society: everyone who ever lived, families, opinions (god only), skills, barter offers, agents' law proposals. */
  people = new Map<string, Person>();
  families = new Map<string, Family>();
  opinions = new Map<string, OpinionState>();
  skills = new Map<string, Map<string, number>>();
  offers = new Map<string, Offer>();
  lawProposals = new Map<string, LawProposal>();
  societyKnown = false;
  private stateInterval = 100;
  private lastStateAt = 0;
  private chronId = 0;
  private handlers = new Map<keyof StoreEvents, Set<Handler<unknown>>>();

  on<K extends keyof StoreEvents>(ev: K, cb: Handler<StoreEvents[K]>): () => void {
    let set = this.handlers.get(ev);
    if (!set) this.handlers.set(ev, (set = new Set()));
    set.add(cb as Handler<unknown>);
    return () => set!.delete(cb as Handler<unknown>);
  }

  private emit<K extends keyof StoreEvents>(ev: K, payload: StoreEvents[K]): void {
    this.handlers.get(ev)?.forEach((cb) => cb(payload));
    if (ev !== 'any') this.handlers.get('any')?.forEach((cb) => cb(undefined));
  }

  setStatus(s: ConnStatus): void {
    this.status = s;
    this.emit('status', s);
  }

  select(id: string | null): void {
    this.selectedId = id;
    this.emit('select', { id });
  }

  tileAt(x: number, y: number): Tile | undefined {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= this.mapW || iy >= this.mapH) return undefined;
    return this.tiles[iy * this.mapW + ix];
  }

  you(): EntityState | undefined {
    return this.youId ? this.entities.get(this.youId) : undefined;
  }

  name(id: string): string {
    if (id === 'all') return 'everyone';
    return this.entities.get(id)?.name ?? this.groups.get(id)?.name ?? id;
  }

  groupOf(id: string): Group | undefined {
    const e = this.entities.get(id);
    return e?.groupId ? this.groups.get(e.groupId) : undefined;
  }

  /** Entity by id, falling back to its name (some events name people instead of ids). */
  resolve(ref: string | null | undefined): EntityState | undefined {
    if (!ref) return undefined;
    const byId = this.entities.get(ref);
    if (byId) return byId;
    for (const e of this.entities.values()) if (e.name === ref) return e;
    return undefined;
  }

  /** Display name of an item code (economy resource or recipe output), else the code itself. */
  itemName(code: string): string {
    return this.economy.resources.get(code)?.name ?? this.economy.recipes.get(code)?.name ?? code.replace(/_/g, ' ');
  }

  setEconomy(e: Economy): void {
    this.economy = {
      resources: new Map(e.resources.map((r) => [r.code, r])),
      recipes: new Map(e.recipes.map((r) => [r.code, r])),
      techs: new Map(e.techs.map((t) => [t.code, t])),
      hiddenRecipes: e.hiddenRecipes,
      known: true,
    };
    this.emit('economy', this.economy);
  }

  /** Merge insights fetched over REST (the newest status wins). */
  mergeInsights(list: Insight[]): void {
    for (const i of list) this.insights.set(i.code, { ...this.insights.get(i.code), ...i });
  }

  /** Merge a society snapshot (hello or REST); opinions are replaced only when present. */
  setSociety(soc: Society): void {
    this.societyKnown = true;
    for (const p of soc.people ?? []) {
      this.people.set(p.id, { ...this.people.get(p.id), ...p });
      const e = this.entities.get(p.id);
      if (e) Object.assign(e, { age: p.age, esteem: p.esteem, fame: p.fame, rank: p.rank, family: p.family, parents: p.parents });
    }
    for (const f of soc.families ?? []) this.families.set(f.id, f);
    if (soc.opinions) this.opinions = new Map(soc.opinions.map((o) => [`${o.from}>${o.to}`, { ...this.opinions.get(`${o.from}>${o.to}`), ...o }]));
    this.emit('society', undefined);
  }

  /** Person record of an id (society first, else derived from the live entity). */
  person(id: string): Person | undefined {
    const p = this.people.get(id);
    if (p) return p;
    const e = this.entities.get(id);
    if (!e || !e.age) return undefined;
    return { id: e.id, name: e.name, role: e.role, tier: e.tier, effectiveTier: e.effectiveTier, age: e.age, esteem: e.esteem ?? 0, fame: e.fame ?? 0, rank: e.rank ?? 0, family: e.family ?? null, parents: e.parents ?? null, alive: e.alive };
  }

  /** Name of a person even after death. */
  personName(id: string): string {
    return this.entities.get(id)?.name ?? this.people.get(id)?.name ?? id;
  }

  /** Keep the person record in step with entity-borne society fields. */
  private syncPerson(e: Entity): void {
    if (!e.age) return;
    const prev = this.people.get(e.id);
    this.people.set(e.id, {
      id: e.id,
      name: e.name,
      role: e.role,
      tier: e.tier,
      effectiveTier: e.effectiveTier ?? prev?.effectiveTier,
      age: e.age,
      esteem: e.esteem ?? prev?.esteem ?? 0,
      fame: e.fame ?? prev?.fame ?? 0,
      rank: e.rank ?? prev?.rank ?? 0,
      family: e.family ?? prev?.family ?? null,
      parents: e.parents ?? prev?.parents ?? null,
      alive: e.alive,
    });
  }

  setMemories(agentId: string, list: Memory[]): void {
    this.memories.set(agentId, new Map(list.map((m) => [m.id, m])));
    this.emit('memories', { agentId });
  }

  private clockAt(at: unknown): GameTime {
    const g = at as Partial<GameTime> | undefined;
    return g && typeof g.day === 'number' && typeof g.minute === 'number' ? { day: g.day, minute: g.minute } : { day: this.time.day, minute: this.time.minute };
  }

  /** Interpolated render position, buffered behind the newest frame. */
  renderPos(e: EntityState, now: number): { x: number; y: number } {
    const s = e.snaps;
    if (s.length === 0) return { x: e.x, y: e.y };
    const delay = Math.max(config.interpDelayMs, this.stateInterval * 1.3);
    const rt = now - delay;
    if (rt <= s[0].t) return s[0];
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1];
      const b = s[i];
      if (rt >= a.t && rt <= b.t) {
        const k = b.t === a.t ? 1 : (rt - a.t) / (b.t - a.t);
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      }
    }
    return s[s.length - 1];
  }

  private pushLog(id: string, line: LogLine) {
    let arr = this.logs.get(id);
    if (!arr) this.logs.set(id, (arr = []));
    arr.push(line);
    if (arr.length > MAX_LOG) arr.splice(0, arr.length - MAX_LOG);
  }

  private addEntity(raw: Entity): EntityState {
    const e: EntityState = { ...raw, snaps: [{ t: performance.now(), x: raw.x, y: raw.y }], thinking: false };
    this.entities.set(e.id, e);
    this.syncPerson(e);
    return e;
  }

  private addChronicle(ev: Omit<WorldEventMsg, 'type'>): Chronicle {
    const c: Chronicle = { ...ev, id: ++this.chronId, day: this.time.day, minute: this.time.minute };
    this.chronicle.push(c);
    if (this.chronicle.length > MAX_CHRONICLE) this.chronicle.shift();
    return c;
  }

  apply(msg: ServerMsg): void {
    switch (msg.type) {
      case 'hello': {
        this.hasHello = true;
        this.youId = msg.you?.entityId ?? null;
        this.mapW = msg.map.w;
        this.mapH = msg.map.h;
        this.tiles = new Array(msg.map.w * msg.map.h);
        for (const t of msg.map.tiles) this.tiles[t.y * msg.map.w + t.x] = { ...t };
        for (let i = 0; i < this.tiles.length; i++) {
          if (!this.tiles[i]) {
            const x = i % msg.map.w;
            const y = Math.floor(i / msg.map.w);
            this.tiles[i] = { x, y, biome: 'water', elev: 0, food: 0, wood: 0, shelter: 0 };
          }
        }
        this.entities.clear();
        for (const e of msg.entities) this.addEntity(e);
        this.groups = new Map(msg.groups.map((g) => [g.id, g]));
        this.rules = new Map(msg.rules.map((r) => [r.key, r]));
        this.time = msg.time;
        if (msg.roles?.length) this.roles = msg.roles;
        this.lorebase = msg.lorebase;
        if (msg.economy) this.setEconomy(msg.economy);
        if (msg.society) this.setSociety(msg.society);
        this.emit('hello', msg);
        break;
      }
      case 'state': {
        const now = performance.now();
        if (this.lastStateAt) this.stateInterval = this.stateInterval * 0.8 + Math.min(1000, now - this.lastStateAt) * 0.2;
        this.lastStateAt = now;
        for (const d of msg.entities) this.applyDelta(d, now);
        break;
      }
      case 'entity_added': {
        const e = this.addEntity(msg.entity);
        this.emit('entity_added', e);
        break;
      }
      case 'entity_removed': {
        const e = this.entities.get(msg.id);
        this.entities.delete(msg.id);
        const person = this.people.get(msg.id);
        if (person && /death|died|morto|starv|cold/i.test(msg.reason)) person.alive = false;
        if (this.selectedId === msg.id) this.select(null);
        this.emit('entity_removed', { id: msg.id, reason: msg.reason, entity: e });
        break;
      }
      case 'thinking': {
        const e = this.entities.get(msg.id);
        if (e) e.thinking = msg.on;
        this.emit('thinking', { id: msg.id, on: msg.on });
        break;
      }
      case 'plan': {
        const p: Plan = {
          id: msg.id,
          scope: msg.scope,
          steps: msg.steps,
          current: msg.current,
          reason: msg.reason,
          createdAt: msg.createdAt,
        };
        this.plans.set(msg.id, p);
        this.emit('plan', p);
        break;
      }
      case 'plan_progress': {
        const p = this.plans.get(msg.id);
        if (p) {
          p.current = msg.current;
          this.emit('plan_progress', p);
        }
        break;
      }
      case 'say': {
        // Drop the echo of a reply that was already streamed.
        if (this.recentlyStreamed(msg.from, msg.text)) break;
        const line: LogLine = { at: Date.now(), from: msg.from, to: msg.to, text: msg.text, kind: msg.kind };
        this.pushLog(msg.from, line);
        if (msg.to !== 'all' && msg.to !== msg.from) this.pushLog(msg.to, line);
        this.emit('say', line);
        break;
      }
      case 'say_delta': {
        const key = msg.from;
        const text = (this.streams.get(key) ?? '') + msg.delta;
        if (msg.done) {
          this.streams.delete(key);
          const line: LogLine = { at: Date.now(), from: msg.from, to: msg.to, text, kind: 'speech' };
          this.pushLog(msg.from, line);
          this.pushLog(msg.to, line);
          this.lastStreamed.set(msg.from, { text, at: Date.now() });
          this.emit('say', line);
        } else {
          this.streams.set(key, text);
        }
        this.emit('say_stream', { from: msg.from, to: msg.to, text, done: msg.done });
        break;
      }
      case 'group':
        this.groups.set(msg.group.id, msg.group);
        this.emit('group', msg.group);
        break;
      case 'group_removed':
        this.groups.delete(msg.id);
        this.plans.delete(msg.id);
        this.emit('group_removed', { id: msg.id });
        break;
      case 'tile':
        this.applyTile(msg);
        break;
      case 'tiles':
        for (const it of msg.items ?? []) this.applyTile(it);
        break;
      case 'reputation': {
        const changes: EsteemChange[] = [];
        for (const r of msg.people) {
          const p = this.people.get(r.id);
          const e = this.entities.get(r.id);
          const prev = p?.esteem ?? e?.esteem ?? r.esteem;
          if (p) Object.assign(p, { esteem: r.esteem, fame: r.fame, rank: r.rank });
          if (e) Object.assign(e, { esteem: r.esteem, fame: r.fame, rank: r.rank });
          changes.push({ id: r.id, prev, esteem: r.esteem });
        }
        this.emit('reputation', { changes });
        this.emit('society', undefined);
        break;
      }
      case 'opinion':
        this.opinions.set(`${msg.from}>${msg.to}`, { from: msg.from, to: msg.to, score: msg.score, reason: msg.reason });
        this.emit('opinion', msg);
        this.emit('society', undefined);
        break;
      case 'aged': {
        const p = this.people.get(msg.id);
        const e = this.entities.get(msg.id);
        if (p) p.age = { ...p.age, stage: msg.stage };
        if (e) e.age = { days: e.age?.days ?? 0, stage: msg.stage };
        this.emit('aged', msg);
        this.emit('society', undefined);
        break;
      }
      case 'skill': {
        let m = this.skills.get(msg.id);
        if (!m) this.skills.set(msg.id, (m = new Map()));
        m.set(msg.recipe, msg.level);
        this.emit('skill', msg);
        break;
      }
      case 'family':
        this.families.set(msg.family.id, msg.family);
        this.emit('family', msg.family);
        this.emit('society', undefined);
        break;
      case 'law_proposal': {
        const { type: _t, ...lp } = msg;
        this.lawProposals.set(lp.id, lp);
        this.emit('law_proposal', lp);
        break;
      }
      case 'offer': {
        const { type: _t, ...o } = msg;
        const offer: Offer = { ...o, at: Date.now() };
        this.offers.set(o.id, offer);
        // resolved offers are kept briefly for the inspector, then dropped
        for (const [id, x] of this.offers) if (x.status !== 'pending' && Date.now() - x.at > config.society.offerKeepMs) this.offers.delete(id);
        this.emit('offer', offer);
        break;
      }
      case 'time': {
        const seasonChanged = msg.season !== this.time.season;
        this.time = { day: msg.day, minute: msg.minute, season: msg.season };
        this.emit('time', { ...this.time, seasonChanged });
        break;
      }
      case 'world_event':
        this.emit('world_event', this.addChronicle({ kind: msg.kind, text: msg.text, at: msg.at }));
        break;
      case 'rules_changed':
        for (const c of msg.changes) {
          const r = this.rules.get(c.key);
          if (c.removed) this.rules.delete(c.key);
          else if (r) Object.assign(r, { value: c.new, text: c.text ?? r.text, category: c.category ?? r.category, unit: c.unit ?? r.unit });
          else this.rules.set(c.key, { key: c.key, value: c.new, text: c.text, category: c.category ?? 'other', unit: c.unit ?? '' });
        }
        this.lorebase = { ...this.lorebase, revision: msg.revision };
        this.emit('rules_changed', { revision: msg.revision, changes: msg.changes });
        this.emit('lorebase', { ...this.lorebase, changed: true });
        break;
      case 'insight': {
        const ins = { ...msg.insight, status: msg.action, ...(msg.reviewer ? { reviewer: msg.reviewer } : {}) };
        this.insights.set(ins.code, ins);
        this.emit('insight', { ...msg, insight: ins });
        break;
      }
      case 'consult': {
        const entry: ConsultEntry = { at: Date.now(), day: this.time.day, minute: this.time.minute, tool: msg.tool, query: msg.query };
        let arr = this.consults.get(msg.agentId);
        if (!arr) this.consults.set(msg.agentId, (arr = []));
        arr.push(entry);
        if (arr.length > config.minds.consultsKept) arr.splice(0, arr.length - config.minds.consultsKept);
        this.emit('consult', { ...msg, entry });
        break;
      }
      case 'craft':
        this.emit('craft', msg);
        break;
      case 'trade':
        this.emit('trade', msg);
        break;
      case 'decay':
        this.emit('decay', msg);
        break;
      case 'discovery': {
        const prev = this.economy.techs.get(msg.tech.code);
        this.economy.techs.set(msg.tech.code, {
          code: msg.tech.code,
          name: msg.tech.name,
          description: msg.tech.description,
          unlocks: msg.tech.unlocks?.length ? msg.tech.unlocks : (prev?.unlocks ?? []),
          discovered: true,
          discoveredBy: this.resolve(msg.by)?.name ?? msg.by,
          discoveredAt: this.clockAt(msg.at),
        });
        this.emit('discovery', msg);
        this.emit('economy', this.economy);
        break;
      }
      case 'flows':
        this.flows = msg;
        this.emit('flows', msg);
        break;
      case 'memory': {
        let mem = this.memories.get(msg.agentId);
        if (!mem) this.memories.set(msg.agentId, (mem = new Map()));
        for (const id of msg.mergedFrom ?? []) mem.delete(id);
        if (msg.action === 'forgotten') mem.delete(msg.memory.id);
        else mem.set(msg.memory.id, msg.memory);
        this.emit('memory', msg);
        break;
      }
      case 'deliberation':
        this.emit('deliberation', msg);
        break;
      case 'lorebase': {
        const changed = msg.revision !== this.lorebase.revision || msg.branch !== this.lorebase.branch;
        this.lorebase = { connected: msg.connected, branch: msg.branch, revision: msg.revision };
        this.emit('lorebase', { ...this.lorebase, changed });
        break;
      }
    }
  }

  private applyTile(m: { x: number; y: number; food: number; wood: number; shelter: Tile['shelter'] }): void {
    const t = this.tileAt(m.x, m.y);
    if (!t) return;
    t.food = m.food;
    t.wood = m.wood;
    t.shelter = m.shelter;
    this.emit('tile', t);
  }

  private lastStreamed = new Map<string, { text: string; at: number }>();
  private recentlyStreamed(from: string, text: string): boolean {
    const s = this.lastStreamed.get(from);
    return !!s && s.text.trim() === text.trim() && Date.now() - s.at < 5000;
  }

  private applyDelta(d: EntityDelta, now: number) {
    const e = this.entities.get(d.id);
    if (!e) return;
    const prevHp = e.hp;
    const prevInv = { ...e.inventory };
    const prevAlive = e.alive;
    e.x = d.x;
    e.y = d.y;
    e.dir = d.dir;
    e.anim = d.anim;
    e.hp = d.hp;
    e.hunger = d.hunger;
    e.alive = d.alive;
    if (prevAlive !== d.alive) {
      const p = this.people.get(e.id);
      if (p) p.alive = d.alive;
    }
    if (d.inventory) e.inventory = d.inventory;
    if (d.tools) e.tools = d.tools;
    e.snaps.push({ t: now, x: d.x, y: d.y });
    if (e.snaps.length > 12) e.snaps.splice(0, e.snaps.length - 12);
    this.emit('entity_delta', { e, prevHp, prevInv, prevAlive });
  }
}

export const store = new Store();
