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
import { type GroupView, proclamation } from './prompt.ts';
import { reflexEat, reflexSteps } from './reflex.ts';
import { canAddAgentMind, childSpec } from './births.ts';
import { missingRtRules, RT_RULE_KEYS, type Resource, type RtEntity, type RtTile, RtWorld, type WorldEvent } from './world.ts';
import { askError, giveAsked, offerError, OfferBook, offerMinutes, type Offer, swap } from './barter.ts';
import { bagOf } from './plan.ts';
import { type Family, type Opinion, Society, Testimonies } from './society.ts';
import { RULE_KEYS } from '../world/engine.ts';
import { type LawProposal, LawDesk, lawDraft } from './law-proposals.ts';

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
  private readonly stats = { decisions: 0, groupDecisions: 0, replies: 0, failures: 0, thoughts: 0 };
  /** Set while a reply is spoken, so a reply never triggers another reply. */
  private speakingReply = false;
  readonly offers = new OfferBook();
  readonly society: Society;
  readonly laws_: LawDesk;
  private readonly familyLog: Chronicle;
  /** Tiles changed since the last `tiles` flush, and what each client last got. */
  private readonly dirtyTiles = new Map<number, RtTile>();
  private readonly tileSent = new Map<number, string>();
  private lastTileFlushMs = 0;
  private lastReputationMs = 0;
  private lastOfferCheckMs = 0;
  private lastLawPollMs = 0;
  private lastPersistMs = 0;
  private lastReflexMs = 0;
  /** Plans a reflex interrupted, by person id (resumed when the reflex ends, dropped by a new plan). */
  private readonly suspended = new Map<string, Plan>();
  private persistBusy = false;
  /** Opinions formed since the society was last saved to mnemo. */
  private unsavedOpinions: Opinion[] = [];
  private readonly testimonies: Testimonies;
  /** Laws the engine reads; any other law is a social law, kept or broken only in the eyes of witnesses. */
  private readonly engineLawKeys = new Set<string>([...RT_RULE_KEYS, ...RULE_KEYS]);
  /** Set when the model cost reached budget.maxUsd: no mind runs any more. */
  private budgetPaused = false;

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
      stats: () => ({ ...this.stats, running: this.limiter.running, budgetMaxUsd: game.budget.maxUsd, budgetPaused: this.budgetPaused ? 1 : 0 }),
    }, game.observatory);
    this.world = this.newWorld();
    this.groups = this.newGroups();
    this.chronicle = new Chronicle(this.client, cfg.lorebase.branch, game.chronicle);
    this.familyLog = new Chronicle(this.client, cfg.lorebase.branch, { ...game.chronicle, kind: game.society.families.kind, flushMs: game.society.families.flushMs }, this.chronicle.session);
    this.society = new Society((k) => this.world.r(k), { maxOpinions: game.society.maxOpinions, hearsayKept: game.society.hearsay.maxKept, familyColors: game.society.families.colors });
    const tm = game.society.testimony;
    this.testimonies = new Testimonies({ windowMinutes: tm.windowMinutes, minWitnesses: tm.chronicleMinWitnesses, maxKept: tm.maxKept });
    this.society.stageOf = (id) => {
      const e = this.world.entities.get(id);
      return e && e.alive ? e.stage : undefined;
    };
    this.laws_ = new LawDesk(this.client, cfg.lorebase.branch, game.society.lawProposals, { create: cfg.lorebase.createOperation, update: cfg.lorebase.updateOperation, ruleKind: cfg.lorebase.ruleKind }, {
      changed: (p) => this.onLawProposal(p),
    });
    this.insights = new InsightBook(this.client, cfg.lorebase.branch, game.insights, {
      changed: (insight, action, reviewer) => {
        if (action === 'accepted') {
          this.brain.invalidate();
          const author = this.byName(insight.author);
          if (author) this.society.deed(author.id, 'insight_accepted', this.world.clock);
        }
        this.broadcast({ type: 'insight', insight, action, ...(reviewer ? { reviewer } : {}) });
      },
      approvalWeight: (rev) => {
        const e = this.byName(rev.name);
        if (!e) return 1;
        const esteem = this.society.esteemOf(e.id);
        return esteem >= this.world.r('insight_solo_approve_esteem') ? Infinity : esteem * this.world.r('insight_review_esteem_factor');
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
    w.offerHook = (e, to, give, want) => {
      const out = this.makeOffer(e, to, give, want);
      return out.ok ? { ok: true } : { ok: false, reason: out.reason };
    };
    w.childOf = (a, b, rnd) => {
      const spec = childSpec(this.game, a, b, this.agentMinds(), rnd);
      return spec && { ...spec, model: this.modelFor({ tier: spec.tier }) };
    };
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
      runSinks: () => this.mnemo.runSinks(),
      ranModel: (who, res) => this.usage.track(who, res),
      deliberated: (g, memberId, role, text) => {
        const name = this.world.entities.get(memberId)?.name ?? memberId;
        this.broadcastPrivileged({ type: 'deliberation', groupId: g.id, pattern: g.pattern, member: memberId, role, text });
        this.mnemo.converse({ from: name, to: this.groups.groups.get(g.id)?.name ?? g.id, text, kind: 'deliberation', at: this.now(), groupId: g.id });
      },
      recall: async (e, query) => {
        if (e.kind !== 'agent') return [];
        const hits = await this.mnemo.recall(memoryKey(e.name), query);
        return (hits ?? []).map((m) => this.t('rt.act.recallLine', { day: m.createdAt.day, text: m.text, vivid: this.t(m.fidelity >= 0.5 ? 'rt.act.vivid' : 'rt.act.faded') }).replace(/^- /, ''));
      },
      reasoned: (e, text) => {
        this.stats.thoughts++;
        this.broadcastPrivileged({ type: 'say', from: e.id, to: e.id, text, kind: 'thought' });
        this.recent(this.thoughts, e.id, { at: this.now(), text });
      },
      consulted: (e, ev) => {
        this.recent(this.consults, e.id, { at: this.now(), tool: ev.tool, query: ev.query });
        this.broadcastPrivileged({ type: 'consult', agentId: e.id, tool: ev.tool, query: ev.query });
      },
      offer: (e, to, give, want) => {
        const out = this.makeOffer(e, to, give, want);
        return out.ok ? { ok: true, text: this.t('rt.act.offerMade', { id: out.offer.id, name: this.world.entities.get(out.offer.to)?.name ?? to }) } : { ok: false, text: this.t('rt.act.offerFailed', { reason: this.t(`rt.reason.${out.reason}`) }) };
      },
      ask: (e, to, item, amount) => this.makeAsk(e, to, item, amount),
      answerOffer: (e, id, accept) => this.answerOffer(e, id, accept),
      testify: (e, input) => this.testify(e, input),
      judge: (e, who, score, reason) => this.judge(e, who, score, reason),
      proposeLaw: (e, input) => this.proposeLaw(e, input),
      voteWeight: (id) => this.society.voteWeight(id),
      perceived: {
        about: (e, b) => this.repute(e, b),
        blocks: (e) => this.societyBlocks(e),
        offersFor: (e) => this.offers.pendingFor(e.id).map((o) => ({ id: o.id, want: o.want })),
      },
    };
  }

  private byName(name: string): RtEntity | undefined {
    return this.world.living().find((x) => x.name === name);
  }

  // ---- barter -------------------------------------------------------------------

  private bagWords(bag: Record<string, number>): string {
    return this.bagText(bag) || '-';
  }

  /** An offer from `e` to a person near it (plan step or tool). */
  private makeOffer(e: RtEntity, to: string, giveRaw: unknown, wantRaw: unknown): { ok: true; offer: Offer } | { ok: false; reason: string } {
    if (!this.game.barter.enabled) return { ok: false, reason: 'failed' };
    const w = this.world;
    const target = w.find(to);
    const give = bagOf(giveRaw) ?? {};
    const want = bagOf(wantRaw) ?? {};
    const err = offerError(this.catalog, e, target?.kind === 'agent' ? target : undefined, give, want, { maxKinds: this.game.economy.maxTradeKinds, maxPending: this.game.decisions.offersMax }, this.offers.pendingFrom(e.id).length);
    if (err) return { ok: false, reason: err };
    if (Math.hypot(target!.x - e.x, target!.y - e.y) > w.r('speech_radius')) return { ok: false, reason: 'too_far' };
    const minutes = offerMinutes(w.r('offer_minutes'), w.r('trade_trust_esteem'), this.society.esteemOf(e.id));
    const offer = this.offers.add({ from: e.id, to: target!.id, kind: 'barter', give, want, madeAt: w.clock, expiresAt: w.clock + minutes });
    this.broadcastOffer(offer);
    w.deliver(target!, { from: e.id, fromName: e.name, to: target!.id, text: this.t('rt.offerInbox', { id: offer.id, give: this.bagWords(give), want: this.bagWords(want) }), day: w.day, minute: w.minute });
    this.live(e, 'offer', this.t('rt.memory.offered', { name: target!.name, give: this.bagWords(give), want: this.bagWords(want) }));
    this.perceive(target, { kind: 'offer', from: e });
    return { ok: true, offer };
  }

  /** An ask (`chiedi`): something wanted from a person near `e`, nothing offered in return. */
  private makeAsk(e: RtEntity, to: string, item: string, amount: number): ToolOutcome {
    const t = this.t;
    const w = this.world;
    const fail = (reason: string) => ({ ok: false, text: t('rt.act.askFailed', { reason: t(`rt.reason.${reason}`) }) });
    if (!this.game.barter.enabled) return fail('failed');
    const target = w.find(to);
    const want = bagOf({ [item]: amount }) ?? {};
    const err = askError(this.catalog, e, target?.kind === 'agent' ? target : undefined, want, { maxKinds: this.game.economy.maxTradeKinds, maxPending: this.game.decisions.offersMax }, this.offers.pendingFrom(e.id).length);
    if (err) return fail(err);
    if (Math.hypot(target!.x - e.x, target!.y - e.y) > w.r('speech_radius')) return fail('too_far');
    const minutes = offerMinutes(w.r('offer_minutes'), w.r('trade_trust_esteem'), this.society.esteemOf(e.id));
    const offer = this.offers.add({ from: e.id, to: target!.id, kind: 'ask', give: {}, want, madeAt: w.clock, expiresAt: w.clock + minutes });
    this.broadcastOffer(offer);
    w.deliver(target!, { from: e.id, fromName: e.name, to: target!.id, text: t('rt.askInbox', { id: offer.id, want: this.bagWords(want) }), day: w.day, minute: w.minute });
    this.live(e, 'offer', t('rt.memory.asked', { name: target!.name, want: this.bagWords(want) }));
    this.perceive(target, { kind: 'offer', from: e, ask: true });
    console.log(`[society] ask ${offer.id}: ${e.name} -> ${target!.name} ${this.bagWords(want)}`);
    return { ok: true, text: t('rt.act.askMade', { id: offer.id, name: target!.name }) };
  }

  private broadcastOffer(o: Offer): void {
    this.broadcast({ type: 'offer', id: o.id, kind: o.kind, from: o.from, to: o.to, give: o.give, want: o.want, status: o.status });
  }

  private answerOffer(e: RtEntity, id: string, accept: boolean): ToolOutcome {
    const t = this.t;
    const w = this.world;
    const o = this.offers.get(id.trim());
    if (!o || o.to !== e.id || o.status !== 'pending') return { ok: false, text: t('rt.act.offerUnknown') };
    const from = w.entities.get(o.from);
    if (!from || !from.alive) {
      this.closeOffer(o, 'expired');
      return { ok: false, text: t('rt.act.offerUnknown') };
    }
    if (!accept) {
      this.closeOffer(o, 'rejected');
      return { ok: true, text: t('rt.act.offerRejected', { name: from.name }) };
    }
    if (Math.hypot(from.x - e.x, from.y - e.y) > w.r('speech_radius')) return { ok: false, text: t('rt.act.offerFailedSwap', { reason: t('rt.reason.too_far') }) };
    if (o.kind === 'ask') {
      if (w.r('sharing_allowed') < 1) return { ok: false, text: t('rt.act.offerFailedSwap', { reason: t('rt.reason.giving_forbidden') }) };
      const askErr = giveAsked(this.catalog, o.want, e, from);
      if (askErr) return { ok: false, text: t('rt.act.offerFailedSwap', { reason: t(`rt.reason.${askErr}`) }) };
      // A gift like any other (memories, flows, fame).
      for (const [k, n] of Object.entries(o.want)) this.onWorldEvent({ type: 'gave', from: e.id, to: from.id, resource: k, amount: n });
      this.closeOffer(o, 'accepted');
      return { ok: true, text: t('rt.act.askGiven', { name: from.name }) };
    }
    const err = swap(this.catalog, o, from, e);
    if (err) return { ok: false, text: t('rt.act.offerFailedSwap', { reason: t(`rt.reason.${err}`) }) };
    this.broadcast({ type: 'trade', from: from.id, to: e.id, give: o.give, get: o.want, kind: 'barter' });
    for (const [k, n] of Object.entries(o.give)) this.flows.add(from.role, e.role, k, n);
    for (const [k, n] of Object.entries(o.want)) this.flows.add(e.role, from.role, k, n);
    this.live(from, 'trade', t('rt.memory.traded', { name: e.name, give: this.bagWords(o.give), get: this.bagWords(o.want) }));
    this.live(e, 'trade', t('rt.memory.traded', { name: from.name, give: this.bagWords(o.want), get: this.bagWords(o.give) }));
    this.event('trade', t('rt.events.trade', { a: from.name, b: e.name, give: this.bagWords(o.give), get: this.bagWords(o.want) }), e);
    this.closeOffer(o, 'accepted');
    return { ok: true, text: t('rt.act.offerAccepted', { name: from.name }) };
  }

  private closeOffer(o: Offer, status: 'accepted' | 'rejected' | 'expired'): void {
    this.offers.close(o, status);
    this.broadcastOffer(o);
    const from = this.world.entities.get(o.from);
    const to = this.world.entities.get(o.to);
    if (!from || !from.alive) return;
    const said = this.t(`rt.offerStatus.${status}`);
    if (status !== 'accepted') this.live(from, 'offer', this.t('rt.memory.offerClosed', { name: to?.name ?? o.to, status: said }));
    if (to) this.perceive(from, { kind: 'offerAnswered', with: to, status: said });
  }

  // ---- society ------------------------------------------------------------------

  /** A person enters the society (and gets its family, when born of two). */
  private register(e: RtEntity, parents?: [string, string]): void {
    this.society.add({ id: e.id, name: e.name, role: e.role, tier: e.tier, kind: e.kind, bornAt: e.bornAt, parents: parents ?? e.parents });
    if (!parents) return;
    const { family, founded } = this.society.familyForBirth(e.id, parents[0], parents[1], this.world.day, (name) => this.t('rt.society.familyName', { name }), this.chronicle.session);
    for (const id of family.members) {
      const m = this.world.entities.get(id);
      if (m) m.family = this.society.people.get(id)?.family ?? m.family;
    }
    if (founded) {
      const founder = this.society.people.get(family.founder)?.name ?? family.founder;
      const text = this.t('rt.events.family', { name: family.name, founder });
      this.event('birth', text, e);
      this.chron('family_founded', text, [founder]);
      this.familyLog.addRow({ code: family.id, name: family.name, founder, founded_day: family.foundedDay, session: this.chronicle.session });
    }
    this.broadcastFamily(family);
  }

  private broadcastFamily(f: Family): void {
    this.broadcast({ type: 'family', family: this.society.familyDto(f) });
  }

  private judge(e: RtEntity, who: string, score: number, reason: string): ToolOutcome {
    const t = this.t;
    const w = this.world;
    if (!this.game.society.enabled) return { ok: false, text: t('rt.act.judgeFailed', { reason: t('rt.insightReason.disabled') }) };
    const b = w.find(who);
    if (!b || !b.alive || b.kind === 'player') return { ok: false, text: t('rt.act.judgeFailed', { reason: t('rt.reason.no_such_person') }) };
    if (b.id === e.id) return { ok: false, text: t('rt.act.judgeFailed', { reason: t('rt.reason.self') }) };
    const s = Math.max(-1, Math.min(1, Number.isFinite(score) ? score : 0));
    const why = reason.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, this.game.society.reasonMaxChars);
    const opinion = { from: e.id, to: b.id, score: s, reason: why, at: w.clock };
    this.society.opinion(opinion);
    this.unsavedOpinions.push(opinion);
    this.live(e, 'opinion', t('rt.memory.judged', { name: b.name, reason: why || '-' }));
    if (why) {
      const radius = w.r('speech_radius');
      const hearers = w.living().filter((x) => x.id !== e.id && x.kind !== 'player' && Math.hypot(x.x - e.x, x.y - e.y) <= radius).map((x) => x.id);
      this.society.hear(hearers, { about: b.id, from: e.name, text: why, at: w.clock });
    }
    this.broadcastPrivileged({ type: 'opinion', from: e.id, to: b.id, score: s, reason: why });
    return { ok: true, text: t('rt.act.judged', { name: b.name }) };
  }

  /** A witness tells that `chi` kept (or broke) a social law: fame moves, a breach told by enough witnesses is chronicled. */
  private testify(e: RtEntity, input: { chi?: unknown; legge?: unknown; rispettata?: unknown; motivo?: unknown }): ToolOutcome {
    const t = this.t;
    const w = this.world;
    const cfg = this.game.society.testimony;
    const fail = (reason: string) => ({ ok: false, text: t('rt.act.testifyFailed', { reason: t(`rt.reason.${reason}`) }) });
    if (!this.game.society.enabled) return fail('failed');
    const b = w.find(String(input.chi ?? ''));
    if (!b || !b.alive || b.kind === 'player') return fail('no_such_person');
    if (b.id === e.id) return fail('self');
    const key = String(input.legge ?? '').trim().toLowerCase();
    const law = this.laws.find((r) => r.key.toLowerCase() === key);
    if (!law) return fail('no_such_law');
    if (this.engineLawKeys.has(law.key)) return fail('engine_law');
    const kept = input.rispettata === true || String(input.rispettata).toLowerCase() === 'true';
    const why = String(input.motivo ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, cfg.reasonMaxChars);
    const out = this.testimonies.add({ witness: e.id, who: b.id, law: law.key, kept, reason: why, at: w.clock });
    if ('error' in out) return fail('duplicate_testimony');
    this.society.deed(b.id, kept ? 'law_respected' : 'law_breached', w.clock);
    this.live(e, 'opinion', t(kept ? 'rt.memory.testifiedKept' : 'rt.memory.testifiedBroken', { name: b.name, law: law.key, reason: why || '-' }));
    if (why) {
      const radius = w.r('speech_radius');
      const hearers = w.living().filter((x) => x.id !== e.id && x.kind !== 'player' && Math.hypot(x.x - e.x, x.y - e.y) <= radius).map((x) => x.id);
      this.society.hear(hearers, { about: b.id, from: e.name, text: why, at: w.clock });
    }
    console.log(`[society] testimony: ${e.name} says ${b.name} ${kept ? 'kept' : 'broke'} ${law.key}${why ? ` (${why})` : ''}`);
    if (out.breachWitnesses) {
      const names = out.breachWitnesses.map((id) => w.entities.get(id)?.name ?? id);
      const text = t('rt.events.lawBreach', { name: b.name, law: law.key, witnesses: names.join(', ') });
      this.event('rules', text, b);
      this.chron('law_breach', text, [b.name, ...names]);
    }
    return { ok: true, text: t('rt.act.testified', { name: b.name }) };
  }

  private async proposeLaw(e: RtEntity, input: { key?: unknown; text?: unknown; category?: unknown; value?: unknown }): Promise<ToolOutcome> {
    const t = this.t;
    const cfg = this.game.society.lawProposals;
    if (!this.game.society.enabled || e.kind !== 'agent') return { ok: false, text: t('rt.act.lawFailed', { reason: t('rt.insightReason.disabled') }) };
    if (this.society.esteemOf(e.id) < this.world.r('law_proposal_min_esteem')) return { ok: false, text: t('rt.act.lawNotEsteemed') };
    const draft = lawDraft(input, cfg.textMaxChars, cfg.defaultValue);
    if ('error' in draft) return { ok: false, text: t('rt.act.lawFailed', { reason: t(`rt.reason.${draft.error}`) }) };
    const out = await this.laws_.propose({ id: e.id, name: e.name }, draft, this.laws);
    if (typeof out === 'string') return { ok: false, text: t('rt.act.lawFailed', { reason: this.t(`rt.reason.${out}`) === `rt.reason.${out}` ? out : t(`rt.reason.${out}`) }) };
    return { ok: true, text: t('rt.act.lawProposed', { key: out.key }) };
  }

  private onLawProposal(p: LawProposal): void {
    const t = this.t;
    this.broadcast({ type: 'law_proposal', id: p.id, by: p.by, text: p.text, key: p.key, category: p.category, value: p.value, branch: p.branch, status: p.status });
    if (p.status === 'open') {
      const text = t('rt.events.lawProposed', { name: p.byName, text: p.text });
      this.event('rules', text, this.world.entities.get(p.by));
      this.chron('law_proposed', text, [p.byName]);
      return;
    }
    this.event('rules', t(p.status === 'merged' ? 'rt.events.lawMerged' : 'rt.events.lawRejected', { name: p.byName, key: p.key }));
    const by = this.world.entities.get(p.by) ?? this.byName(p.byName);
    if (p.status === 'merged' && by) this.society.deed(by.id, 'law_enacted', this.world.clock);
  }

  /** GET /api/law-proposals and POST /api/law-proposals/:id/approve|reject (god mode). */
  lawProposals(): LawProposal[] {
    return [...this.laws_.proposals.values()];
  }

  decideLawProposal(id: string, verdict: 'approve' | 'reject', note: string): Promise<LawProposal | string> {
    return this.laws_.decide(id, verdict, note);
  }

  /** What `e` perceives of `b`'s standing: bands of esteem and fame, never numbers. */
  private repute(e: RtEntity, b: RtEntity): string {
    if (!this.game.society.enabled || b.kind === 'player') return '';
    const h = this.game.society.hearsay;
    const t = this.t;
    const esteem = this.society.esteemOf(b.id);
    const parts = [
      esteem >= h.highAbove ? t('rt.look.reputeHigh') : esteem < h.lowBelow ? t('rt.look.reputeLow') : '',
      this.society.fameOf(b.id, this.world.clock) >= h.famousAbove ? t('rt.look.reputeFamous') : '',
      ...this.society.hearsayOf(e.id, b.id).slice(-h.perPerson).map((x) => t('rt.look.reputeHeard', { name: b.name, text: x.text })),
    ];
    return parts.join('');
  }

  /** Age, open exchange offers and hearsay, as factual blocks of the observation. */
  private societyBlocks(e: RtEntity): string[] {
    const t = this.t;
    const w = this.world;
    const out = [t('rt.observation.age', { days: Math.floor(w.ageDays(e)), stage: t(`rt.stage.${e.stage}`) })];
    const name = (id: string) => w.entities.get(id)?.name ?? id;
    const line = (o: Offer, mine: boolean) => t(`rt.observation.${o.kind === 'ask' ? 'ask' : 'offer'}${mine ? 'ByYou' : 'ForYou'}`, { id: o.id, from: name(o.from), to: name(o.to), give: this.bagWords(o.give), want: this.bagWords(o.want) });
    const lines = [...this.offers.pendingFor(e.id).map((o) => line(o, false)), ...this.offers.pendingFrom(e.id).map((o) => line(o, true))];
    if (lines.length) out.push(t('rt.observation.offers', { offers: lines.join('\n') }));
    const heard = this.society.hearsayOf(e.id);
    if (heard.length) out.push(t('rt.observation.hearsay', { lines: heard.map((x) => t('rt.observation.hearsayLine', { from: x.from, about: this.society.people.get(x.about)?.name ?? x.about, text: x.text })).join('\n') }));
    return out;
  }

  /** GET /api/society (opinions only for privileged callers). */
  societyView(privileged: boolean) {
    const clock = this.world.clock;
    const people = [...this.society.people.values()].filter((p) => p.kind !== 'player').map((p) => this.personDto(p.id, clock)!);
    return {
      people,
      families: [...this.society.families.values()].map((f) => this.society.familyDto(f)),
      ...(privileged ? { opinions: this.society.opinions.map((o) => ({ from: o.from, to: o.to, score: o.score })) } : {}),
    };
  }

  private personDto(id: string, clock = this.world.clock) {
    const p = this.society.people.get(id);
    if (!p) return undefined;
    const end = p.diedAt ?? clock;
    const days = Math.max(0, (end - p.bornAt) / 1440);
    const e = this.world.entities.get(id);
    const stage = e?.stage ?? (days < this.world.r('age_child_days') ? 'child' : days >= this.world.r('age_elder_days') ? 'elder' : 'adult');
    return {
      id: p.id, name: p.name, role: p.role, tier: p.tier, effectiveTier: this.effectiveTier(p.tier, e?.model ?? this.modelFor({ tier: p.tier })), age: { stage, days: Math.round(days * 10) / 10 }, esteem: this.society.esteemOf(p.id),
      fame: this.society.fameOf(p.id, clock), rank: this.society.ranks.get(p.id) ?? 0, family: p.family, parents: p.parents, alive: p.alive,
    };
  }

  private tickSociety(now: number): void {
    const w = this.world;
    if (this.game.barter.enabled && now - this.lastOfferCheckMs >= this.game.barter.checkMs) {
      this.lastOfferCheckMs = now;
      for (const o of this.offers.stale(w.clock, (id) => !!w.entities.get(id)?.alive)) this.closeOffer(o, 'expired');
    }
    if (!this.game.society.enabled) return;
    if (now - this.lastReputationMs >= this.game.society.broadcastMs) {
      this.lastReputationMs = now;
      this.society.recompute(w.clock);
      const people = w.living().filter((e) => e.kind !== 'player').map((e) => ({ id: e.id, esteem: this.society.esteemOf(e.id), fame: this.society.fameOf(e.id, w.clock), rank: this.society.ranks.get(e.id) ?? 0 }));
      this.broadcast({ type: 'reputation', people });
    }
    if (now - this.lastLawPollMs >= this.game.society.lawProposals.pollMs) {
      this.lastLawPollMs = now;
      void this.laws_.poll().catch(() => undefined);
    }
    if (this.game.society.persist.enabled && now - this.lastPersistMs >= this.game.society.persist.flushMs) {
      this.lastPersistMs = now;
      void this.saveSociety();
    }
  }

  /** World id of the saved society (config, or the Lorebase domain and branch). */
  private get societyWorld(): string {
    return this.game.society.persist.world || `${this.cfg.lorebase.domain}/${this.cfg.lorebase.branch}`;
  }

  /** Saves people's standing and skills and the opinions formed since the last save (mnemo). */
  private async saveSociety(): Promise<{ people: number; opinions: number } | undefined> {
    if (this.persistBusy || !this.game.society.enabled) return undefined;
    this.persistBusy = true;
    const w = this.world;
    const snap = this.society.snapshot(w.clock, (id) => w.entities.get(id)?.skills ?? {});
    const pending = this.unsavedOpinions.splice(0);
    const name = (id: string) => this.society.people.get(id)?.name;
    const opinions = pending.flatMap((o) => (name(o.from) && name(o.to) ? [{ from: name(o.from)!, to: name(o.to)!, score: o.score, reason: o.reason, at: o.at }] : []));
    try {
      if (await this.mnemo.saveSociety(this.societyWorld, { clock: snap.clock, people: snap.people, opinions }, this.game.society.maxOpinions)) return { people: snap.people.length, opinions: opinions.length };
      this.unsavedOpinions.unshift(...pending);
      return undefined;
    } finally {
      this.persistBusy = false;
    }
  }

  /** Brings back opinions, esteem, fame and skills saved by an earlier run of this world. */
  private async restoreSociety(): Promise<void> {
    if (!this.game.society.enabled || !this.game.society.persist.enabled) return;
    const saved = await this.mnemo.loadSociety(this.societyWorld);
    if (!saved) return;
    const skills = this.society.restore(saved, this.world.clock);
    for (const [id, sk] of skills) {
      const e = this.world.entities.get(id);
      if (e) e.skills = { ...sk, ...e.skills };
    }
    this.society.recompute(this.world.clock);
    console.log(`[society] restored ${skills.size} people and ${this.society.opinions.length} opinions of ${this.societyWorld}`);
  }

  /** Pauses every mind once the model cost of this run reaches budget.maxUsd. */
  private checkBudget(): void {
    const max = this.game.budget.maxUsd;
    if (!(max > 0) || this.budgetPaused) return;
    const spent = this.usage.totalUsd();
    if (spent < max) return;
    this.budgetPaused = true;
    for (const id of [...this.minds.keys()]) this.sleep(id);
    for (const m of this.groupMinds.values()) m.stop();
    this.groupMinds.clear();
    const text = this.t('rt.events.budget', { spent: spent.toFixed(2), max });
    console.warn(`[budget] model cost $${spent.toFixed(2)} reached budget.maxUsd $${max}: every mind is paused`);
    this.event('rules', text);
  }

  /** Coalesced tile updates: only tiles whose state changed since they were last sent. */
  private flushTiles(now: number): void {
    if (now - this.lastTileFlushMs < this.game.net.tileFlushMs || !this.dirtyTiles.size) return;
    this.lastTileFlushMs = now;
    const items: Msg[] = [];
    for (const [i, tile] of this.dirtyTiles) {
      const dto = this.tileDto(tile);
      const key = JSON.stringify(dto);
      if (this.tileSent.get(i) === key) continue;
      this.tileSent.set(i, key);
      items.push(dto as unknown as Msg);
    }
    this.dirtyTiles.clear();
    if (items.length) this.broadcast({ type: 'tiles', items });
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
    await this.reconcile();
    this.world.clock = this.world.epoch = this.values.dawn_minute ?? 0;
    this.mnemo.follow((ev) => this.onMemory(ev));
    this.roster = loadRosterFile(this.cfg, this.roles.map((r) => r.key));
    this.populate();
    await this.restoreSociety();
    this.chronicle.start();
    this.familyLog.start();
    await this.brain.connect();
    this.start();
  }

  /** Startup reconciliation: pending insights and agents' law proposals left in Lorebase by an earlier run. */
  private async reconcile(): Promise<void> {
    try {
      const ins = await this.insights.reconcile(this.world.clock);
      const laws = await this.laws_.reconcile(this.cfg.lorebase.proposalBranchPrefix);
      console.log(`[reconcile] insights: ${ins.reloaded} reloaded, ${ins.closed} closed, ${ins.branchesDeleted} stale role/ branches deleted; law proposals: ${laws.reloaded} followed, ${laws.branchesDeleted} stale law/ branches deleted`);
    } catch (err) {
      console.warn(`[reconcile] skipped: ${err instanceof Error ? err.message : err}`);
    }
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
      const x = this.world.spawn({ name, role, tier: crowd.tier, model: this.modelFor({ tier: crowd.tier }), kind: 'crowd', personality: crowd.personality });
      this.register(x);
      extras.push(x);
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

  /** Living individual agents: each one is an LLM mind of its own. */
  private agentMinds(): number {
    return this.world.living().filter((e) => e.kind === 'agent').length;
  }

  modelFor(entry: Pick<RosterEntry, 'tier' | 'model'>): string {
    return this.cfg.modelOverride ?? entry.model ?? this.cfg.models[entry.tier];
  }

  /** Display only: the tier whose configured model is the one actually used (roster tier when none matches). */
  effectiveTier(tier: RtEntity['tier'], model: string): RtEntity['tier'] {
    const models = this.cfg.models as Record<string, string>;
    return tier === 'human' ? tier : ((Object.keys(models).find((t) => models[t] === model) as RtEntity['tier'] | undefined) ?? tier);
  }

  private spawnAgent(entry: RosterEntry): RtEntity {
    const e = this.world.spawn({ id: entry.id, name: entry.name, role: entry.role, tier: entry.tier, model: this.modelFor(entry), kind: 'agent', personality: entry.personality });
    this.lawsSeen.set(e.id, this.laws);
    this.register(e);
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
    if (this.game.society.persist.enabled) {
      // A periodic save may be in flight: let it finish, then save the final state.
      for (let i = 0; this.persistBusy && i < 50; i++) await new Promise((r) => setTimeout(r, 100));
      const saved = await this.saveSociety().catch(() => undefined);
      if (saved) console.log(`[society] saved ${saved.people} people and ${saved.opinions} new opinions of ${this.societyWorld} on shutdown`);
      else console.warn(`[society] could not save the society of ${this.societyWorld} on shutdown (mnemo unavailable?)`);
    }
    this.watcher.stop();
    await this.brain.close();
    this.mnemo.stop();
    await this.chronicle.stop();
    await this.familyLog.stop();
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
      this.proclaim(changes);
      this.perceiveAll({ kind: 'rules' });
    }
  }

  /**
   * Every living person hears the new laws, with their full text from Lorebase: the proclamation
   * reaches each one's inbox and stays in its private memory (where it fades like any memory).
   */
  private proclaim(changes: RuleChange[]): void {
    const w = this.world;
    const ingest = this.game.memory.ingest.law;
    const from = this.t('rt.proclamation.herald');
    for (const c of changes) {
      const text = proclamation(this.t, c);
      for (const e of w.living()) {
        if (e.kind === 'player') continue;
        w.deliver(e, { from: 'lorebase', fromName: from, to: e.id, text, day: w.day, minute: w.minute });
        if (ingest && e.kind === 'agent') void this.mnemo.add(memoryKey(e.name), text, { ...ingest, at: { day: w.day, minute: w.minute }, source: 'law' });
      }
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
    this.flushTiles(now);
    this.reflexes(now);
    this.tickSociety(now);
    this.checkBudget();
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

  /**
   * Bodies act by reflex (reflex.ts): without a plan when hungry; with one only at critical hunger
   * (eat what they carry, or suspend the plan to fetch food and resume it afterwards).
   */
  private reflexes(now: number): void {
    const cfg = this.game.reflex;
    if (!cfg.enabled || now - this.lastReflexMs < cfg.checkMs) return;
    this.lastReflexMs = now;
    for (const e of this.world.living()) {
      if (e.kind === 'player') continue;
      const busy = !!e.plan && e.plan.current < e.plan.steps.length;
      if (busy && (e.plan!.scope === 'reflex' || reflexEat(this.world, e, cfg) || e.hunger < this.world.r('critical_hunger'))) continue;
      const steps = reflexSteps(this.t, this.world, e, cfg);
      if (!steps) continue;
      if (busy) this.suspended.set(e.id, e.plan!);
      this.setPlan(e, steps, this.t('rt.reflex.reason'), 'reflex');
    }
  }

  /** A reflex plan ended: the plan it interrupted (if any) goes on from the step it was at. */
  private resume(e: RtEntity): boolean {
    const plan = this.suspended.get(e.id);
    this.suspended.delete(e.id);
    if (!plan) return false;
    e.plan = plan;
    e.activity = undefined;
    this.broadcastPlan({ type: 'plan', id: e.id, scope: plan.scope === 'group' ? 'group' : 'entity', steps: plan.steps, current: plan.current, reason: plan.reason, createdAt: plan.createdAt });
    return true;
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
        const e = w.entities.get(ev.id);
        if (e?.plan?.scope !== 'reflex') this.perceive(e, { kind: 'planDone' });
        else this.resume(e);
        break;
      }
      case 'step_failed': {
        const e = w.entities.get(ev.id);
        const step = e?.plan?.steps[ev.step];
        if (!e || !step) break;
        if (e.plan?.scope === 'reflex') break;
        const reason = t(`rt.reason.${ev.reason}`);
        this.live(e, 'stepFailed', t('rt.memory.failed', { label: step.label, reason }));
        this.perceive(e, { kind: 'stepFailed', label: step.label, reason });
        break;
      }
      case 'say':
        this.onSay(ev.from, ev.to, ev.text, ev.hearers);
        break;
      case 'tile':
        this.dirtyTiles.set(ev.tile.y * w.width + ev.tile.x, ev.tile);
        break;
      case 'aged': {
        const e = w.entities.get(ev.id);
        this.broadcast({ type: 'aged', id: ev.id, stage: ev.stage });
        if (e) this.event('birth', t('rt.events.aged', { name: e.name, stage: t(`rt.stage.${ev.stage}`) }), e);
        break;
      }
      case 'skill':
        this.broadcast({ type: 'skill', id: ev.id, recipe: ev.recipe, level: ev.level });
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
        const text = t('rt.events.death', { name: e.name, cause: t(`rt.events.cause_${ev.cause}`) });
        this.event('death', text, e);
        this.chron('death', text, [e.name]);
        this.society.died(e.id, w.clock);
        this.unsavedOpinions = this.unsavedOpinions.filter((o) => o.from !== e.id);
        if (this.game.society.persist.enabled && e.kind !== 'player') void this.mnemo.forgetPerson(this.societyWorld, e.name);
        const fam = e.family ? this.society.families.get(e.family) : undefined;
        if (fam) this.broadcastFamily(fam);
        void this.release(e);
        break;
      }
      case 'birth': {
        const [a, b] = ev.parents.map((id) => w.entities.get(id)?.name ?? id);
        if (ev.child.kind === 'crowd') this.joinCrowd(ev.child);
        ev.child.personality = t('rt.events.childOf', { a: a!, b: b! });
        this.lawsSeen.set(ev.child.id, this.laws);
        this.register(ev.child, ev.parents);
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
        this.society.deed(a.id, 'gift', w.clock);
        // A supply: something a recipe of the receiver's (other) role consumes.
        if (a.role !== b.role && [...this.catalog.recipes.values()].some((r) => r.role === b.role && (r.inputs[ev.resource] ?? 0) > 0)) this.society.deed(a.id, 'recipe_supply', w.clock);
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
      decide: (e, why, stop) => decide(host, e, why, stop),
      reply: (e, speaker, onDelta, stop) => reply(host, e, speaker, onDelta, stop),
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
    this.society.deed(e.id, 'discovery', w.clock);
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
      case 'offer':
        return t(p.ask ? 'rt.why.ask' : 'rt.why.offer', { name: p.from.name });
      case 'offerAnswered':
        return t('rt.why.offerAnswered', { name: p.with.name, status: p.status });
    }
  }

  /** Gives a person a mind of its own (its loop starts at once). */
  private awaken(e: RtEntity): void {
    if (e.kind === 'player' || this.minds.has(e.id) || this.budgetPaused) return;
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
    if (this.groupMinds.has(g.id) || this.budgetPaused) return;
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

  private setPlan(e: RtEntity, steps: PlanStep[], reason: string, scope: Plan['scope']): void {
    const plan: Plan = { id: e.id, scope, steps, current: 0, reason, createdAt: Date.now() };
    if (scope !== 'reflex') this.suspended.delete(e.id);
    e.plan = plan;
    e.activity = undefined;
    // Clients know person plans and group plans; a reflex is a person's plan.
    this.broadcastPlan({ type: 'plan', id: e.id, scope: scope === 'group' ? 'group' : 'entity', steps, current: 0, reason, createdAt: plan.createdAt });
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
    this.register(e);
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
      id: e.id, name: e.name, role: e.role, tier: e.tier, effectiveTier: this.effectiveTier(e.tier, e.model), model: e.model, kind: e.kind, groupId: e.groupId,
      x: r2(e.x), y: r2(e.y), dir: e.dir, anim: e.anim, hp: r1(e.hp), maxHp: e.maxHp, hunger: r1(e.hunger),
      inventory: { ...e.inventory }, tools: e.tools.map((x) => ({ ...x })), speed: e.alive ? this.world.speedOf(e) : 0, alive: e.alive,
      age: { stage: e.stage, days: Math.round(this.world.ageDays(e) * 10) / 10 }, esteem: this.society.esteemOf(e.id), fame: this.society.fameOf(e.id, this.world.clock),
      rank: this.society.ranks.get(e.id) ?? 0, family: e.family, parents: e.parents,
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
      society: this.societyView(full),
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
      id: e.id, name: e.name, role: e.role, tier: e.tier, effectiveTier: this.effectiveTier(e.tier, e.model), model: e.model, alive: e.alive,
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
    const minds = this.agentMinds();
    if (minds >= this.cfg.agents.maxRoster) return { error: `at most ${this.cfg.agents.maxRoster} people` };
    if (!canAddAgentMind(this.game, minds)) return { error: `at most ${this.game.births.maxAgentMinds} agent minds` };
    const e = this.spawnAgent(cleanEntry(entry));
    this.broadcast({ type: 'entity_added', entity: this.entityDto(e) });
    const text = this.t('rt.events.arrived', { name: e.name });
    this.event('birth', text, e);
    this.chron('arrival', text, [e.name]);
    this.awaken(e);
    return { agent: this.entityDto(e) };
  }

  /** A crowd newborn joins the crowd (founding it again if it dissolved), whose single mind decides for it. */
  private joinCrowd(e: RtEntity): void {
    const crowd = this.groups.list().find((g) => g.pattern === 'crowd');
    if (crowd) this.groups.join(crowd, e);
    else this.groups.create(this.game.crowd.groupName, 'crowd', [e], null);
  }

  /**
   * A death frees what the person held: its in-flight model run is aborted and its mind stops,
   * it leaves its group, the per-person caches go, and (config `death`) its private memory and
   * the lines it spoke are deleted from mnemo, leaving at most a one-line epitaph in the Chronicle.
   */
  async release(e: RtEntity): Promise<void> {
    this.sleep(e.id);
    this.suspended.delete(e.id);
    this.groups.leave(e);
    this.lawsSeen.delete(e.id);
    this.thoughts.delete(e.id);
    this.consults.delete(e.id);
    if (e.kind !== 'agent' || !this.game.death.forgetMemories) return;
    const key = memoryKey(e.name);
    if (this.game.death.epitaph) {
      const mems = await this.mnemo.list(key).catch(() => []);
      const best = [...mems].sort((a, b) => b.importance * b.fidelity - a.importance * a.fidelity)[0];
      // Recorded as a death event: the Chronicle schema has no separate kind for it.
      if (best) this.chron('death', this.t('rt.events.epitaph', { name: e.name, memory: best.text }), [e.name]);
    }
    const out = await this.mnemo.forget(key, { speaker: e.name, runAgent: e.id });
    if (out) console.log(`[death ${e.name}] forgot ${out.memories} memories, ${out.conversations} lines, ${out.runs} runs`);
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
    if (this.game.society.persist.enabled) await this.saveSociety().catch(() => undefined);
    this.sent.clear();
    this.offers.clear();
    this.society.clear();
    this.testimonies.clear();
    this.unsavedOpinions = [];
    this.dirtyTiles.clear();
    this.tileSent.clear();
    this.world = this.newWorld();
    this.world.rules = this.values;
    this.world.clock = this.world.epoch = this.values.dawn_minute ?? 0;
    this.groups = this.newGroups();
    for (const pc of this.conns.values()) pc.entityId = null;
    this.populate();
    await this.restoreSociety();
    for (const pc of this.conns.values()) pc.conn.send(this.hello(null, this.privileged(pc.conn)));
    this.start();
  }
}

/** Memory as clients see it: emotion as intensity 0-1. */
function memoryDto(m: import('./mnemo.ts').Memory) {
  return { id: m.id, text: m.text, fidelity: m.fidelity, importance: m.importance, emotion: Math.round(Math.min(1, Math.abs(Number(m.emotion) || 0)) * 1000) / 1000, kind: m.kind, createdAt: m.createdAt, recalls: m.recalls };
}
