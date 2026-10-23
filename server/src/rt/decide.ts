// One person's decisions with reinloop: a PLAN call (tools commit_plan, say, form_group,
// join_group, leave_group; the run ends as soon as a plan is committed) and a quick REPLY call
// when spoken to (streamed text, optional `rethink`). Each person uses its own model; the mock
// provider is only an offline fallback.
import { agent, type MockTurn, mockProvider, type ModelRef, type ModelRequest, type Tool, tool } from 'reinloop';
import { realModel } from '../agents/registry.ts';
import type { SimConfig } from '../config.ts';
import type { Translate } from '../i18n.ts';
import type { Role, RuleChange } from '../lorebase/rules.ts';
import type { Brain, ConsultEvent } from './brain.ts';
import type { Tier } from '../world/types.ts';
import { AGENT_PATTERNS, type GameConfig, type TierDecision } from './config.ts';
import { flatSteps, mockSteps } from './mock.ts';
import { MODEL_ACTIONS, normalizeStep, type PlanStep } from './plan.ts';
import {
  doingLine, type GroupView, groupLine, inboxBlock, look, memoryBlock, type PromptLimits, rtInstructions, rtObservation, selfLine, timeLine,
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
  /** A model run ended (usage and cost per agent, for the Observatory). */
  ranModel(who: { id: string; name: string; model: string; tier: string }, res: { status: string; usage?: { inputTokens?: number; outputTokens?: number }; costUsd?: number }): void;
  /** A person consulted Lorebase (shown to clients). */
  consulted(e: RtEntity, ev: ConsultEvent): void;
}

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

export function limitsOf(cfg: GameConfig): PromptLimits {
  return { lookMaxTiles: cfg.decisions.lookMaxTiles, lookMaxPeople: cfg.decisions.lookMaxPeople, nearbyGroupsMax: cfg.decisions.nearbyGroupsMax };
}

