// The real-time game: runs the world loop, schedules decisions on events (never per second),
// runs group decisions, follows the laws in Lorebase, writes the Chronicle and speaks the
// WebSocket protocol (game/src/net/protocol.ts) to clients.
import type { RosterEntry, SimConfig } from '../config.ts';
import { ROOT } from '../config.ts';
import type { Conn } from '../http/ws.ts';
import { tokenMatches } from '../http/security.ts';
import { loadTemplates, type Translate, translator } from '../i18n.ts';
import { LorebaseClient } from '../lorebase/client.ts';
import { diffRules, type Role, type RoleChange, type Rule, type RuleChange, ruleValues } from '../lorebase/rules.ts';
import { RuleWatcher } from '../lorebase/watcher.ts';
import { cleanEntry, loadRosterFile, saveRosterFile, validateEntry, validateRoster } from '../roster.ts';
import type { Rules } from '../world/types.ts';
import { Brain } from './brain.ts';
import { type Catalog, Flows, unlocksOf } from './economy.ts';
import { EconomyBook } from './economy-book.ts';
import { type MemoryEvent, memoryKey, Mnemo } from './mnemo.ts';
import { Observatory, UsageLedger } from './observatory.ts';
import { Chronicle, type ChronicleEvent } from './chronicle.ts';
import { type Insight, InsightBook } from './insights.ts';
import { AGENT_PATTERNS, type GameConfig, type GroupPattern } from './config.ts';
import { type DecideHost, decide, reply, type ToolOutcome } from './decide.ts';
import { type Group, GroupManager, type JointPlan } from './groups.ts';
import { AgentMind, GroupMind, Limiter, type MindHost, type Perception } from './mind.ts';
import { type Plan, type PlanStep, tileOf } from './plan.ts';
import type { GroupView } from './prompt.ts';
import { missingRtRules, RT_RULE_KEYS, type Resource, type RtEntity, RtWorld, type WorldEvent } from './world.ts';

type Msg = Record<string, unknown> & { type: string };

