import { config } from '../config';
import type {
  Entity,
  EntityDelta,
  Group,
  HelloMsg,
  Inventory,
  LorebaseStatus,
  PlanMsg,
  Rule,
  RuleChange,
  ServerMsg,
  Tile,
  WorldEventMsg,
  WorldTime,
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
      case 'tile': {
        const t = this.tileAt(msg.x, msg.y);
        if (t) {
          t.food = msg.food;
          t.wood = msg.wood;
          t.shelter = msg.shelter;
          this.emit('tile', t);
        }
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
          if (r) r.value = c.new;
          else this.rules.set(c.key, { key: c.key, value: c.new, text: c.text, category: 'other', unit: '' });
        }
        this.lorebase = { ...this.lorebase, revision: msg.revision };
        this.emit('rules_changed', { revision: msg.revision, changes: msg.changes });
        this.emit('lorebase', { ...this.lorebase, changed: true });
        break;
      case 'lorebase': {
        const changed = msg.revision !== this.lorebase.revision || msg.branch !== this.lorebase.branch;
        this.lorebase = { connected: msg.connected, branch: msg.branch, revision: msg.revision };
        this.emit('lorebase', { ...this.lorebase, changed });
        break;
      }
    }
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
    if (d.inventory) e.inventory = d.inventory;
    e.snaps.push({ t: now, x: d.x, y: d.y });
    if (e.snaps.length > 12) e.snaps.splice(0, e.snaps.length - 12);
    this.emit('entity_delta', { e, prevHp, prevInv, prevAlive });
  }
}

export const store = new Store();
