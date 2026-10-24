// One person's decisions with reinloop: a PLAN call (tools commit_plan, say, form_group,
// join_group, leave_group; the run ends as soon as a plan is committed) and a quick REPLY call
// when spoken to (streamed text, optional `rethink`). Each person uses its own model; the mock
// provider is only an offline fallback.
import { agent, type MockTurn, mockProvider, type ModelRef, type ModelRequest, type Sink, type Tool, tool } from 'reinloop';
import type { SimConfig } from '../config.ts';
import type { Translate } from '../i18n.ts';
import type { Role, RuleChange } from '../lorebase/rules.ts';
import type { Brain, ConsultEvent } from './brain.ts';
import type { Tier } from '../world/types.ts';
import { AGENT_PATTERNS, type GameConfig, type TierDecision } from './config.ts';
import { flatSteps, mockSteps, needsOf } from './mock.ts';
import { MODEL_ACTIONS, normalizeStep, type PlanStep } from './plan.ts';
import {
  doingLine, type GroupView, groupLine, inboxBlock, look, memoryBlock, type PromptLimits, recalledBlock, rtInstructions, rtObservation, selfLine, timeLine,
} from './prompt.ts';
import type { ActResult, RtEntity, RtWorld } from './world.ts';

export interface ToolOutcome {
  ok: boolean;
  text: string;
}

export interface DecideHost {
  world(): RtWorld;
  t: Translate;
  cfg: GameConfig;
  sim: SimConfig;
  mock: boolean;
  brain: Brain;
  roleOf(code: string): Role | undefined;
  roleTitle(code: string): string;
  groups(): GroupView[];
  /** Laws changed since this person last decided (and marks them as seen). */
  changedLaws(e: RtEntity): RuleChange[];
  say(e: RtEntity, to: string, text: string): ActResult;
  formGroup(e: RtEntity, name: string, pattern: string): ToolOutcome;
  joinGroup(e: RtEntity, name: string): ToolOutcome;
  leaveGroup(e: RtEntity): ToolOutcome;
  shareInsight(e: RtEntity, text: string, confidence: number, evidence: string): Promise<ToolOutcome>;
  reviewInsights(e: RtEntity): string;
  judgeInsight(e: RtEntity, code: string, verdict: 'approve' | 'reject', reason: string): Promise<ToolOutcome>;
  /** A group member said something while the group deliberated (reinloop pattern trace). */
  deliberated(g: { id: string; pattern: string }, memberId: string, role: string, text: string): void;
  /** Sinks every model run reports to (run logs kept in mnemo). */
  runSinks(): Sink[];
  /** A model run ended (usage and cost per agent, for the Observatory). */
  ranModel(who: { id: string; name: string; model: string; tier: string }, res: { status: string; usage?: { inputTokens?: number; outputTokens?: number }; costUsd?: number }): void;
  /** A person consulted Lorebase (shown to clients). */
  consulted(e: RtEntity, ev: ConsultEvent): void;
  /** The model's reasoning summary behind a decision (privileged clients only). */
  reasoned(e: RtEntity, text: string): void;
  /** What the person's private memory brings back for `query` (formatted lines; empty when none or unavailable). */
  recall(e: RtEntity, query: string): Promise<string[]>;
  /** Barter: propose an exchange, answer one addressed to you. */
  offer(e: RtEntity, to: string, give: unknown, want: unknown): ToolOutcome;
  answerOffer(e: RtEntity, id: string, accept: boolean): ToolOutcome;
  /** Ask for something without offering anything (answered like an offer). */
  ask(e: RtEntity, to: string, item: string, amount: number): ToolOutcome;
  /** A witness's account of a social law kept or broken by someone. */
  testify(e: RtEntity, input: { chi?: unknown; legge?: unknown; rispettata?: unknown; motivo?: unknown }): ToolOutcome;
  /** An opinion about someone (kept in the judge's private memory and in the society). */
  judge(e: RtEntity, who: string, score: number, reason: string): ToolOutcome;
  /** A law proposal (a Lorebase Proposal reviewed by humans). */
  proposeLaw(e: RtEntity, input: { key?: unknown; text?: unknown; category?: unknown; value?: unknown }): Promise<ToolOutcome>;
  /** Weight of a person's vote and claim to lead a group (from esteem). */
  voteWeight(id: string): number;
  /** Society in perception: what is said about a person, offers, hearsay (factual lines, no numbers). */
  perceived: PerceivedSociety;
}