interface PlayerConn {
  conn: Conn;
  entityId: string | null;
  speech: number[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

export class Game {
  readonly cfg: SimConfig;
  readonly game: GameConfig;
  readonly client: LorebaseClient;
  readonly t: Translate;
  readonly mock: boolean;
  world: RtWorld;
  roster: RosterEntry[] = [];
  private groups: GroupManager;
  private readonly watcher: RuleWatcher;
  private readonly chronicle: Chronicle;
  readonly brain: Brain;
  readonly insights: InsightBook;
  readonly mnemo: Mnemo;
  readonly economy: EconomyBook;
  private catalog: Catalog = { resources: new Map(), recipes: new Map(), techs: new Map() };
  private discovered = new Map<string, import('./economy.ts').Discovery>();
  private readonly flows = new Flows();
  readonly usage = new UsageLedger();
  /** Recent thoughts (plan reasons) and Lorebase consultations per agent, for god mode. */
  private readonly thoughts = new Map<string, Array<{ at: { day: number; minute: number }; text: string }>>();
  private readonly consults = new Map<string, Array<{ at: { day: number; minute: number }; tool: string; query: string }>>();
  readonly observatoryView: Observatory;
  private lastFlows: import('./economy.ts').FlowEdge[] = [];
  private lastFlowsMs = 0;
  private autoAcceptBusy = false;
  private laws: Rule[] = [];
  private roles: Role[] = [];
  private revision = '';
  private values: Rules = {};
  private readonly lawsSeen = new Map<string, Rule[]>();
  private readonly conns = new Map<number, PlayerConn>();
  private readonly listeners = new Set<(ev: unknown) => void>();
  private timer: NodeJS.Timeout | undefined;
  private lastTickMs = 0;
  private lastStateMs = 0;
  private lastTimeMs = 0;
  private lastStatusMs = 0;
  private readonly sent = new Map<string, string>();
  // minds: one loop per agent and per group
  private readonly minds = new Map<string, AgentMind>();
  private readonly groupMinds = new Map<string, GroupMind>();
  private readonly limiter: Limiter;
  private readonly stats = { decisions: 0, groupDecisions: 0, replies: 0, failures: 0 };
  /** Set while a reply is spoken, so a reply never triggers another reply. */
  private speakingReply = false;

  constructor(cfg: SimConfig, game: GameConfig) {
    this.cfg = cfg;
    this.game = game;
    this.t = translator(loadTemplates(ROOT, cfg.language));
    this.mock = cfg.forceMock || !process.env.ANTHROPIC_API_KEY;
    this.client = new LorebaseClient(cfg.lorebase.url, cfg.lorebase.domain);
    this.limiter = new Limiter(game.decisions.maxConcurrent);
    this.mnemo = new Mnemo(game.memory);
    this.brain = new Brain(game.brain, this.t, this.mnemo, cfg.lorebase.branch);
    this.economy = new EconomyBook(this.client, cfg.lorebase.branch, game.economy);
    this.observatoryView = new Observatory({
      client: this.client, mnemo: this.mnemo, branch: cfg.lorebase.branch, revision: () => this.revision, usage: this.usage,
      agents: () => this.world.living().filter((e) => e.kind === 'agent').map((e) => ({ id: e.id, name: e.name, key: memoryKey(e.name) })),
      stats: () => ({ ...this.stats, running: this.limiter.running }),
    }, game.observatory);
    this.world = this.newWorld();
    this.groups = this.newGroups();
    this.chronicle = new Chronicle(this.client, cfg.lorebase.branch, game.chronicle);
    this.insights = new InsightBook(this.client, cfg.lorebase.branch, game.insights, {
      changed: (insight, action, reviewer) => {
        if (action === 'accepted') this.brain.invalidate();
        this.broadcast({ type: 'insight', insight, action, ...(reviewer ? { reviewer } : {}) });
      },
    });
    const lb = cfg.lorebase;
    this.watcher = new RuleWatcher(this.client, { ruleKind: lb.ruleKind, roleKind: lb.roleKind, branch: lb.branch, pollMs: lb.pollMs, reconnectMs: lb.reconnectMs }, {
      onChange: (snap, changes, roleChanges, event) => this.applyRules(snap.rules, snap.roles, snap.revision, changes, roleChanges, event?.message),
      onStatus: (connected, detail) => {
        console.log(`[lorebase] ${connected ? 'connected' : 'disconnected'}: ${detail}`);
        this.broadcast(this.lorebaseMsg());
      },
    });
  }

  // ---- setup ------------------------------------------------------------------

  private newWorld(): RtWorld {
    const startMinute = 0;
    const w = new RtWorld(this.game.map, this.game.movement, this.cfg.seed, startMinute, {
      namePool: this.cfg.world.namePool, memoryItems: this.game.decisions.memoryItems, inboxItems: this.game.decisions.inboxItems,
    });
    w.roleOf = (code) => this.roles.find((r) => r.key === code);
    w.catalog = this.catalog;
    w.discovered = this.discovered;
    w.timeScale = this.game.loop.timeScale;
    w.minExperimentItems = this.game.economy.minExperimentItems;
    w.onEvent = (ev) => this.onWorldEvent(ev);
    return w;
  }

  private newGroups(): GroupManager {
    return new GroupManager(this.decideHost(), {
      changed: (g) => this.broadcastGroup(g),
      removed: (g) => {
        this.groupMinds.get(g.id)?.stop();
        this.groupMinds.delete(g.id);
        this.broadcast({ type: 'group_removed', id: g.id });
        this.event('group', this.t('rt.events.dissolved', { name: g.name }));
        this.chron('group_dissolved', this.t('rt.events.dissolved', { name: g.name }), []);
      },
      joined: (g, e) => {
        this.broadcastEntity(e);
        this.event('group', this.t('rt.events.joined', { name: e.name, group: g.name }), e);
        this.perceive(e, { kind: 'groupChanged' });
      },
      left: (g, e) => {
        this.broadcastEntity(e);
        this.event('group', this.t('rt.events.left', { name: e.name, group: g.name }), e);
        if (e.alive) this.perceive(e, { kind: 'groupChanged' });
      },
      formed: (g) => {
        const names = g.members.map((id) => this.world.entities.get(id)?.name ?? id);
        const text = this.t('rt.events.formed', { name: g.name, pattern: g.pattern, members: names.join(', ') });
        this.event('group', text);
        this.chron('group_formed', text, names);
        this.groupAwaken(g);
      },
    });
  }

  private decideHost(): DecideHost {
    return {
      world: () => this.world,
      t: this.t,
      cfg: this.game,
      sim: this.cfg,
      mock: this.mock,
      brain: this.brain,
      roleOf: (code) => this.roles.find((r) => r.key === code),
      roleTitle: (code) => this.roles.find((r) => r.key === code)?.title ?? code,
      groups: () => this.groupViews(),
      changedLaws: (e) => {
        const before = this.lawsSeen.get(e.id);
        this.lawsSeen.set(e.id, this.laws);
        return before ? diffRules(before, this.laws) : [];
      },
      say: (e, to, text) => this.world.say(e, to, text),
      formGroup: (e, name, pattern) => this.formGroup(e, name, pattern),
      joinGroup: (e, name) => this.joinGroup(e, name),
      leaveGroup: (e) => this.leaveGroup(e),
      shareInsight: async (e, text, confidence, evidence) => {
        const out = await this.insights.share({ name: e.name, role: e.role }, text, confidence, evidence, this.world.day, this.world.clock);
        if (typeof out === 'string') return { ok: false, text: this.t('rt.act.insightFailed', { reason: this.insightReason(out) }) };
        return { ok: true, text: this.t('rt.act.insightShared', { code: out.code }) };
      },
      reviewInsights: (e) => {
        const list = this.insights.pendingFor(e.role, e.name).slice(0, this.game.insights.listMax);
        return list.length ? list.map((i) => this.t('rt.act.insightLine', { code: i.code, text: i.text, author: i.author, confidence: i.confidence })).join('\n') : this.t('rt.act.insightNone');
      },
      judgeInsight: async (e, code, verdict, reason) => {
        const err = await this.insights.judge(code, { name: e.name, role: e.role }, verdict, reason);
        return err ? { ok: false, text: this.t('rt.act.insightJudgeFailed', { reason: this.insightReason(err) }) } : { ok: true, text: this.t('rt.act.insightJudged') };
      },
      ranModel: (who, res) => this.usage.track(who, res),
      deliberated: (g, memberId, role, text) => {
        const name = this.world.entities.get(memberId)?.name ?? memberId;
        this.broadcastPrivileged({ type: 'deliberation', groupId: g.id, pattern: g.pattern, member: memberId, role, text });
        this.mnemo.converse({ from: name, to: this.groups.groups.get(g.id)?.name ?? g.id, text, kind: 'deliberation', at: this.now(), groupId: g.id });
      },
      consulted: (e, ev) => {
        this.recent(this.consults, e.id, { at: this.now(), tool: ev.tool, query: ev.query });
        this.broadcastPrivileged({ type: 'consult', agentId: e.id, tool: ev.tool, query: ev.query });
      },
    };
  }

  private insightReason(code: string): string {
    const key = `rt.insightReason.${code}`;
    const text = this.t(key);
    return text === key ? code : text;
  }

  /** Connects to Lorebase (retrying until the laws load), populates the world, starts the loop. */
  async init(): Promise<void> {
    for (;;) {
      try {
        const snap = await this.watcher.start();
        this.applyRules(snap.rules, snap.roles, snap.revision, [], [], undefined, true);
        console.log(`[lorebase] ${snap.rules.length} rules and ${snap.roles.length} roles @ ${snap.revision.slice(0, 12)}`);
        const missing = missingRtRules(this.values);
        if (missing.length) throw new Error(`rules missing for the real-time world: ${missing.join(', ')} (run: npm run lorebase:seed)`);
        break;
      } catch (err) {
        console.error(`[lorebase] ${err instanceof Error ? err.message : err}; retrying in ${this.cfg.lorebase.pollMs} ms`);
        this.watcher.stop();
        await new Promise((r) => setTimeout(r, this.cfg.lorebase.pollMs));
      }
    }
    if (this.game.economy.enabled) await this.loadEconomy();
    this.world.clock = this.world.epoch = this.values.dawn_minute ?? 0;
    this.mnemo.follow((ev) => this.onMemory(ev));
    this.roster = loadRosterFile(this.cfg, this.roles.map((r) => r.key));
    this.populate();
    this.chronicle.start();
    await this.brain.connect();
    this.start();
  }

  /** Loads the economy catalog (retrying until Lorebase has it). */
  private async loadEconomy(): Promise<void> {
    for (;;) {
      try {
        const eco = await this.economy.load();
        if (!eco.catalog.resources.size) throw new Error('no Resource records (run: npm run lorebase:seed)');
        this.catalog = eco.catalog;
        this.discovered = eco.discovered;
        this.world.catalog = this.catalog;
        this.world.discovered = this.discovered;
        console.log(`[economy] ${this.catalog.resources.size} resources, ${this.catalog.recipes.size} recipes, ${this.catalog.techs.size} technologies (${this.discovered.size} discovered)`);
        return;
      } catch (err) {
        console.error(`[economy] ${err instanceof Error ? err.message : err}; retrying in ${this.cfg.lorebase.pollMs} ms`);
        await new Promise((r) => setTimeout(r, this.cfg.lorebase.pollMs));
      }
    }
  }

  /** Something a person lived: kept in its short-term memory and sent to its private memory (mnemo). */
  private live(e: RtEntity | undefined, key: string, text: string): void {
    if (!e || e.kind === 'player') return;
    this.world.remember(e, text);
    const ingest = this.game.memory.ingest[key];
    if (ingest && e.kind === 'agent') void this.mnemo.add(memoryKey(e.name), text, { ...ingest, at: { day: this.world.day, minute: this.world.minute }, source: key });
  }

  private onMemory(ev: MemoryEvent): void {
    const e = this.world.living().find((x) => x.kind === 'agent' && memoryKey(x.name) === ev.agentId);
    this.broadcastPrivileged({ type: 'memory', agentId: e?.id ?? ev.agentId, action: ev.action, memory: memoryDto(ev.memory), ...(ev.mergedFrom ? { mergedFrom: ev.mergedFrom } : {}) });
  }

  private itemName(code: string): string {
    return this.catalog.resources.get(code)?.name ?? code;
  }

  private bagText(bag: Record<string, number>): string {
    return Object.entries(bag).map(([k, n]) => `${n} ${this.itemName(k)}`).join(', ');
  }

  private populate(): void {
    for (const entry of this.roster) this.spawnAgent(entry);
    const crowd = this.game.crowd;
    const extras: RtEntity[] = [];
    for (let i = 0; i < crowd.count; i++) {
      const name = crowd.names.find((n) => !this.world.nameTaken(n)) ?? `${crowd.groupName} ${i + 1}`;
      const role = crowd.roles[i % crowd.roles.length] ?? this.roles[0]?.key ?? 'gatherer';
      extras.push(this.world.spawn({ name, role, tier: crowd.tier, model: this.modelFor({ tier: crowd.tier }), kind: 'crowd', personality: crowd.personality }));
    }
    if (extras.length) this.groups.create(crowd.groupName, 'crowd', extras, null);
    for (const s of this.game.groups.seeded) {
      const members = s.members.map((n) => this.world.find(n)).filter((m): m is RtEntity => !!m && !m.groupId);
      if (members.length < this.game.groups.minMembers) continue;
      const leader = s.leader ? (members.find((m) => m.name === s.leader) ?? members[0]!) : null;
      this.groups.create(s.name, s.pattern, members, leader);
    }
    // Every person starts its own mind; group members hand their thoughts to the group's mind.
    for (const e of this.world.living()) this.awaken(e);
  }

  modelFor(entry: Pick<RosterEntry, 'tier' | 'model'>): string {
    return this.cfg.modelOverride ?? entry.model ?? this.cfg.models[entry.tier];
  }

  private spawnAgent(entry: RosterEntry): RtEntity {
    const e = this.world.spawn({ id: entry.id, name: entry.name, role: entry.role, tier: entry.tier, model: this.modelFor(entry), kind: 'agent', personality: entry.personality });
    this.lawsSeen.set(e.id, this.laws);
    return e;
  }

  start(): void {
    if (this.timer) return;
    this.lastTickMs = Date.now();
    this.timer = setInterval(() => this.tick(), Math.max(1, Math.round(1000 / this.game.loop.tickHz)));
  }

  stopLoop(): void {
    for (const id of [...this.minds.keys()]) this.sleep(id);
    for (const m of this.groupMinds.values()) m.stop();
    this.groupMinds.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async shutdown(): Promise<void> {
    this.stopLoop();
    this.watcher.stop();
    await this.brain.close();
    this.mnemo.stop();
    await this.chronicle.stop();
  }

  // ---- rules ------------------------------------------------------------------

  private applyRules(rules: Rule[], roles: Role[], revision: string, changes: RuleChange[], roleChanges: RoleChange[], message?: string, initial = false): void {
    const before = new Map(this.laws.map((r) => [r.key, r]));
    const values = ruleValues(rules);
    this.values = { ...this.values, ...values };
    this.world.rules = this.values;
    this.laws = rules;
    this.roles = roles;
    this.revision = revision;
    if (initial) return;
    this.brain.invalidate();
    console.log(`[lorebase] rules_changed @ ${revision.slice(0, 12)}${message ? ` "${message}"` : ''}: ${changes.map((c) => `${c.key} ${c.old} -> ${c.new}`).join(', ') || 'no rule value change'}${roleChanges.length ? `; roles: ${roleChanges.map((r) => r.key).join(', ')}` : ''}`);
    this.broadcast({
      type: 'rules_changed', revision, changes: changes.map((c) => {
        const r = rules.find((x) => x.key === c.key) ?? before.get(c.key);
        return { key: c.key, old: c.old, new: c.new, text: c.text, ...(c.new === null ? { removed: true } : {}), ...(r ? { category: r.category, unit: r.unit } : {}) };
      }),
    });
    this.broadcast(this.lorebaseMsg());
    if (changes.length) {
      const list = changes.map((c) => `${c.key} ${c.old ?? '-'} → ${c.new ?? '-'}`).join(', ');
      const text = this.t('rt.events.rules', { changes: list });
      this.event('rules', text);
      this.chron('laws_changed', text, []);
      this.perceiveAll({ kind: 'rules' });
    }
  }

  // ---- loop -------------------------------------------------------------------

  private tick(): void {
    const now = Date.now();
    const dt = Math.min(1, (now - this.lastTickMs) / 1000);
    this.lastTickMs = now;
    try {
      this.world.step(dt, now);
    } catch (err) {
      console.error('world step failed', err);
    }
    for (const e of [...this.world.entities.values()]) {
      if (!e.alive && e.diedAtMs !== undefined && now - e.diedAtMs > this.game.loop.deadLingerMs) {
        this.world.entities.delete(e.id);
        this.sent.delete(e.id);
        this.broadcast({ type: 'entity_removed', id: e.id, reason: 'death' });
      }
    }
    if (now - this.lastStateMs >= 1000 / this.game.loop.stateHz) {
      this.lastStateMs = now;
      this.sendState();
    }
    if (now - this.lastFlowsMs >= this.game.economy.flowsMs) {
      if (this.lastFlowsMs) {
        this.lastFlows = this.flows.take();
        this.broadcast({ type: 'flows', window: Math.round((now - this.lastFlowsMs) / 1000), edges: this.lastFlows });
      }
      this.lastFlowsMs = now;
    }
    if (now - this.lastTimeMs >= this.game.loop.timeBroadcastMs) {
      this.lastTimeMs = now;
      this.broadcast({ type: 'time', ...this.timeDto() });
    }
    if (now - this.lastStatusMs >= this.game.loop.statusLogMs) {
      this.lastStatusMs = now;
      if (!this.autoAcceptBusy) {
        this.autoAcceptBusy = true;
        const living = (role: string) => this.world.living().filter((e) => e.kind !== 'player' && e.role === role).length;
        void this.insights.autoAccept(this.world.clock, living).finally(() => (this.autoAcceptBusy = false));
      }
      const living = this.world.living();
      console.log(`[game] day ${this.world.day} ${this.world.clockText()} ${this.world.season()} pop ${living.length} groups ${this.groups.list().length} decisions ${this.stats.decisions}+${this.stats.groupDecisions}g replies ${this.stats.replies} failures ${this.stats.failures} running ${this.limiter.running} lorebase-mcp ${this.brain.calls} calls/${this.brain.cacheHits} cached chronicle ${this.chronicle.written} written/${this.chronicle.pending} pending`);
    }
  }

  private sendState(): void {
    const changed: Msg[] = [];
    for (const e of this.world.entities.values()) {
      const d = this.deltaDto(e);
      const key = JSON.stringify(d);
      if (this.sent.get(e.id) === key) continue;
      this.sent.set(e.id, key);
      changed.push(d);
    }
    if (changed.length) this.broadcast({ type: 'state', t: Date.now(), entities: changed });
  }

  // ---- world events -------------------------------------------------------------

  private onWorldEvent(ev: WorldEvent): void {
    const w = this.world;
    const t = this.t;
    switch (ev.type) {
      case 'step':
        this.broadcast({ type: 'plan_progress', id: ev.id, current: ev.current });
        break;
      case 'plan_done': {
        this.perceive(w.entities.get(ev.id), { kind: 'planDone' });
        break;
      }
      case 'step_failed': {
        const e = w.entities.get(ev.id);
        const step = e?.plan?.steps[ev.step];
        if (!e || !step) break;
        const reason = t(`rt.reason.${ev.reason}`);
        this.live(e, 'stepFailed', t('rt.memory.failed', { label: step.label, reason }));
        this.perceive(e, { kind: 'stepFailed', label: step.label, reason });
        break;
      }
      case 'say':
        this.onSay(ev.from, ev.to, ev.text, ev.hearers);
        break;
      case 'tile':
        this.broadcast({ type: 'tile', ...this.tileDto(ev.tile) });
        break;
      case 'craft': {
        const e = w.entities.get(ev.id);
        this.broadcast({ type: 'craft', by: ev.id, recipe: ev.recipe, inputs: ev.inputs, outputs: ev.outputs, at: ev.at });
        this.live(e, 'craft', t('rt.memory.crafted', { outputs: this.bagText(ev.outputs), inputs: this.bagText(ev.inputs) }));
        break;
      }
      case 'experiment':
        this.onExperiment(ev.id, ev.items, ev.found);
        break;
      case 'decay': {
        const e = w.entities.get(ev.id);
        this.broadcast({ type: 'decay', id: ev.id, item: ev.item, amount: ev.amount, reason: ev.reason });
        if (e && ev.reason !== 'spoiled') this.live(e, 'decay', t('rt.memory.decayed', { amount: ev.amount, item: this.itemName(ev.item), reason: t(`rt.events.${ev.reason}`) }));
        break;
      }
      case 'used':
        break;
      case 'death': {
        const e = w.entities.get(ev.id);
        if (!e) break;
        this.sleep(e.id);
        this.groups.leave(e);
        const text = t('rt.events.death', { name: e.name, cause: t(`rt.events.cause_${ev.cause}`) });
        this.event('death', text, e);
        this.chron('death', text, [e.name]);
        break;
      }
      case 'birth': {
        const [a, b] = ev.parents.map((id) => w.entities.get(id)?.name ?? id);
        ev.child.personality = t('rt.events.childOf', { a: a!, b: b! });
        this.lawsSeen.set(ev.child.id, this.laws);
        const text = t('rt.events.birth', { name: ev.child.name, a: a!, b: b! });
        this.broadcast({ type: 'entity_added', entity: this.entityDto(ev.child) });
        this.event('birth', text, ev.child);
        this.chron('birth', text, [ev.child.name, a!, b!]);
        this.awaken(ev.child);
        break;
      }
      case 'build': {
        const e = w.entities.get(ev.id);
        this.event('build', t('rt.events.build', { name: e?.name ?? ev.id, x: ev.x, y: ev.y, level: ev.level }), { x: ev.x, y: ev.y });
        break;
      }
      case 'gave': {
        const a = w.entities.get(ev.from);
        const b = w.entities.get(ev.to);
        if (!a || !b) break;
        const res = this.itemName(ev.resource);
        this.live(a, 'gift', t('rt.memory.gave', { amount: ev.amount, resource: res, name: b.name }));
        this.live(b, 'gift', t('rt.memory.got', { amount: ev.amount, resource: res, name: a.name }));
        this.broadcast({ type: 'trade', from: a.id, to: b.id, give: { [ev.resource]: ev.amount }, get: {}, kind: 'gift' });
        this.flows.add(a.role, b.role, ev.resource, ev.amount);
        break;
      }
      case 'critical': {
        this.perceive(w.entities.get(ev.id), { kind: 'critical', what: ev.what });
        break;
      }
      case 'season':
        this.event('season', t('rt.events.season', { season: t(`season.${ev.season}`) }));
        this.broadcast({ type: 'time', ...this.timeDto() });
        this.perceiveAll({ kind: 'season', season: ev.season });
        break;
      case 'night':
        this.event('season', t(ev.night ? 'rt.events.night' : 'rt.events.dawn'));
        this.perceiveAll({ kind: 'night', night: ev.night });
        break;
    }
  }

  private onSay(fromId: string, to: string, text: string, hearers: string[]): void {
    const w = this.world;
    const from = w.entities.get(fromId);
    if (!from) return;
    // The speaking player already knows what it said: never echo it back.
    const exclude = from.kind === 'player' ? fromId : undefined;
    this.broadcast({ type: 'say', from: fromId, to, text, kind: 'speech' }, exclude);
    this.mnemo.converse({ from: from.name, to: w.entities.get(to)?.name ?? 'all', text, kind: 'speech', at: this.now() });
    if (from.kind !== 'player') w.remember(from, this.t('rt.memory.said', { to: w.entities.get(to)?.name ?? this.t('rt.memory.everyone'), text }));
    for (const id of hearers) {
      const h = w.entities.get(id);
      if (h && h.kind !== 'player') this.live(h, 'heard', this.t('rt.memory.heard', { from: from.name, text }));
    }
    // A person addressed directly by another agent answers (players get their reply in `speak`).
    const target = w.entities.get(to);
    if (!this.speakingReply && from.kind !== 'player' && target && target.alive && target.kind !== 'player' && hearers.includes(target.id) && this.game.conversation.agentReplyDepth > 0) {
      this.perceive(target, { kind: 'spokenTo', from });
    }
  }

  // ---- minds (each agent and each group runs its own loop) --------------------------

  private mindHost(): MindHost {
    const host = this.decideHost();
    return {
      cfg: this.game,
      world: () => this.world,
      limiter: this.limiter,
      stats: this.stats,
      why: (p) => this.why(p),
      decide: (e, why) => decide(host, e, why),
      reply: (e, speaker, onDelta) => reply(host, e, speaker, onDelta),
      commitPlan: (e, d) => {
        this.setPlan(e, d.steps, d.reason, 'entity');
        this.live(e, 'planned', this.t('rt.memory.planned', { reason: d.reason }));
        if (d.reason) {
          this.broadcastPrivileged({ type: 'say', from: e.id, to: 'all', text: d.reason, kind: 'thought' });
          this.recent(this.thoughts, e.id, { at: this.now(), text: d.reason });
          this.mnemo.converse({ from: e.name, to: e.name, text: d.reason, kind: 'thought', at: this.now() });
        }
      },
      thinking: (id, on) => this.broadcast({ type: 'thinking', id, on }),
      replyDelta: (from, to, delta, done) => this.broadcast({ type: 'say_delta', from: from.id, to: to.id, delta, done }),
      sayReply: (from, to, text) => {
        const max = this.game.decisions.textMaxChars;
        this.speakingReply = true;
        try {
          if (!this.world.say(from, to.id, text.slice(0, max)).ok) this.world.say(from, 'all', text.slice(0, max));
        } finally {
          this.speakingReply = false;
        }
      },
      groupMind: (e) => {
        const g = this.groups.of(e);
        return g && this.groups.active(g) ? this.groupMinds.get(g.id) : undefined;
      },
      decideGroup: (g, why) => this.groups.decide(g, why),
      commitJointPlan: (g, plan) => {
        if (this.groups.groups.has(g.id)) this.applyJointPlan(g, plan);
      },
      groupFailed: (m) => this.minds.get(m.id)?.perceive({ kind: 'groupFailed' }),
    };
  }

  /** An experiment: maybe a discovery, which becomes knowledge of the whole civilization in Lorebase. */
  private onExperiment(id: string, items: string[], found: { tech: import('./economy.ts').TechDef } | undefined): void {
    const t = this.t;
    const w = this.world;
    const e = w.entities.get(id);
    if (!e) return;
    const names = items.map((i) => this.itemName(i)).join(' + ');
    if (!found || this.discovered.has(found.tech.code)) {
      this.live(e, 'experiment', t('rt.memory.experimented', { items: names }));
      return;
    }
    const tech = found.tech;
    const d = { by: e.name, role: e.role, day: w.day, minute: w.minute };
    this.discovered.set(tech.code, d);
    const unlocks = unlocksOf(this.catalog, tech.code);
    const recipes = unlocks.map((c) => this.catalog.recipes.get(c)!).filter(Boolean);
    this.economy.record(tech, recipes, d, this.chronicle.session);
    this.brain.invalidate();
    const text = t('rt.events.discovery', { name: e.name, role: this.roles.find((r) => r.key === e.role)?.title ?? e.role, tech: tech.name, recipes: recipes.map((r) => r.name).join(', ') });
    this.broadcast({ type: 'discovery', tech: { code: tech.code, name: tech.name, description: tech.description, unlocks }, by: e.id, role: e.role, at: tileOf(e) });
    this.event('rules', text, e);
    this.chron('discovery', text, [e.name]);
    this.live(e, 'discovery', t('rt.memory.discovered', { tech: tech.name, items: names }));
    if (this.game.economy.insightOnDiscovery && e.kind === 'agent') {
      void this.insights.share({ name: e.name, role: e.role }, t('rt.mock.discoveryInsight', { items: names, tech: tech.name }), 1, t('rt.memory.discovered', { tech: tech.name, items: names }), w.day, w.clock);
    }
  }

  private why(p: Perception): string {
    const t = this.t;
    switch (p.kind) {
      case 'start':
        return t('rt.why.start');
      case 'planDone':
        return t('rt.why.planExhausted');
      case 'stepFailed':
        return t('rt.why.stepFailed', { label: p.label, reason: p.reason });
      case 'spokenTo':
        return t('rt.why.spokenTo', { name: p.from.name });
      case 'conversation':
        return t('rt.why.conversation', { name: p.with.name });
      case 'critical':
        return t(`rt.why.critical_${p.what}`);
      case 'night':
        return t(p.night ? 'rt.why.nightfall' : 'rt.why.dawn');
      case 'season':
        return t('rt.why.seasonChange', { season: t(`season.${p.season}`) });
      case 'rules':
        return t('rt.why.rulesChanged');
      case 'groupChanged':
      case 'groupFailed':
        return t('rt.why.groupChanged');
    }
  }

  /** Gives a person a mind of its own (its loop starts at once). */
  private awaken(e: RtEntity): void {
    if (e.kind === 'player' || this.minds.has(e.id)) return;
    const mind = new AgentMind(e, this.mindHost());
    this.minds.set(e.id, mind);
    void mind.run().finally(() => {
      if (this.minds.get(e.id) === mind) this.minds.delete(e.id);
    });
    mind.perceive({ kind: 'start' });
  }

  private sleep(id: string): void {
    this.minds.get(id)?.stop();
    this.minds.delete(id);
  }

  private groupAwaken(g: Group): void {
    if (this.groupMinds.has(g.id)) return;
    const mind = new GroupMind(g, this.mindHost());
    this.groupMinds.set(g.id, mind);
    void mind.run();
  }

  /** Delivers a perception to one person (the world is only the messenger). */
  private perceive(e: RtEntity | undefined, p: Perception): void {
    if (e) this.minds.get(e.id)?.perceive(p);
  }

  /** Something everyone experiences (night, season, new laws). */
  private perceiveAll(p: Perception): void {
    for (const mind of this.minds.values()) mind.perceive(p);
  }

  private applyJointPlan(g: Group, plan: JointPlan): void {
    g.lastDecision = { summary: plan.summary, trace: plan.trace };
    g.memory.push(`[g${this.world.day} ${this.world.clockText()}] ${plan.summary}`);
    if (g.memory.length > this.game.decisions.memoryItems) g.memory.splice(0, g.memory.length - this.game.decisions.memoryItems);
    const now = Date.now();
    this.broadcastGroup(g);
    this.broadcastPlan({ type: 'plan', id: g.id, scope: 'group', steps: plan.steps, current: 0, reason: plan.summary, createdAt: now });
    for (const id of g.members) {
      const m = this.world.entities.get(id);
      if (!m || !m.alive) continue;
      const mine = plan.steps.filter((s) => s.args.who === id);
      if (!mine.length) continue;
      this.setPlan(m, mine, plan.summary, 'entity');
      this.world.remember(m, this.t('rt.memory.groupPlan', { group: g.name, summary: plan.summary }));
    }
    if (g.pattern !== 'crowd') this.event('group', this.t('rt.events.decided', { name: g.name, summary: plan.summary }));
  }

  private setPlan(e: RtEntity, steps: PlanStep[], reason: string, scope: 'entity' | 'group'): void {
    const plan: Plan = { id: e.id, scope, steps, current: 0, reason, createdAt: Date.now() };
    e.plan = plan;
    e.activity = undefined;
    this.broadcastPlan({ type: 'plan', id: e.id, scope, steps, current: 0, reason, createdAt: plan.createdAt });
  }

  // ---- groups (agent tools) ------------------------------------------------------

  private formGroup(e: RtEntity, name: string, pattern: string): ToolOutcome {
    const t = this.t;
    if (!AGENT_PATTERNS.includes(pattern as GroupPattern)) return { ok: false, text: t('rt.act.badGroup', { reason: pattern }) };
    if (e.groupId) this.groups.leave(e);
    const g = this.groups.create(name, pattern as GroupPattern, [e], e);
    if (typeof g === 'string') return { ok: false, text: t('rt.act.badGroup', { reason: g }) };
    this.world.remember(e, t('rt.memory.formed', { group: g.name }));
    this.broadcastEntity(e);
    return { ok: true, text: t('rt.act.formed', { name: g.name }) };
  }

  private joinGroup(e: RtEntity, name: string): ToolOutcome {
    const t = this.t;
    const g = this.groups.byName(name);
    if (!g || g.pattern === 'crowd') return { ok: false, text: t('rt.act.noSuchGroup', { name }) };
    const err = this.groups.join(g, e);
    if (err) return { ok: false, text: t('rt.act.groupFull', { name: g.name }) };
    this.world.remember(e, t('rt.memory.joined', { group: g.name }));
    return { ok: true, text: t('rt.act.joined', { name: g.name }) };
  }

  private leaveGroup(e: RtEntity): ToolOutcome {
    const g = this.groups.of(e);
    if (!g) return { ok: false, text: this.t('rt.act.noGroup') };
    this.groups.leave(e);
    this.world.remember(e, this.t('rt.memory.left', { group: g.name }));
    return { ok: true, text: this.t('rt.act.left', { name: g.name }) };
  }

  // ---- players (WebSocket) -------------------------------------------------------

  onOpen(conn: Conn): void {
    this.conns.set(conn.id, { conn, entityId: null, speech: [] });
    conn.send(this.hello(null, this.privileged(conn)));
  }

  onClose(conn: Conn): void {
    const pc = this.conns.get(conn.id);
    this.conns.delete(conn.id);
    const e = pc?.entityId ? this.world.entities.get(pc.entityId) : undefined;
    if (!e) return;
    this.groups.leave(e);
    this.world.entities.delete(e.id);
    this.sent.delete(e.id);
    this.broadcast({ type: 'entity_removed', id: e.id, reason: 'left' });
    const text = this.t('rt.events.departed', { name: e.name });
    this.event('group', text);
    this.chron('departure', text, [e.name]);
  }

  onMessage(conn: Conn, raw: unknown): void {
    const pc = this.conns.get(conn.id);
    if (!pc || !raw || typeof raw !== 'object') return;
    const msg = raw as Record<string, unknown>;
    const me = pc.entityId ? this.world.entities.get(pc.entityId) : undefined;
    switch (msg.type) {
      case 'join':
        return this.join(pc, msg);
      case 'input': {
        if (!me || !me.alive) return;
        let dx = Number(msg.dx);
        let dy = Number(msg.dy);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        const len = Math.hypot(dx, dy);
        const max = this.game.player.inputMax;
        if (len > max) {
          dx = (dx / len) * max;
          dy = (dy / len) * max;
        }
        me.input = { dx, dy };
        return;
      }
      case 'act':
        if (me && me.alive) this.playerAct(pc, me, String(msg.action ?? ''), (msg.args && typeof msg.args === 'object' ? msg.args : {}) as Record<string, unknown>);
        return;
      case 'speak':
        if (me && me.alive) this.playerSpeak(pc, me, String(msg.to ?? ''), String(msg.text ?? ''));
        return;
    }
  }

  private join(pc: PlayerConn, msg: Record<string, unknown>): void {
    const p = this.game.player;
    if (pc.entityId && this.world.entities.get(pc.entityId)?.alive) return void pc.conn.send(this.hello(pc.entityId, this.privileged(pc.conn)));
    if (!pc.conn.authorized && !tokenMatches(typeof msg.token === 'string' ? msg.token : undefined, this.cfg.apiToken)) {
      pc.conn.send({ type: 'world_event', kind: 'group', text: 'unauthorized' });
      return void pc.conn.close(4401, 'unauthorized');
    }
    pc.conn.authorized = true;
    const players = [...this.conns.values()].filter((c) => c.entityId).length;
    if (players >= p.maxPlayers) return void pc.conn.send({ type: 'world_event', kind: 'group', text: 'world full' });
    let name = String(msg.name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, p.nameMaxChars) || 'Viandante';
    for (let i = 2; this.world.nameTaken(name); i++) name = `${name.replace(/ \d+$/, '')} ${i}`;
    const role = this.roles.some((r) => r.key === msg.role) ? String(msg.role) : (this.roles[0]?.key ?? 'gatherer');
    const e = this.world.spawn({ name, role, tier: 'human', model: 'human', kind: 'player' });
    pc.entityId = e.id;
    pc.conn.send(this.hello(e.id, this.privileged(pc.conn)));
    this.broadcast({ type: 'entity_added', entity: this.entityDto(e) }, undefined, pc.conn.id);
    const text = this.t('rt.events.arrived', { name });
    this.event('birth', text, e);
    this.chron('arrival', text, [name]);
  }

  private playerAct(pc: PlayerConn, e: RtEntity, action: string, args: Record<string, unknown>): void {
    const w = this.world;
    const here = tileOf(e);
    const at = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y)) ? { x: Math.round(Number(args.x)), y: Math.round(Number(args.y)) } : here;
    if (Math.hypot(at.x - e.x, at.y - e.y) > this.game.movement.interactRange) return this.actFailed(pc, e, 'too_far');
    let out;
    switch (action) {
      case 'gather':
        out = w.gather(e, typeof args.item === 'string' && args.item ? args.item : 'food', at);
        break;
      case 'craft':
        out = w.craft(e, String(args.recipe ?? ''));
        break;
      case 'experiment':
        out = w.experiment(e, Array.isArray(args.items) ? args.items.map(String) : [], this.game.economy.minExperimentItems);
        break;
      case 'use':
        out = w.use(e, String(args.item ?? ''));
        break;
      case 'chop':
        out = w.gather(e, 'wood', at);
        break;
      case 'build':
        out = w.build(e, at);
        break;
      case 'eat':
        out = w.eat(e);
        break;
      case 'give': {
        const item: Resource = typeof args.item === 'string' && args.item ? args.item : 'food';
        out = w.give(e, String(args.to ?? ''), item, Math.max(1, Math.floor(Number(args.amount) || 1)));
        break;
      }
      default:
        return;
    }
    if (!out.ok) return this.actFailed(pc, e, out.reason ?? 'failed');
    e.anim = action === 'eat' ? 'eat' : 'work';
    e.busyUntilMinute = w.clock + (action === 'build' ? w.r('build_minutes') : action === 'eat' ? w.r('eat_minutes') : w.r('gather_minutes')) / Math.max(1e-6, w.workSpeedOf(e));
  }

  private actFailed(pc: PlayerConn, e: RtEntity, reason: string): void {
    pc.conn.send({ type: 'say', from: e.id, to: e.id, text: this.t(`rt.reason.${reason}`), kind: 'thought' });
  }

  private playerSpeak(pc: PlayerConn, e: RtEntity, to: string, text: string): void {
    const p = this.game.player;
    const clean = text.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, p.speechMaxChars);
    if (!clean) return;
    const now = Date.now();
    pc.speech = pc.speech.filter((ts) => now - ts < 60_000);
    if (pc.speech.length >= p.speechPerMinute || (pc.speech.length && now - pc.speech.at(-1)! < p.speechMinIntervalMs)) {
      return void pc.conn.send({ type: 'say', from: e.id, to: e.id, text: this.t('rt.reason.failed'), kind: 'thought' });
    }
    pc.speech.push(now);
    const target = to && to !== 'all' ? this.world.find(to) : undefined;
    const out = this.world.say(e, target ? target.id : 'all', clean);
    if (!out.ok) return this.actFailed(pc, e, out.reason ?? 'failed');
    if (target && target.alive && target.kind !== 'player') this.perceive(target, { kind: 'spokenTo', from: e });
  }

