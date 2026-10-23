import type {
  ClientMsg,
  Dir,
  Entity,
  Group,
  MapData,
  PlanStep,
  RuleEditRequest,
  ServerMsg,
  Season,
  Tile,
  WorldTime,
} from '../net/protocol';
import type { ConnStatus, Transport } from '../net/transport';
import { rng } from '../render/palette';
import {
  AGENTS,
  ASSEMBLY_DECISION,
  CHATTER,
  CROWD_NAMES,
  DEFAULT_REPLY,
  GROUPS,
  MODELS,
  REPLIES,
  RULES,
  THOUGHTS,
} from './mockData';
import { BUILD_SITE, generateMap, HUTS, STOCKPILE, VILLAGE } from './mockMap';

const params = new URLSearchParams(location.search);
/** Simulation speed multiplier (`?mockSpeed=4`). */
const SPEED = Math.max(0.25, Number(params.get('mockSpeed') || 1));
const START_SEASON = (params.get('mockSeason') as Season) || 'autumn';
const TICK_MS = 100;
/** Game minutes per real second. */
const MINUTES_PER_SEC = 8;
/** Real seconds (at speed 1) before scripted events. */
const RULES_CHANGE_AT = 55;
const WINTER_AT = 110;

interface Actor extends Entity {
  steps: PlanStep[];
  current: number;
  stepT: number;
  path: { x: number; y: number }[];
  busyUntil: number;
  thinkingUntil: number;
  persona: string;
  vx: number;
  vy: number;
}

interface GroupStepRef {
  who: string;
  /** Index of the step in the member's own plan. */
  src: number;
  /** The member plan the step was taken from (replanning invalidates it). */
  plan: PlanStep[];
  done: boolean;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** In-browser world that speaks the real protocol, so the client can be demoed offline. */
export class MockServer implements Transport {
  readonly kind = 'mock' as const;
  private msgCbs: ((m: ServerMsg) => void)[] = [];
  private map: MapData;
  private tiles: Tile[];
  private actors = new Map<string, Actor>();
  private groups = new Map<string, Group>();
  private rules = RULES.map((r) => ({ ...r }));
  private time: WorldTime = { day: 1, minute: 7 * 60, season: START_SEASON };
  private lorebase = { connected: true, branch: 'main', revision: 'a3f9c1e' };
  private youId: string | null = null;
  private r = rng(42);
  private elapsed = 0;
  private timer: number;
  private chatterT = 4;
  private winterDone = START_SEASON === 'winter';
  private rulesDone = false;
  private nextPlayer = 1;
  private groupProgress = new Map<string, { refs: GroupStepRef[]; current: number }>();

  constructor() {
    this.map = generateMap();
    this.tiles = this.map.tiles;
    this.groups = new Map(GROUPS.map((g) => [g.id, structuredClone(g)]));
    AGENTS.forEach((a, i) => {
      const spot = this.freeNear(VILLAGE.x + ((i % 4) - 2) * 2, VILLAGE.y + Math.floor(i / 4) * 3 - 1);
      this.actors.set(a.id, this.makeActor({ id: a.id, name: a.name, role: a.role, tier: a.tier, kind: 'agent', groupId: a.groupId, speed: a.speed, ...spot }, a.persona));
    });
    CROWD_NAMES.forEach((name, i) => {
      const spot = this.freeNear(VILLAGE.x - 3 + i * 2, VILLAGE.y + 3);
      this.actors.set(`c-${i}`, this.makeActor({ id: `c-${i}`, name, role: 'villager', tier: 'haiku', kind: 'crowd', groupId: 'g-crowd', speed: 1.1, ...spot }, ''));
    });
    // stagger first plans so the opening already looks busy
    let k = 0;
    for (const a of this.actors.values()) {
      if (a.kind === 'agent') this.think(a, 'Il giorno comincia: cosa serve al villaggio?', 0.3 + k++ * 0.35);
      else this.crowdPlan(a);
    }
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    setTimeout(() => this.groupPlans(), 3500);
  }

