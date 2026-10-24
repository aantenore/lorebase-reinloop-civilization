// Groups and how they decide. A group forms when its members say so (form_group / join_group
// tools) or from the roster config; its pattern is chosen by its founder. Each pattern is a
// reinloop multi-agent pattern producing ONE joint plan, split into each member's sub-plan:
//   orchestrator  reinloop `orchestrator`: the leader delegates to members (as tools) and decides
//   council       custom patterns: members propose (a run cut short that said something still counts;
//                 with no proposal the elder decides alone), the elder harmonizes and judges
//                 (a judge that cannot answer does not block the council)
//   router        `router`: the leader picks the member best suited to decide
//   chain         `chain`: scout -> planner -> doer
//   mentor        `evaluator`: the apprentice plans, the mentor critiques until satisfied
//   assembly      custom `definePattern`: everyone proposes, everyone votes, majority wins
//   crowd         one call plans for many extras
// Plans are committed with the commit_plan tool, which ends the writer's run (its data is the plan);
// verdicts and ballots are structured outputs. Member failures come from the team results.
// Each role gets exactly the tools its text names: only plan writers see commit_plan and its format,
// prose proposers are asked for prose, judges, voters and routers answer with structured output and
// no tools. The deciding role runs on the member's own model; the others (proposers, workers,
// voters) on `groups.memberTier`, and at most `groups.maxProposers` of them are consulted.
// How they decided is reconstructed from reinloop run events (a sink) into `lastDecision.trace`.
import {
  agent, definePattern, type EasyAgent, type MemberFailure, memberFailures, type MockTurn, type ModelRequest, type RunEvent, type RunResult, safeToolName, type Sink, team, tool,
} from 'reinloop';
import type { Translate } from '../i18n.ts';
import type { GameConfig, GroupPattern } from './config.ts';
import { AGENT_PATTERNS } from './config.ts';
import { type DecideHost, decisionTier, decisionTimeoutMs, type Failure, faculties, limitsOf, modelRef, normalizeSteps, planSchema } from './decide.ts';
import type { Tier } from '../world/types.ts';
import { flatSteps, mockGroupPlan, mockSteps } from './mock.ts';
import type { PlanStep } from './plan.ts';
import { inboxBlock, look, memberLine, timeLine } from './prompt.ts';
import { NestedUsage } from './observatory.ts';
import { weightedWinner } from './society.ts';
import { tally } from './vote.ts';
import type { RtEntity } from './world.ts';

export type TraceRole = 'proposer' | 'critic' | 'router' | 'leader' | 'voter';

export interface TraceEntry {
  member: string;
  role: TraceRole;
  text: string;
}

export interface GroupDecision {
  summary: string;
  trace: TraceEntry[];
}

export interface Group {
  id: string;
  name: string;
  pattern: GroupPattern;
  members: string[];
  leader: string | null;
  color: string;
  lastDecision?: GroupDecision;
  /** Reached the minimum size at least once (dropping below it then dissolves the group). */
  complete: boolean;
  memory: string[];
}

export interface JointPlan {
  summary: string;
  steps: PlanStep[];
  trace: TraceEntry[];
}

export interface GroupEvents {
  changed(g: Group): void;
  removed(g: Group): void;
  joined(g: Group, e: RtEntity): void;
  left(g: Group, e: RtEntity): void;
  formed(g: Group): void;
}

const SEP = '__';

/** Structured outputs of the judges and the voters. */
const VERDICT = { type: 'object', properties: { pass: { type: 'boolean' }, feedback: { type: 'string' } }, required: ['pass', 'feedback'] };
const BALLOT = { type: 'object', properties: { choice: { type: 'integer' }, reason: { type: 'string' } }, required: ['choice', 'reason'] };

/** A joint plan as committed through commit_plan (the data of the writer's run). */
export interface PlanData {
  summary: string;
  steps: unknown[];
  /** Id of the member who wrote it (steps without a valid `who` are theirs). */
  author?: string;
}

/** The joint plan carried by a run or team result, if any. */
export function planOf(r: Pick<RunResult, 'status' | 'data'>): PlanData | undefined {
  const d = r.data as Partial<PlanData> | undefined;
  return (r.status === 'completed' || r.status === 'stopped') && d && Array.isArray(d.steps) && d.steps.length
    ? { summary: String(d.summary ?? ''), steps: d.steps, ...(typeof d.author === 'string' ? { author: d.author } : {}) }
    : undefined;
}