  // ---- DTOs -------------------------------------------------------------------------

  private groupViews(): GroupView[] {
    return this.groups.list().map((g) => ({ id: g.id, name: g.name, pattern: g.pattern, members: g.members }));
  }

  timeDto() {
    return { day: this.world.day, minute: this.world.minute, season: this.world.season() };
  }

  entityDto(e: RtEntity) {
    return {
      id: e.id, name: e.name, role: e.role, tier: e.tier, model: e.model, kind: e.kind, groupId: e.groupId,
      x: r2(e.x), y: r2(e.y), dir: e.dir, anim: e.anim, hp: r1(e.hp), maxHp: e.maxHp, hunger: r1(e.hunger),
      inventory: { ...e.inventory }, tools: e.tools.map((x) => ({ ...x })), speed: e.alive ? this.world.speedOf(e) : 0, alive: e.alive,
    };
  }

  private deltaDto(e: RtEntity): Msg {
    return { id: e.id, x: r2(e.x), y: r2(e.y), dir: e.dir, anim: e.anim, hp: r1(e.hp), hunger: r1(e.hunger), inventory: { ...e.inventory }, tools: e.tools.map((x) => ({ item: x.item, durability: r1(x.durability), max: x.max })), alive: e.alive } as unknown as Msg;
  }

