// Every agent runs its OWN loop: it receives perceptions (events the world delivers to it) in a
// mailbox and decides by itself when to think again. Nothing schedules decisions centrally:
// the world is physics plus an event bus. A group has its own loop too, woken by its members.
// The only shared piece is a concurrency limit on model calls (a resource pool, not a planner).
import type { Season } from '../world/types.ts';
import type { GameConfig, ReplanTrigger } from './config.ts';
import { type Decision, decisionTier, type Failure, isFailure, realMsPerGameMinute, type Reply } from './decide.ts';
import type { Group, JointPlan } from './groups.ts';
import type { RtEntity, RtWorld } from './world.ts';

export type Perception =
  | { kind: 'start' }
  | { kind: 'planDone' }
  | { kind: 'stepFailed'; label: string; reason: string }
  | { kind: 'spokenTo'; from: RtEntity }
  | { kind: 'conversation'; with: RtEntity }
  | { kind: 'critical'; what: 'hunger' | 'hp' }
  | { kind: 'night'; night: boolean }
  | { kind: 'season'; season: Season }
  | { kind: 'rules' }
  | { kind: 'groupChanged' }
  | { kind: 'groupFailed' }
  | { kind: 'offer'; from: RtEntity; ask?: boolean }
  | { kind: 'offerAnswered'; with: RtEntity; status: string };

/** Bounded concurrency for model calls. */
export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  get running(): number {
    return this.active;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export interface MindHost {
  cfg: GameConfig;
  world(): RtWorld;
  limiter: Limiter;
  why(p: Perception): string;
  decide(e: RtEntity, why: string, stop: AbortSignal): Promise<Decision | Failure>;
  reply(e: RtEntity, speaker: RtEntity, onDelta: (d: string) => void, stop: AbortSignal): Promise<Reply>;
  commitPlan(e: RtEntity, d: Decision): void;
  thinking(id: string, on: boolean): void;
  replyDelta(from: RtEntity, to: RtEntity, delta: string, done: boolean): void;
  /** Says the finished reply aloud (heard by those around, never answered in turn). */
  sayReply(from: RtEntity, to: RtEntity, text: string): void;
  /** The mind of this person's group, when the group decides jointly. */
  groupMind(e: RtEntity): GroupMind | undefined;
  decideGroup(g: Group, why: string): Promise<JointPlan | Failure>;
  commitJointPlan(g: Group, plan: JointPlan): void;
  /** The group could not decide: the member's own mind takes over. */
  groupFailed(member: RtEntity): void;
  stats: { decisions: number; groupDecisions: number; replies: number; failures: number };
}

/** Counts a failed decision and says briefly why. */
export function failed(host: Pick<MindHost, 'stats'>, kind: string, who: string, reason: string): void {
  host.stats.failures++;
  console.warn(`[failure ${host.stats.failures}] ${kind} ${who}: ${reason.replace(/\s+/g, ' ').slice(0, 400)}`);
}

const TRIGGER: Record<Perception['kind'], ReplanTrigger | undefined> = {
  start: undefined,
  planDone: 'planExhausted',
  stepFailed: 'stepFailed',
  spokenTo: 'spokenTo',
  conversation: 'spokenTo',
  critical: 'critical',
  night: 'nightfall',
  season: 'seasonChange',
  rules: 'rulesChanged',
  groupChanged: undefined,
  groupFailed: undefined,
  offer: 'offer',
  offerAnswered: 'offerAnswered',
};

/** Mailbox with an awaitable "something arrived" signal. */
class Mailbox<T> {
  items: T[] = [];
  private wake: (() => void) | undefined;
  push(item: T): void {
    this.items.push(item);
    this.wake?.();
  }
  /** Resolves when an item arrives or after `ms` (whichever first). */
  wait(ms: number): Promise<void> {
    if (this.items.length) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = () => {
        this.wake = undefined;
        done();
      };
    });
  }
  stopWaiting(): void {
    this.wake?.();
  }
}

const IDLE_WAIT_MS = 60_000;