/** A member reference as models write it: id, name, or either inside a longer text ("Okon (a5)"). */
export function memberRef<M extends { id: string; name: string }>(ref: unknown, members: M[]): M | undefined {
  const r = String(ref ?? '').trim().toLowerCase();
  if (!r) return undefined;
  const esc = (x: string) => x.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return members.find((m) => m.id.toLowerCase() === r || m.name.toLowerCase() === r)
    ?? members.find((m) => new RegExp(`(^|[^a-z0-9])(${esc(m.id)}|${esc(m.name)})([^a-z0-9]|$)`).test(r));
}

/**
 * Validates a joint plan's raw steps against the plan schema: a step whose `who` is missing or unknown
 * goes to `authorId` (or is dropped without one), a step that cannot be understood is dropped, and each
 * member keeps at most `maxPerMember` steps. Returns the valid steps and what was dropped (for the log).
 */
export function repairSteps<M extends { id: string; name: string }>(
  raw: unknown[], members: M[], authorId: string | undefined, textMax: number, maxPerMember: number,
): { steps: PlanStep[]; dropped: string[] } {
  const steps: PlanStep[] = [];
  const dropped: string[] = [];
  const perMember = new Map<string, number>();
  for (const s of raw) {
    const r = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    const who = memberRef(r.who, members) ?? (authorId ? members.find((m) => m.id === authorId) : undefined);
    const what = String(r.action ?? '?');
    if (!who) {
      dropped.push(`${what}: who ${String(r.who ?? '-')}`);
      continue;
    }
    const n = perMember.get(who.id) ?? 0;
    if (n >= maxPerMember) continue;
    const [step] = normalizeSteps([s], textMax, 1);
    if (!step) {
      dropped.push(`${what}: invalid`);
      continue;
    }
    step.args.who = who.id;
    steps.push(step);
    perMember.set(who.id, n + 1);
  }
  return { steps, dropped };
}