/** Model reference for an entity: its own model, or a scripted mock when offline. */
export function modelRef(host: Pick<DecideHost, 'mock'>, model: string, script: (req: ModelRequest, i: number) => MockTurn, delayMs: number): string | ModelRef {
  if (host.mock) return { provider: mockProvider([(req, i) => ({ delayMs, ...script(req, i) })], { loop: true, name: 'mock' }), model: `mock/${model}` };
  return realModel(model);
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
  // Shared consciousness: judge a peer's pending idea, or now and then share one.
  const pendingCode = /^- (\S+):/m.exec(host.reviewInsights(e))?.[1];
  const seed = [...`${e.id}${w.day}${w.minute}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 3);
  if (e.kind === 'agent' && pendingCode) calls.push({ name: 'judge_insight', args: { code: pendingCode, verdict: 'approve', reason: t('rt.mock.judgeOk') } });
  else if (e.kind === 'agent' && seed % 3 === 0) {
    const f = w.tiles.filter((x) => x.food >= 3 && Math.hypot(x.x - e.x, x.y - e.y) < 8)[0];
    if (f) calls.push({ name: 'share_insight', args: { text: t('rt.mock.insight', { x: f.x, y: f.y }), confidence: 0.6, evidence: t('rt.mock.insightEvidence', { day: w.day }) } });
  }
  const plan = mockSteps(t, w, e, { min: Math.min(host.cfg.mock.planSteps, tc.maxSteps), max: tc.maxSteps }, host.cfg.mock.wanderRadius, host.cfg.mock.experimentChance);
  calls.push({ name: 'commit_plan', args: { reason: plan.reason, steps: flatSteps(plan.steps) } });
  return { text: plan.reason, toolCalls: calls };
}

/** Asks one person what it will do next. Resolves undefined when no plan was committed. */
export async function decide(host: DecideHost, e: RtEntity, why: string): Promise<Decision | undefined> {
  const t = host.t;
  const cfg = host.cfg;
  const w = host.world();
  const tc = tierConfig(e, cfg);
  const horizon = w.r('plan_horizon_minutes') * tc.horizonFactor;
  const textMax = cfg.decisions.textMaxChars;
  const controller = new AbortController();
  let committed: Decision | undefined;
  const commit = tool<{ reason: string; steps: unknown[] }>('commit_plan', t('rt.tools.commitPlan'), planSchema(t, textMax, false, tc.maxSteps), (args) => {
    const steps = normalizeSteps(args?.steps, textMax, tc.maxSteps);
    if (!steps.length) return { content: t('rt.act.noSteps'), isError: true };
    committed = { steps, reason: String(args?.reason ?? '').slice(0, textMax) };
    // The plan is all this call is for: end the run without another model turn.
    queueMicrotask(() => controller.abort(new Error('plan committed')));
    return t('rt.act.planned', { n: steps.length });
  });
  const runner = agent({
    name: e.id,
    model: modelRef(host, e.model, (req) => mockDecision(host, e, tc, req), cfg.mock.thinkDelayMs),
    params: { maxTokens: tc.maxOutputTokens },
    instructions: rtInstructions(t, e, host.roleOf(e.role), { horizon }),
    tools: [commit, ...socialTools(host, e), ...faculties(host, e, tc.maxConsults)],
    budget: { maxTurns: tc.maxTurns, maxToolCalls: tc.maxConsults + tc.maxTurns * 4 },
    toolSettings: { concurrency: 1 },
  });
  const prompt = rtObservation(t, w, e, why, host.groups(), host.roleTitle, limitsOf(cfg), host.changedLaws(e));
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(cfg.decisions.timeoutMs)]);
  const res = await runner.run(prompt, { signal });
  host.ranModel(e, res);
  if (!committed && res.status !== 'completed') console.warn(`[decide ${e.name}] ${res.status}: ${res.reason ?? ''}`);
  return committed;
}

export interface Reply {
  text: string;
  rethink: boolean;
}

/** Quick spoken reply, streamed through `onDelta`. */
export async function reply(host: DecideHost, e: RtEntity, speaker: RtEntity, onDelta: (delta: string) => void): Promise<Reply> {
  const t = host.t;
  const cfg = host.cfg;
  const w = host.world();
  const tc = tierConfig(e, cfg);
  let rethink = false;
  const controller = new AbortController();
  const rethinkTool = tool('rethink', t('rt.tools.rethink'), {}, () => {
    rethink = true;
    queueMicrotask(() => controller.abort(new Error('reply done')));
    return t('rt.act.rethink');
  });
  const mockReply = (): MockTurn => {
    const n = Number(String(e.id).replace(/\D/g, '')) || 0;
    const state = e.hunger >= w.r('critical_hunger') ? t('rt.mock.stateHungry') : e.groupId ? t('rt.mock.stateGroup', { group: host.groups().find((g) => g.id === e.groupId)?.name ?? '' }) : t('rt.mock.stateOk');
    return { text: t(`rt.mock.reply.${(n + w.minute) % 3}`, { name: speaker.name, me: e.name, role: host.roleTitle(e.role), state }) };
  };
  const runner = agent({
    name: e.id,
    model: modelRef(host, e.model, mockReply, cfg.mock.replyDelayMs),
    params: { maxTokens: cfg.conversation.replyMaxOutputTokens },
    instructions: `${rtInstructions(t, e, host.roleOf(e.role), { horizon: w.r('plan_horizon_minutes') * tc.horizonFactor })}\n${t('rt.replyInstructions')}`,
    tools: [rethinkTool],
    budget: { maxTurns: cfg.conversation.replyMaxTurns },
  });
  const prompt = [
    timeLine(t, w),
    selfLine(t, w, e),
    groupLine(t, w, e, host.groups()),
    doingLine(t, e),
    t('rt.observation.perceive', { look: look(t, w, e, host.groups(), host.roleTitle, limitsOf(cfg)) }),
    memoryBlock(t, e),
    inboxBlock(t, e),
  ].join('\n\n');
  let text = '';
  const handle = runner.stream(prompt, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(cfg.conversation.replyTimeoutMs)]) });
  for await (const ev of handle) {
    if (ev.type === 'text_delta') {
      const d = (ev.data as { text: string }).text;
      // Only the first turn is speech; text after a tool call is not said aloud.
      if (!rethink) {
        text += d;
        onDelta(d);
      }
    }
  }
  const res = await handle.result;
  host.ranModel(e, res);
  if (!text && res.status !== 'completed' && !rethink) console.warn(`[reply ${e.name}] ${res.status}: ${res.reason ?? ''}`);
  return { text: text.trim(), rethink };
}
