// Plans and their real-time execution. Pure: the world is reached through `ExecContext`.
// A plan is a list of steps; each step becomes an Activity (walk along a path, or work for a
// number of game minutes) that advances with real time at the person's own speed.
import type { Point } from './path.ts';

export const STEP_ACTIONS = ['move_to', 'approach', 'gather', 'eat', 'build', 'give', 'say', 'rest', 'sleep', 'wait'] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];
export type Dir = 'n' | 'e' | 's' | 'w';
export type Anim = 'idle' | 'walk' | 'work' | 'sleep' | 'eat';

export interface PlanStep {
  action: StepAction;
  /** move_to {x,y} · approach {to} · gather {resource} · eat {amount?} · give {to,resource,amount} · say {to,text} · rest/sleep/wait {minutes}. Group plans add `who`. */
  args: Record<string, unknown>;
  label: string;
}

export interface Plan {
  id: string;
  scope: 'entity' | 'group';
  steps: PlanStep[];
  current: number;
  reason: string;
  createdAt: number;
}

export type Activity =
  | { kind: 'walk'; path: Point[]; anim: 'walk' }
  /** `remaining` in work units: game minutes at speed 1. */
  | { kind: 'timed'; remaining: number; anim: Anim; scaled: boolean }
  | { kind: 'instant' };

export interface Mover {
  x: number;
  y: number;
  dir: Dir;
  anim: Anim;
}

export interface ExecContext {
  path(from: Point, to: Point): Point[] | undefined;
  /** Tile coordinates of a person by id or name, if alive. */
  locate(who: string): Point | undefined;
  durations: { gather: number; build: number; eat: number };
  /** Upper bound of rest/sleep/wait in game minutes. */
  maxWaitMinutes: number;
}

export type Prepared = { activity: Activity } | { error: string };

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

/**
 * Turns a raw step (as a model wrote it: flat fields or nested `args`) into a PlanStep, or
 * undefined when it cannot be understood. Never throws.
 */
export function normalizeStep(raw: unknown, textMax: number): PlanStep | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const a = { ...(r.args && typeof r.args === 'object' ? (r.args as Record<string, unknown>) : {}), ...r };
  const action = str(a.action, 32) as StepAction;
  if (!STEP_ACTIONS.includes(action)) return undefined;
  const label = str(a.label, textMax);
  const args: Record<string, unknown> = {};
  if (typeof a.who === 'string' && a.who.trim()) args.who = a.who.trim();
  switch (action) {
    case 'move_to': {
      const x = Math.round(num(a.x));
      const y = Math.round(num(a.y));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
      Object.assign(args, { x, y });
      break;
    }
    case 'approach': {
      const to = str(a.to, 64);
      if (!to) return undefined;
      args.to = to;
      break;
    }
    case 'gather': {
      const resource = a.resource === 'wood' ? 'wood' : a.resource === 'food' ? 'food' : undefined;
      if (!resource) return undefined;
      args.resource = resource;
      break;
    }
    case 'eat': {
      const amount = Math.floor(num(a.amount));
      if (Number.isFinite(amount) && amount > 0) args.amount = amount;
      break;
    }
    case 'give': {
      const to = str(a.to, 64);
      const resource = a.resource === 'wood' ? 'wood' : a.resource === 'food' ? 'food' : undefined;
      const amount = Math.floor(num(a.amount));
      if (!to || !resource || !Number.isFinite(amount) || amount < 1) return undefined;
      Object.assign(args, { to, resource, amount });
      break;
    }
    case 'say': {
      const text = str(a.text, textMax);
      if (!text) return undefined;
      Object.assign(args, { to: str(a.to, 64) || 'all', text });
      break;
    }
    case 'rest':
    case 'sleep':
    case 'wait': {
      const minutes = num(a.minutes);
      args.minutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 1;
      break;
    }
    case 'build':
      break;
  }
  return { action, args, label: label || action };
}

export function tileOf(p: { x: number; y: number }): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/** Starts a step: computes its path or its duration. */
export function prepareStep(step: PlanStep, mover: Mover, ctx: ExecContext): Prepared {
  const here = tileOf(mover);
  switch (step.action) {
    case 'move_to': {
      const path = ctx.path(here, { x: Number(step.args.x), y: Number(step.args.y) });
      return path ? { activity: { kind: 'walk', path, anim: 'walk' } } : { error: 'unreachable' };
    }
    case 'approach': {
      const target = ctx.locate(String(step.args.to));
      if (!target) return { error: 'no_such_person' };
      const path = ctx.path(here, target);
      // Stop one tile short: standing next to someone is enough to talk or give.
      return path ? { activity: { kind: 'walk', path: path.slice(0, -1), anim: 'walk' } } : { error: 'unreachable' };
    }
    case 'gather':
      return { activity: { kind: 'timed', remaining: ctx.durations.gather, anim: 'work', scaled: true } };
    case 'build':
      return { activity: { kind: 'timed', remaining: ctx.durations.build, anim: 'work', scaled: true } };
    case 'eat':
      return { activity: { kind: 'timed', remaining: ctx.durations.eat, anim: 'eat', scaled: false } };
    case 'rest':
    case 'wait':
    case 'sleep': {
      const minutes = Math.min(Math.max(Number(step.args.minutes) || 1, 0), ctx.maxWaitMinutes);
      return { activity: { kind: 'timed', remaining: minutes, anim: step.action === 'sleep' ? 'sleep' : 'idle', scaled: false } };
    }
    case 'give':
    case 'say':
      return { activity: { kind: 'instant' } };
  }
}

export function dirOf(dx: number, dy: number, fallback: Dir): Dir {
  if (!dx && !dy) return fallback;
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n';
}

/**
 * Advances an activity. `tilesPerSecond` moves walkers (real time); `gameMinutes` elapsed at
 * `workSpeed` drains timed work. Returns true when the activity is complete.
 */
export function advance(activity: Activity, mover: Mover, dtSeconds: number, tilesPerSecond: number, gameMinutes: number, workSpeed: number, epsilon: number): boolean {
  if (activity.kind === 'instant') return true;
  if (activity.kind === 'timed') {
    mover.anim = activity.anim;
    activity.remaining -= gameMinutes * (activity.scaled ? workSpeed : 1);
    return activity.remaining <= 0;
  }
  let budget = Math.max(0, tilesPerSecond * dtSeconds);
  mover.anim = 'walk';
  while (activity.path.length) {
    const next = activity.path[0]!;
    const dx = next.x - mover.x;
    const dy = next.y - mover.y;
    const d = Math.hypot(dx, dy);
    mover.dir = dirOf(dx, dy, mover.dir);
    if (d <= Math.max(budget, epsilon)) {
      mover.x = next.x;
      mover.y = next.y;
      budget -= d;
      activity.path.shift();
      continue;
    }
    if (budget <= 0) return false;
    mover.x += (dx / d) * budget;
    mover.y += (dy / d) * budget;
    return false;
  }
  return true;
}