  // ------------------------------------------------------------ transport

  onMessage(cb: (msg: ServerMsg) => void): void {
    this.msgCbs.push(cb);
    // like a real socket: greet as soon as someone listens
    if (this.msgCbs.length === 1) setTimeout(() => this.hello(), 0);
  }
  onStatus(cb: (s: ConnStatus) => void): void {
    setTimeout(() => cb('mock'), 0);
  }
  close(): void {
    clearInterval(this.timer);
  }

  send(msg: ClientMsg): void {
    switch (msg.type) {
      case 'join':
        this.join(msg.name, msg.role);
        break;
      case 'input': {
        const p = this.youId ? this.actors.get(this.youId) : undefined;
        if (p) {
          p.vx = clamp(msg.dx, -1, 1);
          p.vy = clamp(msg.dy, -1, 1);
        }
        break;
      }
      case 'act':
        this.playerAct(msg.action, msg.args);
        break;
      case 'speak':
        this.reply(msg.to, msg.text);
        break;
    }
  }

  async postRule(req: RuleEditRequest): Promise<string | null> {
    const rule = this.rules.find((r) => r.key === req.key);
    if (!rule) return `legge sconosciuta: ${req.key}`;
    if (req.mode === 'proposal') {
      this.emit({ type: 'world_event', kind: 'rules', text: `Proposta aperta: ${rule.text} → ${req.value}. ${req.message || ''}`.trim() });
      setTimeout(() => this.changeRule(req.key, req.value, 'Proposta approvata dal consiglio'), 4000 / SPEED);
    } else {
      setTimeout(() => this.changeRule(req.key, req.value, req.message || 'Modifica diretta'), 600);
    }
    return null;
  }

  private emit(msg: ServerMsg) {
    for (const cb of this.msgCbs) cb(msg);
  }

  // ------------------------------------------------------------ setup helpers

  private makeActor(
    e: Pick<Entity, 'id' | 'name' | 'role' | 'tier' | 'kind' | 'groupId' | 'speed' | 'x' | 'y'>,
    persona: string,
  ): Actor {
    return {
      ...e,
      model: MODELS[e.tier],
      dir: 's',
      anim: 'idle',
      hp: 100,
      maxHp: 100,
      hunger: 15 + Math.floor(this.r() * 30),
      inventory: { food: e.kind === 'player' ? 1 : Math.floor(this.r() * 3), wood: 0 },
      alive: true,
      steps: [],
      current: 0,
      stepT: 0,
      path: [],
      busyUntil: 0,
      thinkingUntil: 0,
      persona,
      vx: 0,
      vy: 0,
    };
  }

  private tile(x: number, y: number): Tile | undefined {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= this.map.w || iy >= this.map.h) return undefined;
    return this.tiles[iy * this.map.w + ix];
  }

  private passable(x: number, y: number): boolean {
    const t = this.tile(x, y);
    return !!t && t.biome !== 'water' && t.elev < 3 && t.shelter === 0;
  }

  private freeNear(x: number, y: number): { x: number; y: number } {
    for (let r = 0; r < 8; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) if (this.passable(x + dx, y + dy)) return { x: x + dx, y: y + dy };
    return { x, y };
  }