/**
 * Game time between two decisions of a person (rule replan_cooldown_minutes x tier factor), in real ms at
 * the current time scale: a sped-up world replans as often in game time, not more often.
 */
function cooldownMs(host: MindHost, e: RtEntity): number {
  const tc = host.cfg.decisions.tiers[decisionTier(e, host.cfg)];
  return host.world().r('replan_cooldown_minutes') * tc.cooldownFactor * realMsPerGameMinute(host.world());
}

/** A group's cooldown: its lead's, and at least `groups.minGameMinutesBetweenDecisions` of game time. */
function groupCooldownMs(host: MindHost, lead: RtEntity): number {
  return Math.max(cooldownMs(host, lead), host.cfg.groups.minGameMinutesBetweenDecisions * realMsPerGameMinute(host.world()));
}

const idle = (e: RtEntity) => !e.plan || e.plan.current >= e.plan.steps.length;

/** What a person's mind does not wait the cooldown for (an idle body does not wait either). */
const URGENT: ReadonlySet<Perception['kind']> = new Set(['start', 'critical', 'planDone', 'groupFailed']);
/**
 * What a group does not wait its cooldown for: its first decision and a member in a critical state
 * (nor do all members idle). Anything else waits: meanwhile each body keeps executing its plan and,
 * with none, acts by reflex (reflex.ts).
 */
const GROUP_URGENT: ReadonlySet<Perception['kind']> = new Set(['start', 'critical']);

export class AgentMind {
  readonly e: RtEntity;
  private readonly host: MindHost;
  private readonly box = new Mailbox<Perception>();
  private stopped = false;
  private lastThought = 0;
  private speaking = false;
  /** Aborts the model run in flight when the mind stops (the person died or left). */
  private readonly abort = new AbortController();

  constructor(e: RtEntity, host: MindHost) {
    this.e = e;
    this.host = host;
  }

  /** The world delivers a perception. Speech is answered at once, by the agent's own voice. */
  perceive(p: Perception): void {
    if (this.stopped) return;
    if (p.kind === 'spokenTo') void this.answer(p.from);
    else this.box.push(p);
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort(new Error('mind stopped'));
    this.box.stopWaiting();
  }

  async run(): Promise<void> {
    while (!this.stopped && this.e.alive) {
      await this.box.wait(IDLE_WAIT_MS);
      if (this.stopped || !this.e.alive) break;
      const batch = this.box.items.splice(0);
      const wanted = batch.filter((p) => {
        const trig = TRIGGER[p.kind];
        return !trig || this.host.cfg.decisions.replanOn[trig];
      });
      if (!wanted.length) continue;
      const urgent = wanted.some((p) => URGENT.has(p.kind));
      const wait = this.lastThought + cooldownMs(this.host, this.e) - Date.now();
      if (!urgent && !idle(this.e) && wait > 0) {
        // Not worth rethinking yet: keep the perceptions and look again when the cooldown ends.
        this.box.items.unshift(...wanted);
        await new Promise((r) => setTimeout(r, Math.min(wait, IDLE_WAIT_MS)));
        continue;
      }
      const why = wanted.map((p) => this.host.why(p)).filter(Boolean).join('; ');
      const group = this.host.groupMind(this.e);
      // An offer is answered by the person itself (its own tool), even inside a group.
      const solo = wanted.some((p) => p.kind === 'groupFailed' || p.kind === 'offer');
      if (group && !solo) {
        group.perceive(why, wanted.some((p) => GROUP_URGENT.has(p.kind)));
        continue;
      }
      await this.think(why, solo);
    }
  }

  /** `solo`: the group could not decide, so this plan is kept even inside a group. */
  private async think(why: string, solo: boolean): Promise<void> {
    this.lastThought = Date.now();
    this.host.thinking(this.e.id, true);
    try {
      if (this.stopped) return;
      const d = await this.host.limiter.run(() => this.host.decide(this.e, why, this.abort.signal));
      if (this.stopped) return;
      this.host.stats.decisions++;
      if (isFailure(d)) failed(this.host, 'decide', this.e.name, d.error);
      // Joined a group while thinking: the group decides from now on.
      else if (this.e.alive && (solo || !this.host.groupMind(this.e))) this.host.commitPlan(this.e, d);
    } catch (err) {
      if (!this.stopped) failed(this.host, 'decide', this.e.name, err instanceof Error ? err.message : String(err));
    } finally {
      this.host.thinking(this.e.id, false);
    }
  }