  /** `full: false` hides how the group deliberated (the trace), keeping only what it decided. */
  groupDto(g: Group, full = true) {
    const last = g.lastDecision ? (full ? g.lastDecision : { summary: g.lastDecision.summary, trace: [] }) : undefined;
    return { id: g.id, name: g.name, pattern: g.pattern, members: [...g.members], leader: g.leader, color: g.color, ...(last ? { lastDecision: last } : {}) };
  }

  /** Whether a connection may see god-mode content (always, when no token is configured). */
  private privileged(conn: Conn): boolean {
    return !this.cfg.apiToken || conn.authorized;
  }

  /** A plan: its reason (the agent's reasoning) only to privileged connections; others get `reason: ''`. */
  private broadcastPlan(msg: Msg): void {
    if (!this.cfg.apiToken) return this.broadcast(msg);
    const open: Msg = { ...msg, reason: '' };
    for (const pc of this.conns.values()) pc.conn.send(pc.conn.authorized ? msg : open);
    for (const fn of this.listeners) {
      try {
        fn(msg);
      } catch {
        // a broken listener never stops the world
      }
    }
  }

  /** A group update: the deliberation trace only to privileged connections. */
  private broadcastGroup(g: Group): void {
    if (!this.cfg.apiToken) return this.broadcast({ type: 'group', group: this.groupDto(g) });
    const full: Msg = { type: 'group', group: this.groupDto(g, true) };
    const open: Msg = { type: 'group', group: this.groupDto(g, false) };
    for (const pc of this.conns.values()) pc.conn.send(pc.conn.authorized ? full : open);
    for (const fn of this.listeners) {
      try {
        fn(full);
      } catch {
        // a broken listener never stops the world
      }
    }
  }