export interface PerceivedSociety {
  /** What `e` has heard of `b` (empty when nothing). */
  about(e: RtEntity, b: RtEntity): string;
  /** Extra observation blocks for `e` (age, offers, hearsay). */
  blocks(e: RtEntity): string[];
  /** Pending offers addressed to `e` (ids), for the mock. */
  offersFor(e: RtEntity): Array<{ id: string; want: Record<string, number> }>;
}

/** Why a decision produced nothing (logged and counted by the caller). */
export interface Failure {
  error: string;
}

export const isFailure = (v: unknown): v is Failure => !!v && typeof v === 'object' && typeof (v as Failure).error === 'string';

/** Lorebase read tools (bounded per decision) and the private memory of one person. */
export function faculties(host: DecideHost, e: RtEntity, maxConsults: number): Tool[] {
  return [
    ...host.brain.lorebaseTools({ left: maxConsults, onConsult: (ev) => host.consulted(e, ev) }),
    ...host.brain.memoryTools(e.name, () => ({ day: host.world().day, minute: host.world().minute }), host.cfg.memory.ingest.remember ?? { importance: 0.5, emotion: 0 }),
  ];
}

export interface Decision {
  steps: PlanStep[];
  reason: string;
}

/** Tier used for decisions: players never decide here; crowd extras use the crowd tier. */
export function decisionTier(e: RtEntity, cfg: GameConfig): Tier {
  return e.tier === 'human' ? cfg.crowd.tier : e.tier;
}

export function tierConfig(e: RtEntity, cfg: GameConfig): TierDecision {
  return cfg.decisions.tiers[decisionTier(e, cfg)];
}

/** Real milliseconds per game minute at the current time scale (rule game_minutes_per_real_second). */
export function realMsPerGameMinute(w: Pick<RtWorld, 'r' | 'timeScale'>): number {
  return 1000 / Math.max(1e-6, w.r('game_minutes_per_real_second') * w.timeScale);
}

/**
 * How long a decision may take: `decisions.timeoutGameMinutes` of game time, in real time between
 * `timeoutMinMs` (a model call needs that long whatever the time scale) and `timeoutMs`.
 */
export function decisionTimeoutMs(cfg: GameConfig, w: Pick<RtWorld, 'r' | 'timeScale'>): number {
  const d = cfg.decisions;
  const game = d.timeoutGameMinutes * realMsPerGameMinute(w);
  return Math.round(Math.min(d.timeoutMs, Math.max(d.timeoutMinMs, game)));
}

export function limitsOf(cfg: GameConfig): PromptLimits {
  return { lookMaxTiles: cfg.decisions.lookMaxTiles, lookMaxPeople: cfg.decisions.lookMaxPeople, nearbyGroupsMax: cfg.decisions.nearbyGroupsMax, ...cfg.decisions.perception };
}

/**
 * Model reference for an entity: its own model, or a scripted mock when offline. The mock's delay is in
 * game time (divided by the time scale), so a sped-up world does not leave people idle while it "thinks".
 */
export function modelRef(host: Pick<DecideHost, 'mock' | 'world'>, model: string, script: (req: ModelRequest, i: number) => MockTurn, delayMs: number): string | ModelRef {
  if (host.mock) {
    return { provider: mockProvider([(req, i) => ({ delayMs: delayMs / Math.max(1, host.world().timeScale), ...script(req, i) })], { loop: true, name: 'mock' }), model: `mock/${model}` };
  }
  // `anthropic/<model>` resolves through reinloop's preset (ANTHROPIC_WORKSPACE_ID becomes the workspace header).
  return model;
}