  private findPath(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] {
    const w = this.map.w;
    const sx = Math.round(from.x);
    const sy = Math.round(from.y);
    const goal = this.passable(to.x, to.y) ? to : this.freeNear(to.x, to.y);
    const prev = new Map<number, number>();
    const start = sy * w + sx;
    const target = goal.y * w + goal.x;
    const q = [start];
    prev.set(start, -1);
    while (q.length) {
      const cur = q.shift()!;
      if (cur === target) break;
      const cx = cur % w;
      const cy = Math.floor(cur / w);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        const id = ny * w + nx;
        if (prev.has(id) || !this.passable(nx, ny)) continue;
        prev.set(id, cur);
        q.push(id);
      }
    }
    if (!prev.has(target)) return [];
    const path: { x: number; y: number }[] = [];
    for (let c = target; c !== -1 && c !== start; c = prev.get(c)!) path.unshift({ x: c % w, y: Math.floor(c / w) });
    return path;
  }

  private nearest(a: Actor, pred: (t: Tile) => boolean, spread = 4): Tile | undefined {
    const cands = this.tiles.filter(pred);
    cands.sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y));
    return cands[Math.floor(this.r() * Math.min(spread, cands.length))];
  }

  private rule(key: string): number {
    return Number(this.rules.find((r) => r.key === key)?.value ?? 0);
  }

  private snapshotEntity(a: Actor): Entity {
    const { steps: _s, current: _c, stepT: _t, path: _p, busyUntil: _b, thinkingUntil: _th, persona: _pe, vx: _vx, vy: _vy, ...e } = a;
    return e;
  }

  // ------------------------------------------------------------ protocol out

  private hello() {
    this.emit({
      type: 'hello',
      you: this.youId ? { entityId: this.youId } : null,
      map: { w: this.map.w, h: this.map.h, tiles: this.tiles.map((t) => ({ ...t })) },
      entities: [...this.actors.values()].map((a) => this.snapshotEntity(a)),
      groups: [...this.groups.values()],
      rules: this.rules,
      time: this.time,
      roles: ['gatherer', 'woodcutter', 'builder', 'healer', 'scout', 'wanderer'],
      lorebase: this.lorebase,
    });
    // replay current plans so a late joiner sees them
    for (const a of this.actors.values()) if (a.steps.length && a.kind === 'agent') this.sendPlan(a, 'Piano in corso');
    this.groupPlans();
  }

  private join(name: string, role: string) {
    const id = `p-${this.nextPlayer++}`;
    const spot = this.freeNear(VILLAGE.x + 1, VILLAGE.y + 1);
    const p = this.makeActor({ id, name: name || 'Viandante', role: role || 'wanderer', tier: 'human', kind: 'player', groupId: null, speed: 2.4, ...spot }, '');
    this.actors.set(id, p);
    this.youId = id;
    this.hello();
    this.emit({ type: 'world_event', kind: 'birth', text: `${p.name} è arrivato al villaggio.`, at: spot });
  }

  private sendPlan(a: Actor, reason: string) {
    this.emit({ type: 'plan', id: a.id, scope: 'entity', steps: a.steps, current: a.current, reason, createdAt: Date.now() });
  }

  // ------------------------------------------------------------ planning

  private think(a: Actor, reason: string, delaySec = 0) {
    a.steps = [];
    a.path = [];
    a.anim = 'idle';
    const dur = (1.2 + this.r() * 2 + (a.tier === 'opus' ? 1 : 0)) / SPEED + delaySec;
    a.thinkingUntil = this.elapsed + dur * SPEED + 0.5;
    setTimeout(() => this.emit({ type: 'thinking', id: a.id, on: true }), delaySec * 1000);
    setTimeout(() => {
      if (!this.actors.has(a.id)) return;
      this.emit({ type: 'thinking', id: a.id, on: false });
      a.steps = this.makePlan(a);
      a.current = 0;
      a.stepT = 0;
      this.sendPlan(a, reason);
      if (a.groupId) this.groupPlans(a.groupId);
      if (this.r() < 0.5) this.emit({ type: 'say', from: a.id, to: 'all', text: THOUGHTS[Math.floor(this.r() * THOUGHTS.length)], kind: 'thought' });
    }, dur * 1000);
  }

  private makePlan(a: Actor): PlanStep[] {
    const s: PlanStep[] = [];
    const walk = (t: { x: number; y: number }, label: string) => s.push({ action: 'walk_to', args: { x: t.x, y: t.y }, label });
    const night = this.time.minute > 20 * 60 || this.time.minute < 6 * 60;
    const winter = this.time.season === 'winter';
    if (night) {
      const hut = HUTS[Math.floor(this.r() * HUTS.length)];
      walk(this.freeNear(hut.x + 1, hut.y), 'Torna alla capanna');
      s.push({ action: 'sleep', args: { s: 25 }, label: 'Dorme fino all’alba' });
      return s;
    }
    if (a.hunger > 55 && a.inventory.food > 0) s.push({ action: 'eat', args: {}, label: 'Mangia una bacca' });
    const role = a.role;
    const rounds = 5 + Math.floor(this.r() * 4);
    for (let i = 0; i < rounds; i++) {
      if (role === 'woodcutter' || (role === 'chief' && i % 2 === 0) || (winter && role === 'hunter')) {
        const tree = this.nearest(a, (t) => t.biome === 'forest' && t.wood > 0, 6);
        if (!tree) break;
        walk(this.freeNear(tree.x, tree.y + 1), 'Cammina verso il bosco');
        s.push({ action: 'chop', args: { x: tree.x, y: tree.y }, label: 'Taglia un albero' });
        s.push({ action: 'chop', args: { x: tree.x, y: tree.y }, label: 'Taglia ancora' });
        s.push({ action: 'carry_to', args: { ...STOCKPILE }, label: 'Porta la legna al mucchio' });
      } else if (role === 'builder') {
        walk(this.freeNear(STOCKPILE.x, STOCKPILE.y + 1), 'Prende legna dal mucchio');
        s.push({ action: 'take', args: { ...STOCKPILE }, label: 'Carica la legna' });
        walk(this.freeNear(BUILD_SITE.x + 1, BUILD_SITE.y), 'Va al cantiere');
        s.push({ action: 'build', args: { ...BUILD_SITE }, label: 'Costruisce il riparo' });
        s.push({ action: 'wait', args: { s: 2 }, label: 'Controlla il lavoro' });
      } else if (role === 'chief' || role === 'elder') {
        const other = this.pickOther(a);
        if (other) {
          walk(this.freeNear(Math.round(other.x) + 1, Math.round(other.y)), `Raggiunge ${other.name}`);
          s.push({ action: 'say', args: { to: other.id, text: role === 'elder' ? 'Ricorda: prima le scorte, poi l’avventura.' : 'Come procede? Serve una mano?' }, label: `Parla con ${other.name}` });
        }
        s.push({ action: 'wait', args: { s: 3 }, label: 'Osserva il villaggio' });
      } else {
        const bush = this.nearest(a, (t) => t.food > 0, 5);
        if (!bush) break;
        walk(this.freeNear(bush.x + 1, bush.y), 'Va verso un cespuglio di bacche');
        s.push({ action: 'gather', args: { x: bush.x, y: bush.y }, label: 'Raccoglie bacche' });
        if (role === 'scout' && i === 0) s.push({ action: 'say', args: { to: 'all', text: 'Qui ce ne sono ancora!' }, label: 'Avvisa gli altri' });
      }
    }
    walk(this.freeNear(VILLAGE.x + Math.floor(this.r() * 5) - 2, VILLAGE.y + Math.floor(this.r() * 5) - 2), 'Torna in piazza');
    if (a.inventory.food > 1 && a.hunger > 30) s.push({ action: 'eat', args: {}, label: 'Mangia qualcosa' });
    s.push({ action: 'wait', args: { s: 2 }, label: 'Riposa un momento' });
    return s;
  }

  private crowdPlan(a: Actor) {
    const s: PlanStep[] = [];
    for (let i = 0; i < 4; i++) {
      const target = this.freeNear(VILLAGE.x + Math.floor(this.r() * 11) - 5, VILLAGE.y + Math.floor(this.r() * 11) - 5);
      s.push({ action: 'walk_to', args: target, label: 'Passeggia' });
      s.push({ action: 'wait', args: { s: 2 + Math.floor(this.r() * 4) }, label: 'Chiacchiera' });
    }
    a.steps = s;
    a.current = 0;
    a.stepT = 0;
  }

  private pickOther(a: Actor): Actor | undefined {
    const list = [...this.actors.values()].filter((o) => o.id !== a.id && o.kind === 'agent');
    return list[Math.floor(this.r() * list.length)];
  }

  /** Group plans summarise what each member is about to do (who does what). */
  private groupPlans(only?: string) {
    for (const g of this.groups.values()) {
      if (only && g.id !== only) continue;
      const steps: PlanStep[] = [];
      const refs: GroupStepRef[] = [];
      for (const id of g.members) {
        const m = this.actors.get(id);
        if (!m) continue;
        if (g.pattern === 'crowd') {
          steps.push({ action: 'wander', args: { who: id }, label: 'Gira per il mercato' });
          refs.push({ who: id, src: 1, plan: m.steps, done: false });
          continue;
        }
        const own = m.steps.map((st, i) => ({ st, i })).filter(({ st }) => st.action !== 'walk_to').slice(0, 2);
        for (const { st, i } of own) {
          steps.push({ action: st.action, args: { ...st.args, who: id }, label: st.label });
          refs.push({ who: id, src: i, plan: m.steps, done: false });
        }
      }
      if (!steps.length) continue;
      const tracked = { refs, current: 0 };
      this.groupProgress.set(g.id, tracked);
      tracked.current = this.groupCurrent(tracked.refs);
      this.emit({ type: 'plan', id: g.id, scope: 'group', steps, current: tracked.current, reason: g.lastDecision?.summary ?? '', createdAt: Date.now() });
    }
  }

  /** First group step whose assigned member has not completed it yet. */
  private groupCurrent(refs: GroupStepRef[]): number {
    for (const r of refs) {
      const m = this.actors.get(r.who);
      // a step stays done once done; it only counts while the member still runs the plan it came from
      if (!r.done && m && m.steps === r.plan && m.current > r.src) r.done = true;
    }
    const i = refs.findIndex((r) => !r.done);
    return i === -1 ? refs.length : i;
  }

  /** Advance the active step of the member's group plan, if it moved. */
  private advanceGroup(a: Actor) {
    const tracked = a.groupId ? this.groupProgress.get(a.groupId) : undefined;
    if (!tracked) return;
    const cur = this.groupCurrent(tracked.refs);
    if (cur !== tracked.current) {
      tracked.current = cur;
      this.emit({ type: 'plan_progress', id: a.groupId!, current: cur });
    }
  }


  // ------------------------------------------------------------ simulation

  private tick() {
    const dt = (TICK_MS / 1000) * SPEED;
    this.elapsed += dt;
    this.advanceTime(dt);
    for (const a of this.actors.values()) {
      if (!a.alive) continue;
      a.hunger = clamp(a.hunger + dt * (this.rule('hunger.per_hour') / 60) * MINUTES_PER_SEC * 0.25, 0, 100);
      if (a.kind === 'player') this.movePlayer(a, dt);
      else if (this.elapsed >= a.busyUntil && this.elapsed >= a.thinkingUntil) this.runStep(a, dt);
    }
    this.chatterT -= dt;
    if (this.chatterT <= 0) {
      this.chatterT = 5 + this.r() * 5;
      this.chatter();
    }
    if (!this.rulesDone && this.elapsed > RULES_CHANGE_AT) {
      this.rulesDone = true;
      this.changeRule('wood.per_chop', 2, 'Gli alberi della valle si diradano: meno legna per albero.');
    }
    if (!this.winterDone && this.elapsed > WINTER_AT) {
      this.winterDone = true;
      this.startWinter();
    }
    this.emit({
      type: 'state',
      t: Date.now(),
      entities: [...this.actors.values()].map((a) => ({
        id: a.id,
        x: +a.x.toFixed(3),
        y: +a.y.toFixed(3),
        dir: a.dir,
        anim: a.anim,
        hp: Math.round(a.hp),
        hunger: Math.round(a.hunger),
        inventory: { ...a.inventory },
        alive: a.alive,
      })),
    });
  }

  private advanceTime(dt: number) {
    const before = Math.floor(this.time.minute);
    this.time.minute += dt * MINUTES_PER_SEC;
    if (this.time.minute >= 1440) {
      this.time.minute -= 1440;
      this.time.day += 1;
    }
    if (Math.floor(this.time.minute / 5) !== Math.floor(before / 5)) this.emit({ type: 'time', ...this.time, minute: Math.floor(this.time.minute) });
    // agents head home at dusk
    if (before < 20 * 60 && this.time.minute >= 20 * 60) {
      for (const a of this.actors.values()) if (a.kind === 'agent') this.think(a, 'Scende la notte: meglio rientrare.', this.r() * 2);
    }
  }

  private startWinter() {
    this.time.season = 'winter';
    this.emit({ type: 'time', ...this.time, minute: Math.floor(this.time.minute) });
    this.emit({ type: 'world_event', kind: 'season', text: 'È arrivato l’inverno. La neve copre la valle.' });
    this.emit({ type: 'lorebase', ...this.lorebase, revision: (this.lorebase.revision = 'b71e0d4') });
    for (const a of this.actors.values()) if (a.kind === 'agent') this.think(a, 'L’inverno è arrivato: servono legna e riparo.', this.r() * 3);
    const exp = this.groups.get('g-exp');
    if (exp) {
      exp.pattern = 'assembly';
      exp.name = 'Assemblea del Nord';
      exp.lastDecision = ASSEMBLY_DECISION;
      this.emit({ type: 'group', group: exp });
      this.emit({ type: 'world_event', kind: 'group', text: 'La spedizione si riunisce in assemblea e vota di restare.' });
    }
    setTimeout(() => this.groupPlans(), 5000 / SPEED);
  }

  private changeRule(key: string, value: RuleEditRequest['value'], why: string) {
    const rule = this.rules.find((r) => r.key === key);
    if (!rule) return;
    const old = rule.value;
    rule.value = value;
    const rev = Math.floor(this.r() * 0xfffffff).toString(16).padStart(7, '0');
    this.lorebase.revision = rev;
    this.emit({ type: 'rules_changed', revision: rev, changes: [{ key, old, new: value, text: rule.text }] });
    this.emit({ type: 'world_event', kind: 'rules', text: `Legge cambiata: ${rule.text} ${old} → ${value}. ${why}` });
    // a couple of agents react
    const reactors = [...this.actors.values()].filter((a) => a.kind === 'agent').slice(0, 3);
    reactors.forEach((a, i) =>
      setTimeout(() => this.emit({ type: 'say', from: a.id, to: 'all', text: i === 0 ? 'Le leggi sono cambiate. Dobbiamo rifare i conti.' : 'Allora cambio piano.', kind: 'speech' }), 800 + i * 1500),
    );
    if (reactors[1]) this.think(reactors[1], `Nuova legge: ${rule.text} = ${value}`, 1.5);
  }

  private faceTo(a: Actor, dx: number, dy: number) {
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;
    a.dir = (Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n') as Dir;
  }

  private runStep(a: Actor, dt: number) {
    const step = a.steps[a.current];
    if (!step) {
      if (a.kind === 'crowd') this.crowdPlan(a);
      else if (a.steps.length) this.think(a, 'Ho finito il piano: cosa viene dopo?');
      else if (this.elapsed >= a.thinkingUntil && a.thinkingUntil > 0) this.think(a, 'Riprendo da capo.');
      return;
    }
    const args = step.args as { x?: number; y?: number; s?: number; to?: string; text?: string };
    const next = () => {
      a.current++;
      a.stepT = 0;
      a.path = [];
      a.anim = 'idle';
      if (a.kind === 'agent') this.emit({ type: 'plan_progress', id: a.id, current: a.current });
      this.advanceGroup(a);
    };
    switch (step.action) {
      case 'walk_to':
      case 'carry_to': {
        if (a.stepT === 0) a.path = this.findPath(a, { x: args.x!, y: args.y! });
        a.stepT += dt;
        if (!this.followPath(a, dt)) {
          if (step.action === 'carry_to') {
            const t = this.tile(args.x!, args.y!);
            if (t && a.inventory.wood > 0) {
              t.wood += a.inventory.wood;
              a.inventory.wood = 0;
              this.emit({ type: 'tile', x: t.x, y: t.y, food: t.food, wood: t.wood, shelter: t.shelter });
            }
          }
          next();
        }
        break;
      }
      case 'chop':
      case 'gather':
      case 'build':
      case 'take': {
        a.anim = 'work';
        this.faceTo(a, args.x! - a.x, args.y! - a.y);
        a.stepT += dt;
        const dur = step.action === 'build' ? 5 : step.action === 'take' ? 1 : 2.6;
        if (a.stepT >= dur) {
          this.applyWork(a, step.action, args.x!, args.y!);
          next();
        }
        break;
      }
      case 'eat':
        a.anim = 'eat';
        a.stepT += dt;
        if (a.stepT >= 2) {
          if (a.inventory.food > 0) {
            a.inventory.food--;
            a.hunger = Math.max(0, a.hunger - 40);
          }
          next();
        }
        break;
      case 'say':
        if (a.stepT === 0) this.emit({ type: 'say', from: a.id, to: args.to ?? 'all', text: args.text ?? '…', kind: 'speech' });
        a.stepT += dt;
        if (a.stepT > 2.5) next();
        break;
      case 'sleep':
        a.anim = 'sleep';
        a.stepT += dt;
        a.hp = Math.min(a.maxHp, a.hp + dt);
        if (a.stepT >= (args.s ?? 10) && !(this.time.minute > 20 * 60 || this.time.minute < 6 * 60)) next();
        break;
      default:
        a.anim = 'idle';
        a.stepT += dt;
        if (a.stepT >= (args.s ?? 2)) next();
    }
  }

  /** Returns true while still walking. */
  private followPath(a: Actor, dt: number): boolean {
    const target = a.path[0];
    if (!target) return false;
    a.anim = 'walk';
    const dx = target.x - a.x;
    const dy = target.y - a.y;
    const d = Math.hypot(dx, dy);
    const stepLen = a.speed * dt;
    this.faceTo(a, dx, dy);
    if (d <= stepLen) {
      a.x = target.x;
      a.y = target.y;
      a.path.shift();
    } else {
      a.x += (dx / d) * stepLen;
      a.y += (dy / d) * stepLen;
    }
    return a.path.length > 0 || d > stepLen;
  }

  private applyWork(a: Actor, action: string, x: number, y: number) {
    const t = this.tile(x, y);
    if (!t) return;
    if (action === 'chop' && t.wood > 0) {
      const got = Math.min(t.wood, this.rule('wood.per_chop'));
      t.wood -= got;
      a.inventory.wood += got;
    } else if (action === 'gather' && t.food > 0) {
      const got = Math.min(t.food, this.rule('food.per_gather'));
      t.food -= got;
      a.inventory.food += got;
    } else if (action === 'take' && t.wood > 0) {
      const got = Math.min(t.wood, 4);
      t.wood -= got;
      a.inventory.wood += got;
    } else if (action === 'build') {
      if (a.inventory.wood > 0 || a.kind === 'player') {
        a.inventory.wood = Math.max(0, a.inventory.wood - 4);
        if (t.shelter < 2 && this.r() < 0.45) {
          t.shelter = (t.shelter + 1) as 1 | 2;
          this.emit({ type: 'world_event', kind: 'build', text: `${a.name} ha ${t.shelter === 1 ? 'alzato un riparo' : 'completato una capanna'}.`, at: { x, y } });
        }
      }
    } else return;
    this.emit({ type: 'tile', x: t.x, y: t.y, food: t.food, wood: t.wood, shelter: t.shelter });
  }

  private movePlayer(p: Actor, dt: number) {
    if (p.anim === 'work' && this.elapsed < p.busyUntil) return;
    const len = Math.hypot(p.vx, p.vy);
    if (len < 0.01) {
      if (p.anim === 'walk' || this.elapsed >= p.busyUntil) p.anim = 'idle';
      return;
    }
    const step = p.speed * dt;
    const nx = p.x + (p.vx / len) * step;
    const ny = p.y + (p.vy / len) * step;
    if (this.passable(nx, p.y)) p.x = nx;
    if (this.passable(p.x, ny)) p.y = ny;
    p.anim = 'walk';
    this.faceTo(p, p.vx, p.vy);
  }

  private playerAct(action: string, args: Record<string, unknown>) {
    const p = this.youId ? this.actors.get(this.youId) : undefined;
    if (!p) return;
    const x = Number(args.x ?? Math.round(p.x));
    const y = Number(args.y ?? Math.round(p.y));
    if (action === 'eat') {
      if (p.inventory.food > 0) {
        p.inventory.food--;
        p.hunger = Math.max(0, p.hunger - 40);
        p.anim = 'eat';
        p.busyUntil = this.elapsed + 1.2;
      }
      return;
    }
    if (action === 'give') {
      const to = this.actors.get(String(args.to));
      const item = args.item === 'wood' ? 'wood' : 'food';
      if (to && p.inventory[item] > 0) {
        p.inventory[item]--;
        to.inventory[item]++;
      }
      return;
    }
    p.anim = 'work';
    p.busyUntil = this.elapsed + 0.8;
    this.applyWork(p, action, x, y);
  }

  private chatter() {
    const agents = [...this.actors.values()].filter((a) => a.kind !== 'player' && a.alive && a.anim !== 'sleep');
    for (let i = 0; i < 12; i++) {
      const a = agents[Math.floor(this.r() * agents.length)];
      const b = agents.find((o) => o !== a && Math.hypot(o.x - a.x, o.y - a.y) < 4.5);
      if (!a || !b) continue;
      const [l1, l2] = CHATTER[Math.floor(this.r() * CHATTER.length)];
      this.emit({ type: 'say', from: a.id, to: b.id, text: l1, kind: 'speech' });
      setTimeout(() => this.emit({ type: 'say', from: b.id, to: a.id, text: l2, kind: 'speech' }), 2200);
      return;
    }
    // nobody close: someone thinks aloud
    const a = agents[Math.floor(this.r() * agents.length)];
    if (a?.kind === 'agent') this.emit({ type: 'say', from: a.id, to: 'all', text: THOUGHTS[Math.floor(this.r() * THOUGHTS.length)], kind: 'thought' });
  }

  private reply(to: string, text: string) {
    const a = this.actors.get(to);
    const p = this.youId ? this.actors.get(this.youId) : undefined;
    if (!a || !p) return;
    a.busyUntil = this.elapsed + 8;
    a.anim = 'idle';
    this.faceTo(a, p.x - a.x, p.y - a.y);
    this.emit({ type: 'thinking', id: a.id, on: true });
    const pool = REPLIES[a.role] ?? DEFAULT_REPLY;
    let answer = pool[Math.floor(this.r() * pool.length)];
    if (/legg|regol|law/i.test(text)) answer = `Le leggi le custodisce Lorebase. Oggi ogni albero dà ${this.rule('wood.per_chop')} legna, e d’inverno il freddo toglie ${this.rule('cold.damage_per_hour')} vita all’ora.`;
    else if (/ciao|salve|hello/i.test(text)) answer = `Ciao, ${p.name}! Sono ${a.name}. ${answer}`;
    const chunks = answer.match(/.{1,4}/gsu) ?? [answer];
    setTimeout(() => {
      this.emit({ type: 'thinking', id: a.id, on: false });
      chunks.forEach((c, i) =>
        setTimeout(() => this.emit({ type: 'say_delta', from: a.id, to: p.id, delta: c, done: i === chunks.length - 1 }), i * 45),
      );
    }, 900);
  }
}