  private lorebaseMsg(): Msg {
    return { type: 'lorebase', connected: this.watcher.connected, branch: this.cfg.lorebase.branch, revision: this.revision };
  }

  hello(you: string | null, full = true): Msg {
    const w = this.world;
    return {
      type: 'hello',
      you: you ? { entityId: you } : null,
      map: { w: w.width, h: w.height, tiles: w.tiles.map((t) => ({ biome: t.biome, elev: t.elev, ...this.tileDto(t) })) },
      entities: [...w.entities.values()].map((e) => this.entityDto(e)),
      groups: this.groups.list().map((g) => this.groupDto(g, full)),
      rules: this.laws.map((r) => ({ key: r.key, value: r.value, text: r.text, category: r.category, unit: r.unit })),
      time: this.timeDto(),
      roles: this.roles.map((r) => r.key),
      lorebase: { connected: this.watcher.connected, branch: this.cfg.lorebase.branch, revision: this.revision },
      economy: this.economyDto(),
    };
  }

  private tileDto(t: import('./world.ts').RtTile) {
    return { x: t.x, y: t.y, food: t.food, wood: t.wood, shelter: Math.min(2, t.shelter), ...(Object.keys(t.structures).length ? { structures: { ...t.structures } } : {}) };
  }

  /** What the civilization knows: undiscovered technologies show as '???', their recipes are counted, not listed. */
  economyDto() {
    const known = (tech: string | null) => !tech || this.discovered.has(tech);
    const recipes = [...this.catalog.recipes.values()];
    return {
      resources: [...this.catalog.resources.values()].map((r) => ({ code: r.code, name: r.name, perishable: r.perishable })),
      recipes: recipes.filter((r) => known(r.tech)).map((r) => ({ code: r.code, name: r.name, inputs: r.inputs, outputs: r.outputs, role: r.role ?? '', tech: r.tech, station: r.station })),
      techs: [...this.catalog.techs.values()].map((x) => {
        const d = this.discovered.get(x.code);
        const by = d ? (this.world.entities.get(d.by)?.id ?? [...this.world.entities.values()].find((e) => e.name === d.by)?.id ?? d.by) : null;
        return d
          ? { code: x.code, name: x.name, description: x.description, discovered: true, discoveredBy: by, discoveredAt: { day: d.day, minute: d.minute }, unlocks: unlocksOf(this.catalog, x.code) }
          : { code: x.code, name: '???', description: '', discovered: false, discoveredBy: null, discoveredAt: null, unlocks: [] as string[] };
      }),
      hiddenRecipes: recipes.filter((r) => !known(r.tech)).length,
    };
  }