/** JSON Schema of the commit_plan tool. The step count is a suggestion (`maxSteps` only caps what is kept). */
export function planSchema(t: Translate, textMax: number, withWho = false, maxSteps?: number): Record<string, unknown> {
  const step: Record<string, unknown> = {
    type: 'object',
    properties: {
      ...(withWho ? { who: { type: 'string' } } : {}),
      action: { enum: [...MODEL_ACTIONS] },
      x: { type: 'integer' },
      y: { type: 'integer' },
      to: { type: 'string' },
      resource: { type: 'string', description: t('rt.tools.stepResource') },
      item: { type: 'string', description: t('rt.tools.stepItem') },
      items: { type: 'array', items: { type: 'string' }, description: t('rt.tools.stepItems') },
      recipe: { type: 'string', description: t('rt.tools.stepRecipe') },
      give: { type: 'object', additionalProperties: { type: 'integer' }, description: t('rt.tools.offerGive') },
      want: { type: 'object', additionalProperties: { type: 'integer' }, description: t('rt.tools.offerWant') },
      amount: { type: 'integer' },
      text: { type: 'string', maxLength: textMax },
      minutes: { type: 'number' },
      label: { type: 'string', description: t('rt.tools.stepLabel') },
    },
    required: ['action', 'label'],
  };
  return {
    type: 'object',
    properties: {
      reason: { type: 'string', description: t('rt.tools.planReason') },
      steps: { type: 'array', items: step, description: maxSteps ? t('rt.tools.planStepsUpTo', { maxSteps }) : t('rt.tools.planSteps') },
    },
    required: ['reason', 'steps'],
  };
}

export function normalizeSteps(raw: unknown, textMax: number, max: number): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => normalizeStep(s, textMax)).filter((s): s is PlanStep => !!s).slice(0, max);
}

