// Plans and their real-time execution. Pure: the world is reached through `ExecContext`.
// A plan is a list of steps; each step becomes an Activity (walk along a path, or work for a
// number of game minutes) that advances with real time at the person's own speed.
import type { Point } from './path.ts';

export const STEP_ACTIONS = ['move_to', 'approach', 'gather', 'eat', 'build', 'give', 'say', 'rest', 'sleep', 'wait', 'craft', 'experiment', 'use', 'offer'] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

/** Names agents write for some actions (the people of the world speak Italian); normalized to STEP_ACTIONS. */
export const ACTION_ALIASES: Record<string, StepAction> = { crea: 'craft', sperimenta: 'experiment', usa: 'use', dai: 'give', scambia: 'offer' };
/** Near misses models write for the same actions (Italian verbs, English synonyms): mapped, not dropped. */
export const ACTION_NEAR_MISSES: Record<string, StepAction> = {
  move: 'move_to', go: 'move_to', walk: 'move_to', goto: 'move_to', go_to: 'move_to', vai: 'move_to', cammina: 'move_to', muoviti: 'move_to',
  avvicinati: 'approach', raggiungi: 'approach', collect: 'gather', harvest: 'gather', raccogli: 'gather', mangia: 'eat',
  construct: 'build', costruisci: 'build', amplia: 'build', talk: 'say', speak: 'say', parla: 'say', di: 'say', dici: 'say',
  riposa: 'rest', dormi: 'sleep', aspetta: 'wait', attendi: 'wait', idle: 'wait', fabbrica: 'craft', combina: 'experiment', trade: 'offer',
};
/** Actions offered to models in the commit_plan schema. */
export const MODEL_ACTIONS = ['move_to', 'approach', 'gather', 'eat', 'build', 'dai', 'scambia', 'say', 'rest', 'sleep', 'wait', 'crea', 'sperimenta', 'usa'] as const;
export type Dir = 'n' | 'e' | 's' | 'w';
export type Anim = 'idle' | 'walk' | 'work' | 'sleep' | 'eat';

export interface PlanStep {
  action: StepAction;
  /**
   * move_to {x,y} · approach {to} · gather {resource} · eat {amount?, item?} · give {to,item,amount} · say {to,text} ·
   * rest/sleep/wait {minutes} · craft {recipe} · experiment {items} · use {item} · offer {to, give, want} (bags). Group plans add `who`.
   */
  args: Record<string, unknown>;
  label: string;
}

export interface Plan {
  id: string;
  /** `reflex`: the body's own plan while the mind has none (see reflex.ts); it never wakes the mind. */
  scope: 'entity' | 'group' | 'reflex';
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
  durations: { gather: number; build: number; eat: number; experiment: number; use: number };
  /** Work minutes of a recipe for this person (practice shortens it), undefined when there is no such recipe. */
  craftMinutes(recipe: string, who?: Mover): number | undefined;
  /** Upper bound of rest/sleep/wait in game minutes. */
  maxWaitMinutes: number;
}

export type Prepared = { activity: Activity } | { error: string };

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/** An item, recipe or technology code: snake_case, lower case. */
const code = (v: unknown): string | undefined => {
  const c = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return /^[a-z][a-z0-9_]{0,40}$/.test(c) ? c : undefined;
};
/** A bag of items `{code: amount}` (also `[{item, amount}]` or "code:n,code:n"), or undefined when empty or unreadable. */
export function bagOf(v: unknown): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  const put = (k: unknown, n: unknown) => {
    const c = code(k);
    const amount = Math.floor(num(n ?? 1));
    if (c && Number.isFinite(amount) && amount >= 1) out[c] = (out[c] ?? 0) + Math.min(amount, 999);
  };
  if (Array.isArray(v)) for (const x of v) {
    if (x && typeof x === 'object') put((x as Record<string, unknown>).item ?? (x as Record<string, unknown>).code, (x as Record<string, unknown>).amount);
    else put(x, 1);
  }
  else if (typeof v === 'string') for (const part of v.split(',')) {
    const [k, n] = part.split(/[:=x ]+/).filter(Boolean);
    put(k, n ?? 1);
  }
  else if (v && typeof v === 'object') for (const [k, n] of Object.entries(v)) put(k, n);
  return Object.keys(out).length ? out : undefined;
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

/**
 * Turns a raw step (as a model wrote it: flat fields or nested `args`) into a PlanStep, or
 * undefined when it cannot be understood. Never throws.
 */
export function normalizeStep(raw: unknown, textMax: number): PlanStep | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const a = { ...(r.args && typeof r.args === 'object' ? (r.args as Record<string, unknown>) : {}), ...r };
  const named = str(a.action, 32).toLowerCase();
  const action = (ACTION_ALIASES[named] ?? ACTION_NEAR_MISSES[named] ?? named) as StepAction;
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
      const resource = code(a.resource ?? a.item);
      if (!resource) return undefined;
      args.resource = resource;
      break;
    }
    case 'eat': {
      const amount = Math.floor(num(a.amount));
      if (Number.isFinite(amount) && amount > 0) args.amount = amount;
      const item = code(a.item);
      if (item) args.item = item;
      break;
    }
    case 'give': {
      const to = str(a.to, 64);
      const item = code(a.item ?? a.resource);
      const amount = Math.floor(num(a.amount ?? 1));
      if (!to || !item || !Number.isFinite(amount) || amount < 1) return undefined;
      Object.assign(args, { to, item, amount });
      break;
    }
    case 'craft': {
      const recipe = code(a.recipe);
      if (!recipe) return undefined;
      args.recipe = recipe;
      break;
    }
    case 'experiment': {
      const items = (Array.isArray(a.items) ? a.items : typeof a.items === 'string' ? a.items.split(',') : []).map(code).filter((x): x is string => !!x);
      if (!items.length) return undefined;
      args.items = [...new Set(items)].slice(0, 8);
      break;
    }
    case 'use': {
      const item = code(a.item);
      if (!item) return undefined;
      args.item = item;
      break;
    }
    case 'offer': {
      const to = str(a.to, 64);
      const give = bagOf(a.give);
      const want = bagOf(a.want);
      if (!to || !give || !want) return undefined;
      Object.assign(args, { to, give, want });
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
    case 'craft': {
      const minutes = ctx.craftMinutes(String(step.args.recipe), mover);
      if (minutes === undefined) return { error: 'unknown_recipe' };
      return { activity: { kind: 'timed', remaining: minutes, anim: 'work', scaled: true } };
    }
    case 'experiment':
      return { activity: { kind: 'timed', remaining: ctx.durations.experiment, anim: 'work', scaled: true } };
    case 'use':
      return { activity: { kind: 'timed', remaining: ctx.durations.use, anim: 'eat', scaled: false } };
    case 'give':
    case 'say':
    case 'offer':
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