  private now(): { day: number; minute: number } {
    return { day: this.world.day, minute: this.world.minute };
  }

  private recent<T>(map: Map<string, T[]>, id: string, item: T): void {
    const list = map.get(id) ?? [];
    list.push(item);
    if (list.length > this.game.god.recentMax) list.splice(0, list.length - this.game.god.recentMax);
    map.set(id, list);
  }

  engineKeys(): readonly string[] {
    return RT_RULE_KEYS;
  }

  /** GET /api/conversations?agent=&with=&group=&since=&limit= (agent/with: entity id or name). */
  async conversations(q: URLSearchParams): Promise<unknown[]> {
    const nameOf = (ref: string | null) => (ref ? (this.world.find(ref)?.name ?? ref) : undefined);
    const query: Record<string, string> = {};
    const agent = nameOf(q.get('agent'));
    const other = nameOf(q.get('with'));
    if (agent) query.agent = agent;
    if (other) query.with = other;
    for (const k of ['group', 'since', 'limit']) if (q.get(k)) query[k] = q.get(k)!;
    const idOf = (name: string) => this.world.living().find((e) => e.name === name)?.id ?? name;
    const rows = await this.mnemo.conversations(query).catch(() => []);
    return rows.map((r) => ({ ...r, from: idOf(r.from), to: r.kind === 'deliberation' ? r.to : r.to === 'all' ? 'all' : idOf(r.to), fromName: r.from, toName: r.to }));
  }