function socialTools(host: DecideHost, e: RtEntity): Tool[] {
  const t = host.t;
  const max = host.cfg.decisions.textMaxChars;
  return [
    tool<{ to: string; text: string }>('say', t('rt.tools.say'), { to: `string: ${t('rt.tools.sayTo')}`, text: `string: ${t('rt.tools.sayText')}` }, ({ to, text }) => {
      const out = host.say(e, String(to ?? 'all'), String(text ?? '').slice(0, max));
      return out.ok ? t('rt.act.said', { text: String(text).slice(0, max) }) : { content: t(`rt.reason.${out.reason ?? 'failed'}`), isError: true };
    }),
    tool<{ name: string; pattern: string }>('form_group', t('rt.tools.formGroup'), { name: `string: ${t('rt.tools.groupName')}`, pattern: AGENT_PATTERNS }, ({ name, pattern }) => {
      const out = host.formGroup(e, String(name ?? ''), String(pattern ?? ''));
      return { content: out.text, isError: !out.ok };
    }),
    tool<{ name: string }>('join_group', t('rt.tools.joinGroup'), { name: `string: ${t('rt.tools.groupName')}` }, ({ name }) => {
      const out = host.joinGroup(e, String(name ?? ''));
      return { content: out.text, isError: !out.ok };
    }),
    tool('leave_group', t('rt.tools.leaveGroup'), {}, () => {
      const out = host.leaveGroup(e);
      return { content: out.text, isError: !out.ok };
    }),
    tool<{ text: string; confidence: number; evidence?: string }>('share_insight', t('rt.tools.shareInsight'), {
      text: `string: ${t('rt.tools.insightText')}`, confidence: `number: ${t('rt.tools.insightConfidence')}`, evidence: `string?: ${t('rt.tools.insightEvidence')}`,
    }, async ({ text, confidence, evidence }) => {
      const out = await host.shareInsight(e, String(text ?? ''), Number(confidence), String(evidence ?? ''));
      return { content: out.text, isError: !out.ok };
    }),
    tool<{ to: string; give: unknown; want: unknown }>('scambia', t('rt.tools.offer'), {
      to: `string: ${t('rt.tools.offerTo')}`,
      give: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 }, description: t('rt.tools.offerGive') },
      want: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 }, description: t('rt.tools.offerWant') },
    }, ({ to, give, want }) => {
      const out = host.offer(e, String(to ?? ''), give, want);
      return { content: out.text, isError: !out.ok };
    }),
    tool<{ a: string; item: string; amount: number }>('chiedi', t('rt.tools.ask'), {
      a: `string: ${t('rt.tools.offerTo')}`, item: `string: ${t('rt.tools.askItem')}`, amount: `integer: ${t('rt.tools.askAmount')}`,
    }, ({ a, item, amount }) => {
      const out = host.ask(e, String(a ?? ''), String(item ?? ''), Number(amount ?? 1));
      return { content: out.text, isError: !out.ok };
    }),
    tool<{ offer: string; accept: boolean }>('rispondi_scambio', t('rt.tools.answerOffer'), {
      offer: `string: ${t('rt.tools.offerId')}`, accept: `boolean: ${t('rt.tools.offerAccept')}`,
    }, ({ offer, accept }) => {
      const out = host.answerOffer(e, String(offer ?? ''), accept === true || String(accept) === 'true');
      return { content: out.text, isError: !out.ok };
    }),
    tool<{ chi: string; voto: number; motivo: string }>('giudica', t('rt.tools.judge'), {
      chi: `string: ${t('rt.tools.judgeWho')}`, voto: `number: ${t('rt.tools.judgeScore')}`, motivo: `string: ${t('rt.tools.judgeReason')}`,
    }, ({ chi, voto, motivo }) => {
      const out = host.judge(e, String(chi ?? ''), Number(voto), String(motivo ?? ''));
      return { content: out.text, isError: !out.ok };
    }),
    tool<{ chi: string; legge: string; rispettata: boolean; motivo: string }>('testimonia', t('rt.tools.testify'), {
      chi: `string: ${t('rt.tools.judgeWho')}`, legge: `string: ${t('rt.tools.testifyLaw')}`, rispettata: `boolean: ${t('rt.tools.testifyKept')}`, motivo: `string: ${t('rt.tools.judgeReason')}`,
    }, (args) => {
      const out = host.testify(e, args ?? {});
      return { content: out.text, isError: !out.ok };
    }),
    tool<{ key?: string; text: string; category: string; value?: number }>('proponi_legge', t('rt.tools.proposeLaw'), {
      key: `string?: ${t('rt.tools.lawKey')}`, text: `string: ${t('rt.tools.lawText')}`, category: ['survival', 'economy', 'climate', 'society', 'time'], value: `number?: ${t('rt.tools.lawValue')}`,
    }, async (args) => {
      const out = await host.proposeLaw(e, args ?? {});
      return { content: out.text, isError: !out.ok };
    }),
    tool('review_insights', t('rt.tools.reviewInsights'), {}, () => host.reviewInsights(e), { risk: 'read' }),
    tool<{ code: string; verdict: 'approve' | 'reject'; reason: string }>('judge_insight', t('rt.tools.judgeInsight'), {
      code: `string: ${t('rt.tools.insightCode')}`, verdict: ['approve', 'reject'], reason: `string: ${t('rt.tools.insightReason')}`,
    }, async ({ code, verdict, reason }) => {
      const out = await host.judgeInsight(e, String(code ?? ''), verdict === 'approve' ? 'approve' : 'reject', String(reason ?? ''));
      return { content: out.text, isError: !out.ok };
    }),
  ];
}