/** A structured output (JSON text) as an object, or undefined for prose. */
export function jsonOf(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const failureText = (f: MemberFailure) => `${f.name}: ${f.status}${f.reason ? ` (${f.reason})` : ''}`;

export class GroupManager {
  readonly groups = new Map<string, Group>();
  private nextId = 1;
  /** Model of each member run (by run name) of the decision being built, for cost booking. */
  private readonly models = new Map<string, string>();
  private readonly host: DecideHost;
  private readonly events: GroupEvents;

  constructor(host: DecideHost, events: GroupEvents) {
    this.host = host;
    this.events = events;
  }

  private get cfg(): GameConfig {
    return this.host.cfg;
  }

  private get t(): Translate {
    return this.host.t;
  }

  list(): Group[] {
    return [...this.groups.values()];
  }

  byName(name: string): Group | undefined {
    const n = name.trim().toLowerCase();
    return this.list().find((g) => g.name.toLowerCase() === n || g.id === name);
  }

  of(e: RtEntity): Group | undefined {
    return e.groupId ? this.groups.get(e.groupId) : undefined;
  }

  // ---- membership -------------------------------------------------------------

  create(name: string, pattern: GroupPattern, founders: RtEntity[], leader: RtEntity | null): Group | string {
    const clean = name.trim().replace(new RegExp(SEP, 'g'), '_').slice(0, this.cfg.groups.nameMaxChars);
    if (!clean) return 'name';
    if (pattern !== 'crowd' && !AGENT_PATTERNS.includes(pattern)) return 'pattern';
    if (this.byName(clean)) return 'taken';
    if (founders.some((f) => f.groupId)) return 'member';
    const id = `g${this.nextId++}`;
    const colors = this.cfg.groups.colors;
    const g: Group = {
      id, name: clean, pattern, members: [], leader: leader?.id ?? null, color: colors[(this.nextId - 2) % colors.length] ?? '#888888',
      complete: false, memory: [],
    };
    this.groups.set(id, g);
    for (const f of founders) this.attach(g, f);
    g.complete = g.members.length >= this.cfg.groups.minMembers;
    this.events.formed(g);
    this.events.changed(g);
    return g;
  }

  private attach(g: Group, e: RtEntity): void {
    g.members.push(e.id);
    e.groupId = g.id;
  }

  join(g: Group, e: RtEntity): string | undefined {
    if (e.groupId === g.id) return undefined;
    if (e.groupId) this.leave(e);
    if (g.members.length >= this.cfg.groups.maxMembers) return 'full';
    this.attach(g, e);
    if (g.members.length >= this.cfg.groups.minMembers) g.complete = true;
    this.events.joined(g, e);
    this.events.changed(g);
    return undefined;
  }

  leave(e: RtEntity): Group | undefined {
    const g = this.of(e);
    if (!g) return undefined;
    g.members = g.members.filter((id) => id !== e.id);
    e.groupId = null;
    // The most esteemed member takes the lead (rule esteem_vote_weight; ties: who joined first).
    if (g.leader === e.id) g.leader = g.pattern === 'crowd' ? null : ([...g.members].sort((a, b) => this.host.voteWeight(b) - this.host.voteWeight(a))[0] ?? null);
    this.events.left(g, e);
    if (!g.members.length || (g.complete && g.pattern !== 'crowd' && g.members.length < this.cfg.groups.minMembers)) this.dissolve(g);
    else this.events.changed(g);
    return g;
  }

  dissolve(g: Group): void {
    for (const id of g.members) {
      const m = this.host.world().entities.get(id);
      if (m) m.groupId = null;
    }
    g.members = [];
    this.groups.delete(g.id);
    this.events.removed(g);
  }

  /** A group decides jointly only when it has enough living members. */
  active(g: Group): boolean {
    return g.members.length >= (g.pattern === 'crowd' ? 1 : this.cfg.groups.minMembers);
  }

  // ---- decisions ----------------------------------------------------------------

  private livingMembers(g: Group): RtEntity[] {
    const w = this.host.world();
    const ms = g.members.map((id) => w.entities.get(id)).filter((m): m is RtEntity => !!m && m.alive);
    const lead = ms.find((m) => m.id === g.leader);
    return lead ? [lead, ...ms.filter((m) => m !== lead)] : ms;
  }

  /** Step counts per member: from the leader's (first member's) tier, or the given one. */
  private counts(members: RtEntity[], tier?: Tier): { min: number; max: number; horizon: number; maxTokens: number } {
    const tc = this.cfg.decisions.tiers[tier ?? decisionTier(members[0]!, this.cfg)];
    const horizon = this.host.world().r('plan_horizon_minutes') * tc.horizonFactor;
    return { min: Math.min(this.host.cfg.mock.planSteps, tc.maxSteps), max: tc.maxSteps, horizon, maxTokens: tc.maxOutputTokens };
  }

  /** The situation every member reads (the team's task). */
  private situation(g: Group, members: RtEntity[], why: string, crowd = false): string {
    const t = this.t;
    const w = this.host.world();
    const c = this.counts(members);
    const lead = members[0]!;
    const inbox = { ...lead, inbox: members.flatMap((m) => m.inbox).sort((a, b) => a.day - b.day || a.minute - b.minute).slice(-this.cfg.decisions.inboxItems) };
    return [
      crowd ? t('rt.group.crowdHeader', { horizon: Math.round(c.horizon) }) : t('rt.group.header', { name: g.name, pattern: t(`rt.pattern.${g.pattern}`), horizon: Math.round(c.horizon) }),
      timeLine(t, w),
      t('rt.group.members', { members: members.map((m) => memberLine(t, w, m, this.host.roleTitle)).join('\n') }),
      t('rt.observation.why', { why }),
      t('rt.observation.perceive', { look: look(t, w, lead, this.host.groups(), this.host.roleTitle, limitsOf(this.cfg), (b) => this.host.perceived.about(lead, b)) }),
      inboxBlock(t, inbox),
      t('rt.observation.memory', { memory: g.memory.length ? g.memory.map((m) => `- ${m}`).join('\n') : t('rt.observation.noMemory') }),
    ].join('\n\n');
  }

  /** How a plan writer commits the joint plan (only writers hold commit_plan). */
  private formatText(members: RtEntity[], tier?: Tier): string {
    const c = this.counts(members, tier);
    return this.t('rt.group.format', { minSteps: c.min, maxSteps: c.max });
  }

  private instructionsOf(m: RtEntity, g: Group, withFaculties: boolean): string {
    const role = this.host.roleOf(m.role);
    const vars = { name: m.name, personality: m.personality || '-', roleTitle: role?.title ?? m.role, role: m.role, group: g.name };
    return [this.t('rt.memberInstructions', vars), withFaculties ? this.t('rt.group.faculties') : ''].filter(Boolean).join('\n');
  }

  /** The model tier a member uses in a capacity: its own when deciding, else `groups.memberTier` (when set). */
  private tierFor(m: RtEntity, deciding: boolean): Tier {
    const own = decisionTier(m, this.cfg);
    const cheap = this.cfg.groups.memberTier;
    return deciding || !cheap ? own : cheap;
  }

  private modelFor(m: RtEntity, deciding: boolean): string {
    const tier = this.tierFor(m, deciding);
    return tier === decisionTier(m, this.cfg) ? m.model : (this.host.sim.modelOverride ?? this.host.sim.models[tier]);
  }

  /**
   * Members consulted besides the one deciding: at most `groups.maxProposers`, the most esteemed
   * first (rule esteem_vote_weight; ties keep the group's order).
   */
  private consulted(members: RtEntity[], max = this.cfg.groups.maxProposers): RtEntity[] {
    if (!(max > 0) || members.length <= max) return members;
    return members.map((m, i) => ({ m, i, w: this.host.voteWeight(m.id) })).sort((a, b) => b.w - a.w || a.i - b.i).slice(0, max).sort((a, b) => a.i - b.i).map((x) => x.m);
  }

  /** commit_plan for whoever writes the joint plan: the call ends the writer's run with the plan as its data. */
  private planTool(max: number) {
    return tool<{ reason: string; steps: unknown[] }>('commit_plan', this.t('rt.group.commitPlan'), planSchema(this.t, this.cfg.decisions.textMaxChars, true, max), (args) => {
      if (!Array.isArray(args?.steps) || !args.steps.length) return { content: this.t('rt.act.noSteps'), isError: true };
      const summary = String(args.reason ?? '');
      return { content: summary || this.t('rt.group.planCaptured'), stop: true, data: { summary, steps: args.steps } satisfies PlanData };
    });
  }

  /**
   * One member acting in one capacity: its model (own when `deciding`, else `groups.memberTier`), identity,
   * tools and (when offline) a scripted mock. Plan writers (`json`) get commit_plan and its format; judges,
   * voters and routers (`structured`) get no tools; prose proposers get their faculties and the prose format.
   */
  private member(
    m: RtEntity, g: Group, role: TraceRole,
    opts: {
      json?: boolean; structured?: boolean; deciding?: boolean; output?: Record<string, unknown>; extra?: string; description?: string;
      mock: (req: ModelRequest, i: number) => MockTurn; turns?: number; members?: RtEntity[];
    },
  ): EasyAgent {
    const deciding = opts.deciding === true;
    const tier = this.tierFor(m, deciding);
    const model = this.modelFor(m, deciding);
    const counts = this.counts([m], tier);
    const tc = this.cfg.decisions.tiers[tier];
    const name = `${m.id}${SEP}${role}`;
    this.models.set(name, model);
    const bare = opts.structured === true;
    const tools = bare ? [] : [...(opts.json ? [this.planTool(counts.max)] : []), ...faculties(this.host, m, tc.maxConsults)];
    const format = bare ? '' : opts.json ? this.formatText(opts.members ?? [m], tier) : this.t('rt.group.proposeFormat');
    const p = this.cfg.decisions.modelParams;
    return agent({
      name,
      description: opts.description,
      model: modelRef(this.host, model, this.mockWithConsult(g, m, opts.json === true, opts.mock), this.cfg.mock.thinkDelayMs),
      params: opts.json ? { ...p.plan, maxTokens: counts.maxTokens } : { ...p.prose, maxTokens: this.cfg.groups.proseMaxOutputTokens },
      ...(opts.output ? { output: opts.output } : {}),
      instructions: [this.instructionsOf(m, g, !bare), opts.extra, format].filter(Boolean).join('\n'),
      tools,
      budget: { maxTurns: (opts.turns ?? this.cfg.groups.maxTurns) + (bare ? 0 : tc.maxConsults) + (opts.json ? 1 : 0) },
    });
  }

  /** Offline only: members writing a joint plan sometimes consult Lorebase first. */
  private mockWithConsult(g: Group, m: RtEntity, json: boolean, mock: (req: ModelRequest, i: number) => MockTurn): (req: ModelRequest, i: number) => MockTurn {
    return (req, i) => {
      const consulted = req.messages.some((x) => x.role === 'tool');
      const seed = [...`${m.id}${this.host.world().minute}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
      if (json && g.pattern !== 'orchestrator' && !consulted && this.host.brain.connected && seed % 2 === 0) {
        return { toolCalls: [{ name: 'lorebase_search', args: { query: this.t('rt.mock.consult'), kinds: ['Rule'], limit: 3 } }] };
      }
      return mock(req, i);
    };
  }

  /** Offline: the joint plan writer commits a scripted plan. */
  private mockPlanCall(members: RtEntity[]): MockTurn {
    const c = this.counts(members);
    const p = mockGroupPlan(this.t, this.host.world(), members, { min: c.min, max: c.max }, this.cfg.mock);
    return { toolCalls: [{ name: 'commit_plan', args: { reason: p.summary, steps: flatSteps(p.steps).map((s) => ({ who: (s as { who?: string }).who, ...s })) } }] };
  }

  private mockProse(m: RtEntity): string {
    const p = mockSteps(this.t, this.host.world(), m, { min: 3, max: 3 }, { ...this.cfg.mock, experimentChance: 0 });
    return this.t('rt.mock.proposal', { label: p.steps[0]?.label ?? this.t('rt.mock.label.wait') });
  }

  /** Builds the reinloop team (or single agent) for a group's pattern. */
  private build(g: Group, members: RtEntity[]): { runner: EasyAgent | ReturnType<typeof team> } {
    const t = this.t;
    const tpl = (k: string) => t(`rt.group.tpl.${k}`);
    const planCall = () => this.mockPlanCall(members);
    const opts = { maxRounds: this.cfg.groups.maxRounds };
    const [lead, ...rest] = members;
    const writer = { json: true, members };
    const judgeMock = (_r: ModelRequest, i: number): MockTurn => ({ text: JSON.stringify(i === 0 && opts.maxRounds > 1 ? { pass: false, feedback: t('rt.mock.judgeFix') } : { pass: true, feedback: t('rt.mock.judgeOk') }) });
    switch (g.pattern) {
      case 'orchestrator': {
        const workers = this.consulted(rest).map((m) => this.member(m, g, 'proposer', { description: t('rt.group.workerTool', { name: m.name, role: this.host.roleTitle(m.role) }), mock: () => ({ text: this.mockProse(m) }) }));
        const leader = this.member(lead!, g, 'leader', {
          ...writer,
          deciding: true,
          turns: workers.length + 3,
          mock: (req) => {
            const asked = req.messages.some((x) => x.role === 'tool');
            if (asked || !workers.length) return planCall();
            return { toolCalls: workers.map((w) => ({ name: safeToolName(w.name), args: { task: t('rt.group.routeTask') } })) };
          },
        });
        return { runner: team(`${g.id}-orchestrator`, 'orchestrator', { orchestrator: leader, workers: workers.length ? workers : [leader] }) };
      }
      case 'council': {
        const elder = members.find((m) => m.role === 'elder') ?? lead!;
        const others = members.filter((m) => m !== elder);
        const proposers = this.consulted(others.length ? others : members).map((m) => this.member(m, g, 'proposer', { deciding: m === elder, mock: () => ({ text: this.mockProse(m) }) }));
        const merge = this.member(elder, g, 'leader', { ...writer, deciding: true, mock: planCall });
        const judge = this.member(elder, g, 'critic', { structured: true, deciding: true, output: VERDICT, mock: judgeMock });
        const proposals = team(`${g.id}-proposals`, this.proposalsPattern(tpl('aggregate')), { workers: proposers, aggregator: merge });
        return { runner: team(`${g.id}-council`, this.councilPattern(opts.maxRounds), { generator: proposals, evaluator: judge }) };
      }
      case 'router': {
        const candidates = this.consulted(members);
        const routes = candidates.map((m) => this.member(m, g, 'proposer', {
          ...writer,
          description: t('rt.group.route', { name: m.name, role: this.host.roleTitle(m.role), description: this.host.roleOf(m.role)?.description ?? '' }),
          mock: planCall,
        }));
        const pick = () => {
          const hungry = members.some((m) => m.hunger >= this.host.world().r('critical_hunger'));
          const want = hungry ? 'gatherer' : this.host.world().isNight() ? 'builder' : 'explorer';
          return candidates.find((m) => m.role === want) ?? candidates[candidates.length - 1]!;
        };
        const router = this.member(lead!, g, 'router', {
          structured: true,
          deciding: true,
          mock: () => {
            const m = pick();
            return { text: JSON.stringify({ route: `${m.id}${SEP}proposer`, reason: t('rt.mock.routeReason', { name: m.name }) }) };
          },
        });
        return { runner: team(`${g.id}-router`, 'router', { router, routes }, { template: tpl('route') }) };
      }
      case 'chain': {
        const ordered = [...members].sort((a, b) => Number(b.role === 'explorer') - Number(a.role === 'explorer'));
        const doer = lead!;
        const before = this.consulted(ordered.filter((m) => m !== doer));
        const steps = before.map((m, i) => this.member(m, g, i === 0 ? 'proposer' : 'critic', {
          extra: i === 0 ? t('rt.group.chainScout', { name: m.name, id: m.id, group: g.name }) : t('rt.group.chainPlanner', { name: m.name, id: m.id, group: g.name }),
          mock: () => {
            const w = this.host.world();
            const f = w.tiles.find((x) => x.food >= 2 && Math.hypot(x.x - m.x, x.y - m.y) < 6) ?? { x: Math.round(m.x), y: Math.round(m.y) };
            const wd = w.tiles.find((x) => x.wood >= 2 && Math.hypot(x.x - m.x, x.y - m.y) < 8) ?? f;
            return { text: i === 0 ? t('rt.mock.scout', { x: f.x, y: f.y, wx: wd.x, wy: wd.y }) : this.mockProse(m) };
          },
        }));
        const last = this.member(doer, g, 'leader', { ...writer, deciding: true, extra: t('rt.group.chainDoer', { name: doer.name, id: doer.id, group: g.name }), mock: planCall });
        return { runner: team(`${g.id}-chain`, 'chain', { steps: [...steps, last] }, { template: tpl('chain') }) };
      }
      case 'mentor': {
        const mentor = members.find((m) => m.role === 'elder') ?? lead!;
        const apprentice = members.find((m) => m !== mentor) ?? mentor;
        const gen = this.member(apprentice, g, 'proposer', { ...writer, deciding: apprentice === mentor, mock: planCall });
        const judge = this.member(mentor, g, 'critic', { structured: true, deciding: true, output: VERDICT, mock: judgeMock });
        return { runner: team(`${g.id}-mentor`, this.councilPattern(opts.maxRounds), { generator: gen, evaluator: judge }) };
      }
      case 'assembly': {
        // No one decides alone: every consulted member proposes and votes, on the members' tier.
        const voting = this.consulted(members);
        const proposers = voting.map((m) => this.member(m, g, 'proposer', { ...writer, mock: planCall }));
        const voters = voting.map((m, k) => this.member(m, g, 'voter', {
          structured: true,
          output: BALLOT,
          mock: () => ({ text: JSON.stringify({ choice: 1 + ((k + this.host.world().day) % Math.max(1, Math.min(2, voting.length))), reason: t('rt.mock.voteReason') }) }),
        }));
        return { runner: team(`${g.id}-assembly`, this.assemblyPattern(g, members, voting), { proposers, voters }) };
      }
      case 'crowd': {
        const model = this.host.sim.modelOverride ?? this.host.sim.models[this.cfg.crowd.tier];
        this.models.set(`${g.id}${SEP}leader`, model);
        const mind = agent({
          name: `${g.id}${SEP}leader`,
          model: modelRef(this.host, model, planCall, this.cfg.mock.thinkDelayMs),
          params: { ...this.cfg.decisions.modelParams.plan, maxTokens: this.counts(members).maxTokens },
          instructions: [t('rt.group.crowdHeader', { horizon: Math.round(this.counts(members).horizon) }), this.formatText(members)].join('\n'),
          tools: [this.planTool(this.counts(members).max)],
          budget: { maxTurns: this.cfg.groups.maxTurns },
        });
        return { runner: mind };
      }
    }
  }

  /**
   * Generator + judge rounds like reinloop's `evaluator`, but a judge that cannot answer does not
   * block the council (the plan stands), and a failed revision keeps the previous plan.
   */
  private councilPattern(maxRounds: number) {
    const t = this.t;
    const fill = (tplText: string, vars: Record<string, string>) => tplText.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');
    return definePattern({
      description: 'Members propose, the elder harmonizes; the elder judges and the council revises until approved.',
      roles: { generator: { description: 'Proposals and their harmonization' }, evaluator: { description: 'The elder judging', kind: 'agent' } },
      build: ({ generator, evaluator }) => async (input, ctx) => {
        const failures: MemberFailure[] = [];
        let cand = await ctx.call(generator as EasyAgent, input);
        failures.push(...memberFailures(cand, generator.name));
        let plan = planOf(cand);
        if (!plan) return { output: '', status: 'failed', reason: `proposals: ${cand.status}${cand.reason ? ` (${cand.reason})` : ''}`, failures };
        for (let round = 1; ; round++) {
          const output = JSON.stringify(plan);
          if (round >= maxRounds) return { output, data: plan, failures };
          const v = await ctx.call(evaluator as EasyAgent, fill(t('rt.group.tpl.evaluate'), { task: ctx.task, candidate: output }));
          failures.push(...memberFailures(v, evaluator.name));
          const verdict = v.status === 'completed' ? (v.data as { pass?: boolean; feedback?: string } | undefined) : undefined;
          if (!verdict || verdict.pass !== false) return { output, data: plan, failures };
          cand = await ctx.call(generator as EasyAgent, fill(t('rt.group.tpl.revise'), { task: ctx.task, candidate: output, feedback: String(verdict.feedback ?? '') }));
          failures.push(...memberFailures(cand, generator.name));
          plan = planOf(cand) ?? plan;
        }
      },
    });
  }

  /**
   * Like reinloop's `parallel` with an aggregator, but tolerant: a proposer whose run was cut short
   * (budget, max_tokens) still contributes whatever it said, and with no proposal at all the
   * aggregator (the elder) decides from the situation alone instead of failing the council.
   */
  private proposalsPattern(template: string) {
    const fill = (vars: Record<string, string>) => template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');
    return definePattern({
      description: 'Members propose concurrently; the elder harmonizes whatever was proposed (or decides alone).',
      roles: { workers: { description: 'Members proposing', many: true }, aggregator: { description: 'The elder harmonizing', kind: 'agent' } },
      build: ({ workers, aggregator }) => async (input, ctx) => {
        const ws = workers as EasyAgent[];
        const results = await Promise.all(ws.map((w) => ctx.call(w, input)));
        const failures = results.flatMap((r, i) => memberFailures(r, ws[i]!.name));
        const sections = results
          .map((r, i) => ({ name: ws[i]!.name, out: r.output.trim() }))
          .filter((x) => x.out)
          .map((x) => `## ${x.name}\n${x.out}`)
          .join('\n\n');
        const merge = aggregator as EasyAgent;
        const merged = await ctx.call(merge, sections ? fill({ task: ctx.task, results: sections }) : input);
        failures.push(...memberFailures(merged, merge.name));
        if (planOf(merged)) return { output: merged.output, data: merged.data, failures };
        const status = merged.status === 'completed' ? 'failed' : merged.status;
        return { output: '', status, reason: `${merge.name}: ${merged.status === 'completed' ? 'no plan committed' : `${merged.status}${merged.reason ? ` (${merged.reason})` : ''}`}`, failures };
      },
    });
  }

  /**
   * Custom reinloop pattern: everyone proposes a joint plan, everyone votes, majority wins. Proposals are
   * checked against the plan schema before the vote (steps repaired or dropped, see repairSteps); a
   * proposal left with no valid step is not put to the vote.
   */
  private assemblyPattern(g: Group, members: RtEntity[], voting: RtEntity[]) {
    const t = this.t;
    const c = this.counts(members);
    return definePattern({
      description: 'Every member proposes a joint plan, every member votes, the plurality wins.',
      roles: { proposers: { description: 'Members proposing', many: true }, voters: { description: 'Members voting', many: true } },
      build: ({ proposers, voters }) => async (input, ctx) => {
        const ps = proposers as EasyAgent[];
        const vs = voters as EasyAgent[];
        const results = await Promise.all(ps.map((p) => ctx.call(p, input)));
        const failures = results.flatMap((r, i) => memberFailures(r, ps[i]!.name));
        const plans = results.flatMap((r, i) => {
          const plan = planOf(r);
          if (!plan) return [];
          const author = voting[i]!;
          const fixed = repairSteps(plan.steps, members, author.id, this.cfg.decisions.textMaxChars, c.max);
          if (fixed.dropped.length) console.warn(`[group ${g.name}] proposal by ${author.name}: dropped ${fixed.dropped.length} step(s): ${fixed.dropped.slice(0, 4).join('; ')}`);
          return fixed.steps.length ? [{ i, plan: { summary: plan.summary, steps: fixed.steps as unknown[], author: author.id } satisfies PlanData }] : [];
        });
        if (!plans.length) return { output: '', status: 'failed', reason: 'no valid proposal', failures };
        const list = plans.map((p, k) => t('rt.group.proposalLine', { n: k + 1, name: voting[p.i]?.name ?? '?', summary: String(p.plan.summary ?? '') })).join('\n');
        if (plans.length === 1) return { output: JSON.stringify(plans[0]!.plan), data: { ...plans[0]!.plan, winner: 1 }, failures };
        const ballots = await Promise.all(vs.map((v, k) => ctx.call(v, t('rt.group.vote', { group: g.name, proposals: list, name: voting[k]?.name ?? '', id: voting[k]?.id ?? '' }))));
        failures.push(...ballots.flatMap((b, k) => memberFailures(b, vs[k]!.name)));
        const votes = ballots.map((b) => {
          const n = Number(b.status === 'completed' ? (b.data as { choice?: unknown } | undefined)?.choice : undefined);
          return Number.isInteger(n) ? n - 1 : null;
        });
        const result = tally(votes, plans.length, [0]);
        // Each ballot weighs by the voter's esteem (rule esteem_vote_weight).
        const weighted = weightedWinner(votes, voting.map((m) => this.host.voteWeight(m.id)), plans.length);
        const win = plans[weighted.winner]!;
        return { output: JSON.stringify(win.plan), data: { ...win.plan, votes: result.counts, weights: weighted.weights, winner: weighted.winner + 1, majority: result.majority }, failures };
      },
    });
  }

  /** Runs the group's pattern and returns the joint plan with the trace of how it was decided (or why there is none). */
  async decide(g: Group, why: string): Promise<JointPlan | Failure> {
    const members = this.livingMembers(g);
    if (!members.length) return { error: 'no living members' };
    const trace: TraceEntry[] = [];
    const names = new Map<string, string>();
    const max = this.cfg.groups.traceMaxChars;
    // Each member's model run is booked under the model it ran on (the team run would book it all under the lead's).
    const nested = new NestedUsage();
    let costUsd = 0;
    let calls = 0;
    const book = (who: { id: string; name: string; model: string; tier: string }, res: { status: string; costUsd?: number; usage?: { inputTokens?: number; outputTokens?: number } }) => {
      costUsd += res.costUsd ?? 0;
      this.host.ranModel(who, res);
    };
    const sink: Sink = {
      name: 'group-trace',
      onEvent: (ev: RunEvent) => {
        if (ev.type === 'run_start') names.set(ev.runId, (ev.data as { agent: string }).agent);
        const booked = nested.onEvent(ev);
        if (booked) {
          calls++;
          const runName = names.get(ev.runId) ?? '';
          const m = members.find((x) => x.id === runName.slice(0, Math.max(0, runName.lastIndexOf(SEP))));
          const model = this.models.get(runName) ?? m?.model ?? members[0]!.model;
          if (m) book({ id: model === m.model ? `${g.id}/${m.id}` : `${g.id}/${m.id}:${model}`, name: `${g.name}/${m.name}`, model, tier: `group:${g.pattern}` }, booked);
          else book({ id: g.id, name: g.name, model, tier: `group:${g.pattern}` }, booked);
        }
        if (ev.type !== 'run_end') return;
        const name = names.get(ev.runId) ?? '';
        const end = ev.data as { output?: string };
        const out = String(end.output ?? '');
        const cut = name.lastIndexOf(SEP);
        if (cut < 0 || !out.trim()) return;
        const member = name.slice(0, cut);
        const role = name.slice(cut + SEP.length) as TraceRole;
        const said = this.traceText(out, members).slice(0, max);
        trace.push({ member: g.pattern === 'crowd' ? g.id : member, role, text: said });
        this.host.deliberated(g, g.pattern === 'crowd' ? g.id : member, role, said);
      },
    };
    const { runner } = this.build(g, members);
    const task = this.situation(g, members, why, g.pattern === 'crowd');
    const res = await runner.run(task, { sinks: [sink, ...this.host.runSinks()], signal: AbortSignal.timeout(decisionTimeoutMs(this.cfg, this.host.world())) });
    const lead = members[0]!;
    book({ id: g.id, name: g.name, model: this.models.get(`${g.id}${SEP}leader`) ?? lead.model, tier: `group:${g.pattern}` }, nested.remainder(res));
    console.log(`[group ${g.name}] ${g.pattern} decision: ${res.status}, ${Math.max(calls, 1)} model run(s), estimated cost $${costUsd.toFixed(4)}`);
    // Per-member failures (budget stops included) as reported by the team patterns.
    const failures = (res.failures ?? []).map(failureText);
    if (res.status !== 'completed' && res.status !== 'stopped') {
      return { error: `${g.pattern} ${res.status}: ${res.reason ?? ''}${failures.length ? ` <- ${failures.slice(0, 4).join('; ')}` : ''}` };
    }
    if (failures.length) console.warn(`[group ${g.name}] ${g.pattern} decided despite: ${failures.slice(0, 4).join('; ')}`);
    const json = planOf(res);
    if (!json) return { error: `${g.pattern}: no joint plan committed` };
    const c = this.counts(members);
    // Steps without a valid `who` belong to whoever wrote the plan (or, unknown, to the lead).
    const { steps, dropped } = repairSteps(Array.isArray(json.steps) ? json.steps : [], members, json.author ?? lead.id, this.cfg.decisions.textMaxChars, c.max);
    if (dropped.length) console.warn(`[group ${g.name}] dropped ${dropped.length} step(s) of the joint plan: ${dropped.slice(0, 4).join('; ')}`);
    if (!steps.length) return { error: `${g.pattern}: the joint plan has no valid step` };
    const summary = String(json.summary ?? '').slice(0, this.cfg.decisions.textMaxChars) || steps[0]!.label;
    return { summary, steps, trace };
  }

  /** What a trace line shows: the gist of a member's output. */
  private traceText(out: string, members: RtEntity[]): string {
    const t = this.t;
    const j = jsonOf(out);
    if (!j) return out.trim();
    if (typeof j.route === 'string') {
      const id = j.route.split(SEP)[0];
      const name = members.find((m) => m.id === id)?.name ?? id;
      return `→ ${name}${j.reason ? `: ${String(j.reason)}` : ''}`;
    }
    if (j.choice !== undefined) return `#${String(j.choice)}${j.reason ? `: ${String(j.reason)}` : ''}`;
    if (typeof j.pass === 'boolean') return `${j.pass ? '✓' : '✗'} ${String(j.feedback ?? '')}`.trim();
    if (typeof j.summary === 'string') return j.summary;
    return t('rt.observation.none');
  }
}