  /** GET /api/agents/:id/mind */
  async mind(id: string): Promise<unknown | undefined> {
    const e = this.world.entities.get(id) ?? this.world.find(id);
    if (!e || e.kind === 'player') return undefined;
    const g = this.groups.of(e);
    const mems = await this.mnemo.list(memoryKey(e.name)).catch(() => []);
    const avg = mems.length ? mems.reduce((s, m) => s + m.fidelity, 0) / mems.length : 0;
    return {
      id: e.id, name: e.name, role: e.role, tier: e.tier, model: e.model, alive: e.alive,
      plan: e.plan ? { steps: e.plan.steps, current: e.plan.current, reason: e.plan.reason, createdAt: e.plan.createdAt } : null,
      recentThoughts: this.thoughts.get(e.id) ?? [],
      shortTermMemory: [...e.memory],
      consults: this.consults.get(e.id) ?? [],
      memoriesSummary: {
        count: mems.length, avgFidelity: Math.round(avg * 1000) / 1000, gists: mems.filter((m) => m.kind === 'gist').length,
        recent: mems.slice(0, this.game.god.recentMax).map(memoryDto),
      },
      group: g ? this.groupDto(g) : null,
      inventory: { ...e.inventory }, tools: e.tools.map((x) => ({ ...x })), hp: e.hp, hunger: e.hunger,
      usage: this.usage.rows.get(e.id) ?? null,
    };
  }