/** Mock decision: sometimes a Lorebase consultation first, then social moves and a plan. */
function mockDecision(host: DecideHost, e: RtEntity, tc: TierDecision, req: ModelRequest): MockTurn {
  const consulted = req.messages.some((m) => m.role === 'tool');
  const seed = [...`${e.id}${host.world().minute}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  if (!consulted && host.brain.connected && tc.maxConsults > 0 && seed % 3 === 0) {
    return { toolCalls: [{ name: 'lorebase_search', args: { query: host.t('rt.mock.consult'), kinds: ['Rule'], limit: 3 } }] };
  }
  return mockPlanTurn(host, e, tc);
}

function mockPlanTurn(host: DecideHost, e: RtEntity, tc: TierDecision): MockTurn {
  const t = host.t;
  const w = host.world();
  const calls: Array<{ name: string; args: unknown }> = [];
  const groups = host.groups();
  if (!e.groupId && e.kind === 'agent') {
    const invite = groups.find((g) => g.pattern !== 'crowd' && e.inbox.some((m) => m.text.includes(g.name)));
    const hash = [...`${e.id}${w.day}${w.minute}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    const partner = w.living().find((b) => b.id !== e.id && b.kind === 'agent' && !b.groupId && Math.hypot(b.x - e.x, b.y - e.y) <= w.r('speech_radius'));
    if (invite) {
      calls.push({ name: 'say', args: { to: 'all', text: t('rt.mock.say.accept', { group: invite.name }) } });
      calls.push({ name: 'join_group', args: { name: invite.name } });
    } else if (partner && e.tier !== 'haiku' && hash % 3 === 0) {
      const name = t('rt.mock.groupName', { name: e.name });
      calls.push({ name: 'say', args: { to: partner.name, text: t('rt.mock.say.invite', { group: name }) } });
      calls.push({ name: 'form_group', args: { name, pattern: AGENT_PATTERNS[hash % AGENT_PATTERNS.length] } });
    }
  }
  // Barter, opinions and laws (a stand-in for a model: deterministic chances from config).
  const roll = (salt: string) => ([...`${salt}${e.id}${w.day}${w.minute}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 11) % 1000) / 1000;
  const m = host.cfg.mock;
  for (const o of host.perceived.offersFor(e)) {
    const can = Object.entries(o.want).every(([k, n]) => (e.inventory[k] ?? 0) >= n);
    calls.push({ name: 'rispondi_scambio', args: { offer: o.id, accept: can } });
  }
  const near = w.living().filter((b) => b.id !== e.id && b.kind !== 'player' && Math.hypot(b.x - e.x, b.y - e.y) <= w.r('speech_radius'));
  // What my recipes use and I lack, and what a neighbour carries of it.
  const needs = needsOf(w, e.role);
  const lacking = (b: RtEntity) => Object.keys(b.inventory).filter((k) => needs.has(k) && (b.inventory[k] ?? 0) >= 1 && (e.inventory[k] ?? 0) < 2);
  if (e.kind === 'agent' && near.length && roll('offer') < m.offerChance) {
    const b = near.find((x) => lacking(x).length) ?? near[Math.floor(roll('who') * near.length)]!;
    const mine = Object.keys(e.inventory).filter((k) => (e.inventory[k] ?? 0) >= 1);
    const theirNeeds = needsOf(w, b.role);
    const theirs = Object.keys(b.inventory).filter((k) => (b.inventory[k] ?? 0) >= 1 && !mine.includes(k));
    const give = mine.find((k) => theirNeeds.has(k) && !needs.has(k)) ?? mine.find((k) => k !== 'food') ?? mine[0];
    const want = lacking(b)[0] ?? theirs[0] ?? Object.keys(b.inventory).find((k) => k !== give && (b.inventory[k] ?? 0) >= 1);
    if (give && want && give !== want) calls.push({ name: 'scambia', args: { to: b.name, give: { [give]: 1 }, want: { [want]: 1 } } });
  } else if (e.kind === 'agent' && roll('ask') < m.askChance) {
    const b = near.find((x) => lacking(x).length);
    if (b) calls.push({ name: 'chiedi', args: { a: b.name, item: lacking(b)[0], amount: 1 } });
  }
  if (e.kind === 'agent' && near.length && roll('judge') < m.judgeChance) {
    const b = near[Math.floor(roll('whom') * near.length)]!;
    const pair = [...`${e.id}>${b.id}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 5) % 5;
    const score = [-0.6, 0.2, 0.5, 0.8, 1][pair]!;
    calls.push({ name: 'giudica', args: { chi: b.name, voto: score, motivo: t(`rt.mock.opinion.${score > 0 ? 'good' : 'bad'}`, { name: b.name }) } });
  }
  if (e.kind === 'agent' && roll('law') < m.lawChance) {
    calls.push({ name: 'proponi_legge', args: { text: t('rt.mock.law', { name: e.name }), category: 'society' } });
  }
  // Shared consciousness: judge a peer's pending idea, or now and then share one.
  const pendingCode = /^- (\S+):/m.exec(host.reviewInsights(e))?.[1];
  const seed = [...`${e.id}${w.day}${w.minute}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 3);
  if (e.kind === 'agent' && pendingCode) calls.push({ name: 'judge_insight', args: { code: pendingCode, verdict: 'approve', reason: t('rt.mock.judgeOk') } });
  else if (e.kind === 'agent' && seed % 3 === 0) {
    const f = w.tiles.filter((x) => x.food >= 3 && Math.hypot(x.x - e.x, x.y - e.y) < 8)[0];
    if (f) calls.push({ name: 'share_insight', args: { text: t('rt.mock.insight', { x: f.x, y: f.y }), confidence: 0.6, evidence: t('rt.mock.insightEvidence', { day: w.day }) } });
  }
  const plan = mockSteps(t, w, e, { min: Math.min(host.cfg.mock.planSteps, tc.maxSteps), max: tc.maxSteps }, host.cfg.mock);
  calls.push({ name: 'commit_plan', args: { reason: plan.reason, steps: flatSteps(plan.steps) } });
  return { text: plan.reason, toolCalls: calls };
}

/** Asks one person what it will do next; a Failure says why no plan was committed. */
export async function decide(host: DecideHost, e: RtEntity, why: string, stop?: AbortSignal): Promise<Decision | Failure> {
  const t = host.t;
  const cfg = host.cfg;
  const w = host.world();
  const tc = tierConfig(e, cfg);
  const horizon = w.r('plan_horizon_minutes') * tc.horizonFactor;
  const textMax = cfg.decisions.textMaxChars;
  let committed: Decision | undefined;
  const commit = tool<{ reason: string; steps: unknown[] }>('commit_plan', t('rt.tools.commitPlan'), planSchema(t, textMax, false, tc.maxSteps), (args) => {
    const steps = normalizeSteps(args?.steps, textMax, tc.maxSteps);
    if (!steps.length) return { content: t('rt.act.noSteps'), isError: true };
    committed = { steps, reason: String(args?.reason ?? '').slice(0, textMax) };
    // The plan is all this call is for: the run ends without another model turn.
    return { content: t('rt.act.planned', { n: steps.length }), stop: true };
  });
  const runner = agent({
    name: e.id,
    model: modelRef(host, e.model, (req) => mockDecision(host, e, tc, req), cfg.mock.thinkDelayMs),
    params: { ...cfg.decisions.modelParams.plan, maxTokens: tc.maxOutputTokens },
    instructions: rtInstructions(t, e, host.roleOf(e.role), { horizon }),
    tools: [commit, ...socialTools(host, e), ...faculties(host, e, tc.maxConsults)],
    budget: { maxTurns: tc.maxTurns, maxToolCalls: tc.maxConsults + tc.maxTurns * 4 },
    toolSettings: { concurrency: 1 },
  });
  const prompt = rtObservation(t, w, e, why, host.groups(), host.roleTitle, limitsOf(cfg), host.changedLaws(e), host.perceived);
  // What the body went through is counted again from this thought on.
  w.resetBody(e);
  const signal = AbortSignal.any([AbortSignal.timeout(decisionTimeoutMs(cfg, w)), ...(stop ? [stop] : [])]);
  const handle = runner.stream(prompt, { signal, sinks: host.runSinks() });
  let thought = '';
  for await (const ev of handle) if (ev.type === 'thinking_delta') thought += (ev.data as { text: string }).text;
  const res = await handle.result;
  host.ranModel(e, res);
  if (thought.trim()) host.reasoned(e, thought.trim().slice(0, textMax));
  if (committed) return committed;
  return { error: res.status === 'completed' ? 'no plan committed' : `${res.status}${res.reason ? `: ${res.reason}` : ''}` };
}

export interface Reply {
  text: string;
  rethink: boolean;
  /** Why the reply run did not complete (timeout, max_tokens, provider error): a failure. */
  error?: string;
}

/** What the speaker last said to this person (to recall related memories). */
export function lastHeard(e: Pick<RtEntity, 'inbox'>, speaker: Pick<RtEntity, 'id'>): string {
  return [...e.inbox].reverse().find((m) => m.from === speaker.id)?.text ?? '';
}

/**
 * Quick spoken reply, streamed through `onDelta`. The person may consult Lorebase (bounded by
 * `conversation.replyMaxConsults`) before answering; memories related to what was said are recalled first.
 */
export async function reply(host: DecideHost, e: RtEntity, speaker: RtEntity, onDelta: (delta: string) => void, stop?: AbortSignal): Promise<Reply> {
  const t = host.t;
  const cfg = host.cfg;
  const w = host.world();
  const tc = tierConfig(e, cfg);
  let rethink = false;
  const rethinkTool = tool('rethink', t('rt.tools.rethink'), {}, () => {
    rethink = true;
    return { content: t('rt.act.rethink'), stop: true };
  });
  const mockReply = (): MockTurn => {
    const n = Number(String(e.id).replace(/\D/g, '')) || 0;
    const state = e.hunger >= w.r('critical_hunger') ? t('rt.mock.stateHungry') : e.groupId ? t('rt.mock.stateGroup', { group: host.groups().find((g) => g.id === e.groupId)?.name ?? '' }) : t('rt.mock.stateOk');
    return { text: t(`rt.mock.reply.${(n + w.minute) % 3}`, { name: speaker.name, me: e.name, role: host.roleTitle(e.role), state }) };
  };
  const consults = Math.max(0, cfg.conversation.replyMaxConsults);
  const lorebase = consults > 0 ? host.brain.lorebaseTools({ left: consults, onConsult: (ev) => host.consulted(e, ev) }) : [];
  const runner = agent({
    name: e.id,
    model: modelRef(host, e.model, mockReply, cfg.mock.replyDelayMs),
    params: { ...cfg.decisions.modelParams.reply, maxTokens: cfg.conversation.replyMaxOutputTokens },
    instructions: `${rtInstructions(t, e, host.roleOf(e.role), { horizon: w.r('plan_horizon_minutes') * tc.horizonFactor })}\n${t('rt.replyInstructions')}`,
    tools: [rethinkTool, ...lorebase],
    // Consultations, plus rethink and one refused extra call, then the answer.
    budget: { maxTurns: cfg.conversation.replyMaxTurns, maxToolCalls: consults + 2 },
    toolSettings: { concurrency: 1 },
  });
  const recalled = await host.recall(e, `${speaker.name}: ${lastHeard(e, speaker)}`).catch(() => []);
  const prompt = [
    timeLine(t, w),
    selfLine(t, w, e),
    groupLine(t, w, e, host.groups()),
    doingLine(t, e),
    t('rt.observation.why', { why: t('rt.why.spokenTo', { name: speaker.name }) }),
    t('rt.observation.perceive', { look: look(t, w, e, host.groups(), host.roleTitle, limitsOf(cfg), (b) => host.perceived.about(e, b)) }),
    ...host.perceived.blocks(e),
    memoryBlock(t, e),
    recalledBlock(t, recalled),
    inboxBlock(t, e),
  ].filter(Boolean).join('\n\n');
  let text = '';
  const signal = AbortSignal.any([AbortSignal.timeout(cfg.conversation.replyTimeoutMs), ...(stop ? [stop] : [])]);
  const handle = runner.stream(prompt, { signal, sinks: host.runSinks() });
  for await (const ev of handle) {
    // Speech before and after a consultation is one answer; nothing is said after rethink.
    if (rethink) continue;
    if (ev.type === 'turn_start' && text && !/\s$/.test(text)) {
      text += ' ';
      onDelta(' ');
    }
    if (ev.type === 'text_delta') {
      const d = (ev.data as { text: string }).text;
      text += d;
      onDelta(d);
    }
  }
  const res = await handle.result;
  host.ranModel(e, res);
  const said = text.trim();
  // A run cut short (max_tokens is reported as such) is a failure; a completed run without words is a silence.
  const error = res.status === 'completed' ? undefined : `${res.status}${res.reason ? `: ${res.reason}` : ''}`;
  return { text: said, rethink, ...(error ? { error } : {}) };
}