  private async answer(speaker: RtEntity): Promise<void> {
    if (this.speaking || !this.e.alive) return;
    this.speaking = true;
    let first = true;
    this.host.thinking(this.e.id, true);
    try {
      const out = await this.host.limiter.run(() => this.host.reply(this.e, speaker, (d) => {
        if (first) {
          first = false;
          this.host.thinking(this.e.id, false);
        }
        this.host.replyDelta(this.e, speaker, d, false);
      }, this.abort.signal));
      this.host.stats.replies++;
      if (out.error && !this.stopped) failed(this.host, 'reply', this.e.name, out.error);
      this.host.replyDelta(this.e, speaker, '', true);
      if (out.text && this.e.alive) this.host.sayReply(this.e, speaker, out.text);
      if (out.rethink && this.host.cfg.conversation.replanAfterReply) this.box.push({ kind: 'conversation', with: speaker });
    } catch (err) {
      this.host.replyDelta(this.e, speaker, '', true);
      if (!this.stopped) failed(this.host, 'reply', this.e.name, err instanceof Error ? err.message : String(err));
    } finally {
      if (first) this.host.thinking(this.e.id, false);
      this.speaking = false;
    }
  }
}

export class GroupMind {
  readonly g: Group;
  private readonly host: MindHost;
  private readonly box = new Mailbox<{ why: string; urgent: boolean }>();
  private stopped = false;
  private lastThought = 0;

  constructor(g: Group, host: MindHost) {
    this.g = g;
    this.host = host;
  }

  perceive(why: string, urgent: boolean): void {
    if (!this.stopped) this.box.push({ why, urgent });
  }

  stop(): void {
    this.stopped = true;
    this.box.stopWaiting();
  }

  private members(): RtEntity[] {
    const w = this.host.world();
    return this.g.members.map((id) => w.entities.get(id)).filter((m): m is RtEntity => !!m && m.alive);
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      await this.box.wait(IDLE_WAIT_MS);
      if (this.stopped) break;
      if (!this.box.items.length) continue;
      // Let the members' perceptions settle into one decision.
      await new Promise((r) => setTimeout(r, this.host.cfg.groups.replanDebounceMs));
      const batch = this.box.items.splice(0);
      const urgent = batch.some((b) => b.urgent);
      const members = this.members();
      if (!members.length) continue;
      const lead = members.find((m) => m.id === this.g.leader) ?? members[0]!;
      const wait = this.lastThought + groupCooldownMs(this.host, lead) - Date.now();
      if (!urgent && !members.every(idle) && wait > 0) {
        this.box.items.unshift(...batch);
        await new Promise((r) => setTimeout(r, Math.min(wait, IDLE_WAIT_MS)));
        continue;
      }
      await this.think([...new Set(batch.map((b) => b.why))].join('; '), members);
    }
  }

  private async think(why: string, members: RtEntity[]): Promise<void> {
    this.lastThought = Date.now();
    for (const m of members) this.host.thinking(m.id, true);
    try {
      const plan = await this.host.limiter.run(() => this.host.decideGroup(this.g, why));
      this.host.stats.groupDecisions++;
      if (this.stopped) return;
      if (!isFailure(plan)) this.host.commitJointPlan(this.g, plan);
      else {
        failed(this.host, 'group', this.g.name, plan.error);
        // No joint plan: each member's own mind takes over for now.
        for (const m of members) this.host.groupFailed(m);
      }
    } catch (err) {
      failed(this.host, 'group', this.g.name, err instanceof Error ? err.message : String(err));
    } finally {
      for (const m of members) this.host.thinking(m.id, false);
    }
  }
}