  /** GET /api/observatory/* */
  observatory(path: string, q: URLSearchParams) {
    return this.observatoryView.handle(path, q);
  }

  /** GET /api/economy */
  economyView() {
    return { ...this.economyDto(), flows: this.lastFlows };
  }

  /** GET /api/agents/:id/memories (bare array). */
  async memories(id: string): Promise<unknown[] | undefined> {
    const e = this.world.entities.get(id) ?? this.world.find(id);
    if (!e || e.kind === 'player') return undefined;
    return (await this.mnemo.list(memoryKey(e.name)).catch(() => [])).map(memoryDto);
  }

  private broadcastEntity(e: RtEntity): void {
    this.broadcast({ type: 'entity_added', entity: this.entityDto(e) });
  }

  /**
   * God-mode content (memories, deliberations): with SIM_API_TOKEN set only connections that
   * presented the token get it (SSE listeners already passed the token check); otherwise everyone.
   */
  private broadcastPrivileged(msg: Msg): void {
    if (!this.cfg.apiToken) return this.broadcast(msg);
    for (const pc of this.conns.values()) if (pc.conn.authorized) pc.conn.send(msg);
    for (const fn of this.listeners) {
      try {
        fn(msg);
      } catch {
        // a broken listener never stops the world
      }
    }
  }

  /** Sends to every client (except `excludeEntity`'s connection / `excludeConn`) and to SSE listeners. */
  private broadcast(msg: Msg, excludeEntity?: string, excludeConn?: number): void {
    for (const pc of this.conns.values()) {
      if (excludeEntity && pc.entityId === excludeEntity) continue;
      if (excludeConn !== undefined && pc.conn.id === excludeConn) continue;
      pc.conn.send(msg);
    }
    for (const fn of this.listeners) {
      try {
        fn(msg);
      } catch {
        // a broken listener never stops the world
      }
    }
  }

  private event(kind: string, text: string, at?: { x: number; y: number }): void {
    this.broadcast({ type: 'world_event', kind, text, ...(at ? { at: tileOf(at) } : {}) });
  }

  private chron(event: ChronicleEvent, text: string, actors: string[]): void {
    this.chronicle.add({ event, text, actors, day: this.world.day, minute: this.world.minute });
  }

  // ---- HTTP host (REST endpoints shared with the tick simulation) -----------------------

  subscribe(fn: (ev: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): unknown {
    return this.hello(null);
  }

  rules(): Rule[] {
    return this.laws;
  }

  /** GET /api/insights?role= : pending (in flight) and stored insights. */
  async insightList(role?: string): Promise<{ pending: Insight[]; stored: Insight[] }> {
    return { pending: this.insights.allPending().filter((i) => !role || i.role === role), stored: await this.insights.stored(role) };
  }

  /** GET /api/consciousness : accepted insights grouped by role. */
  async consciousness(): Promise<Record<string, Insight[]>> {
    const out: Record<string, Insight[]> = Object.fromEntries(this.roles.map((r) => [r.key, [] as Insight[]]));
    for (const i of await this.insights.stored()) if (i.status === 'accepted') (out[i.role] ??= []).push(i);
    return out;
  }

  status() {
    return {
      mode: 'realtime',
      provider: this.mock ? 'mock' : 'anthropic',
      model: this.cfg.modelOverride ?? [...new Set(this.world.living().filter((e) => e.kind !== 'player').map((e) => e.model))].join(', '),
      time: this.timeDto(),
      population: this.world.living().length,
      groups: this.groups.list().length,
      decisions: { ...this.stats, running: this.limiter.running, minds: this.minds.size, groupMinds: this.groupMinds.size },
      brain: { connected: this.brain.connected, calls: this.brain.calls, cacheHits: this.brain.cacheHits },
      insights: { pending: this.insights.allPending().length },
      chronicle: { session: this.chronicle.session, written: this.chronicle.written, pending: this.chronicle.pending, lastError: this.chronicle.lastError ?? null },
      lorebase: { connected: this.watcher.connected, url: this.cfg.lorebase.url, domain: this.cfg.lorebase.domain, branch: this.cfg.lorebase.branch, revision: this.revision },
    };
  }

  rosterView() {
    return { agents: this.roster, models: this.cfg.models, allowedModels: [...new Set([...Object.values(this.cfg.models), ...(this.cfg.allowedModels ?? [])])], roles: this.roles.map((r) => r.key), roleDetails: this.roles };
  }

  async setRoster(entries: RosterEntry[]): Promise<string | undefined> {
    const err = validateRoster(entries, this.roles.map((r) => r.key), this.cfg);
    if (err) return err;
    this.roster = entries.map(cleanEntry);
    saveRosterFile(this.cfg, this.roster);
    await this.reset();
    return undefined;
  }

  addAgent(entry: RosterEntry): { agent?: unknown; error?: string } {
    const err = validateEntry(entry, this.roles.map((r) => r.key), this.cfg);
    if (err) return { error: err };
    if (this.world.nameTaken(entry.name)) return { error: `"${entry.name}" already lives here` };
    if (this.world.living().filter((e) => e.kind === 'agent').length >= this.cfg.agents.maxRoster) return { error: `at most ${this.cfg.agents.maxRoster} people` };
    const e = this.spawnAgent(cleanEntry(entry));
    this.broadcast({ type: 'entity_added', entity: this.entityDto(e) });
    const text = this.t('rt.events.arrived', { name: e.name });
    this.event('birth', text, e);
    this.chron('arrival', text, [e.name]);
    this.awaken(e);
    return { agent: this.entityDto(e) };
  }

  removeAgent(id: string): boolean {
    const e = this.world.entities.get(id);
    if (!e || !e.alive || e.kind === 'player') return false;
    this.sleep(id);
    this.groups.leave(e);
    e.alive = false;
    e.plan = undefined;
    e.diedAtMs = Date.now() - this.game.loop.deadLingerMs;
    const text = this.t('rt.events.departed', { name: e.name });
    this.event('group', text, e);
    this.chron('departure', text, [e.name]);
    return true;
  }

  /** A new world with the current roster (players stay connected and must join again). */
  async reset(seed?: number): Promise<void> {
    this.stopLoop();
    if (seed !== undefined) this.cfg.seed = seed;
    for (const id of [...this.minds.keys()]) this.sleep(id);
    for (const m of this.groupMinds.values()) m.stop();
    this.groupMinds.clear();
    this.sent.clear();
    this.world = this.newWorld();
    this.world.rules = this.values;
    this.world.clock = this.world.epoch = this.values.dawn_minute ?? 0;
    this.groups = this.newGroups();
    for (const pc of this.conns.values()) pc.entityId = null;
    this.populate();
    for (const pc of this.conns.values()) pc.conn.send(this.hello(null, this.privileged(pc.conn)));
    this.start();
  }
}

/** Memory as clients see it: emotion as intensity 0-1. */
function memoryDto(m: import('./mnemo.ts').Memory) {
  return { id: m.id, text: m.text, fidelity: m.fidelity, importance: m.importance, emotion: Math.round(Math.min(1, Math.abs(Number(m.emotion) || 0)) * 1000) / 1000, kind: m.kind, createdAt: m.createdAt, recalls: m.recalls };
}
