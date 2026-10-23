// Offline fallback (mock provider): plans derived from role, tier and the person's own state,
// so `npm run game:mock` runs without a model. Not how real agents are prompted (see
// docs/prompts.md): real agents get no tasks; this heuristic only stands in for a model.
import type { Translate } from '../i18n.ts';
import { knownRecipes, stationsOf } from './economy.ts';
import { createRng } from '../world/rng.ts';
import { ACTION_ALIASES, type PlanStep } from './plan.ts';
import { tileOf } from './plan.ts';
import type { Point } from './path.ts';
import type { RtEntity, RtWorld } from './world.ts';

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Mock knobs from config (`mock`). */
export interface MockKnobs {
  wanderRadius: number;
  experimentChance?: number;
  /** Hunger at which a mock person eats what it carries (well before the critical level). */
  eatAtHunger?: number;
  /** Chance of proposing an exchange (plan step) for an input a neighbour carries. */
  offerChance?: number;
}

export interface MockPlan {
  steps: PlanStep[];
  reason: string;
}

/** Items the known recipes of a role use (inputs and tools). */
export function needsOf(w: RtWorld, role: string): Set<string> {
  const out = new Set<string>();
  for (const r of knownRecipes(w.catalog, new Set(w.discovered.keys()))) {
    if (r.role && r.role !== role) continue;
    for (const k of Object.keys(r.inputs)) out.add(k);
    for (const k of r.tools) out.add(k);
  }
  return out;
}

/**
 * The economic part of a mock plan: give what a neighbour's role uses, follow a recipe one can
 * follow, use a remedy when hurt, gather what recipes use, and (explorers, or by chance) combine
 * carried items. A stand-in for a model, nothing more.
 */
export function mockEconomy(t: Translate, w: RtWorld, e: RtEntity, experimentChance: number, offerChance = 0): PlanStep[] {
  const c = w.catalog;
  if (!c.resources.size) return [];
  const rng = createRng(hash(`eco:${e.id}:${Math.floor(w.clock)}`));
  const L = (key: string, vars: Record<string, string | number> = {}) => t(`rt.mock.label.${key}`, vars);
  const steps: PlanStep[] = [];
  const here = tileOf(e);
  const has = (k: string) => (e.inventory[k] ?? 0) >= 1;
  const dist = (a: Point) => Math.max(Math.abs(a.x - here.x), Math.abs(a.y - here.y));
  const mine = needsOf(w, e.role);
  // Hurt: use a remedy.
  const remedy = Object.keys(e.inventory).find((k) => has(k) && (c.resources.get(k)?.heal ?? 0) > 0);
  if (remedy && e.hp < e.maxHp * 0.7) steps.push({ action: 'use', args: { item: remedy }, label: L('use') });
  // Craft: the first recipe one can follow, walking to its station.
  const disc = new Set(w.discovered.keys());
  for (const r of knownRecipes(c, disc).sort(() => rng.next() - 0.5)) {
    if (r.role && r.role !== e.role) continue;
    if (!Object.entries(r.inputs).every(([k, n]) => (e.inventory[k] ?? 0) >= n) || r.tools.some((k) => !e.tools.some((x) => x.item === k))) continue;
    if (r.station) {
      const st = w.tiles.filter((x) => stationsOf(x).has(r.station!)).sort((a, b) => dist(a) - dist(b))[0];
      if (!st) continue;
      if (dist(st) > 0) steps.push({ action: 'move_to', args: { x: st.x, y: st.y }, label: L('move', st) });
    }
    steps.push({ action: 'craft', args: { recipe: r.code }, label: L('craft', { name: r.name }) });
    return steps;
  }
  const near = w.living().filter((b) => b.id !== e.id && b.kind !== 'player' && b.role !== e.role && dist(tileOf(b)) <= Math.max(3, w.r('vision_radius') * 2));
  // Barter: an input my recipes use that a neighbour carries, for something of mine its recipes use (or food).
  if (rng.next() < offerChance) {
    for (const b of near) {
      const want = Object.keys(b.inventory).find((k) => mine.has(k) && k !== 'food' && (b.inventory[k] ?? 0) >= 1 && (e.inventory[k] ?? 0) < 2);
      if (!want) continue;
      const theirs = needsOf(w, b.role);
      const give = Object.keys(e.inventory).find((k) => has(k) && k !== want && theirs.has(k)) ?? (has('food') ? 'food' : undefined);
      if (!give) continue;
      steps.push({ action: 'approach', args: { to: b.name }, label: L('approach', { name: b.name }) });
      steps.push({ action: 'offer', args: { to: b.name, give: { [give]: 1 }, want: { [want]: 1 } }, label: L('offer', { name: b.name }) });
      return steps;
    }
  }
  // Give: something a neighbour of another role uses (or a remedy to someone hurt).
  for (const b of near.sort(() => rng.next() - 0.5)) {
    const theirs = needsOf(w, b.role);
    const item = Object.keys(e.inventory).find((k) => has(k) && k !== 'food' && ((theirs.has(k) && (!mine.has(k) || (e.inventory[k] ?? 0) >= 4)) || ((c.resources.get(k)?.heal ?? 0) > 0 && b.hp < b.maxHp * 0.7)));
    if (item) {
      const amount = Math.max(1, Math.min(2, Math.floor((e.inventory[item] ?? 0) / 2)));
      steps.push({ action: 'approach', args: { to: b.name }, label: L('approach', { name: b.name }) });
      steps.push({ action: 'give', args: { to: b.name, item, amount }, label: L('give', { name: b.name }) });
      return steps;
    }
  }
  // Explore and experiment: far resources, then a combination of two carried items.
  const carried = Object.keys(e.inventory).filter(has);
  if ((e.role === 'explorer' || rng.next() < experimentChance / 4) && carried.length >= 2 && rng.next() < experimentChance) {
    const a = rng.pick(carried);
    const b = rng.pick(carried.filter((x) => x !== a));
    steps.push({ action: 'experiment', args: { items: [a, b] }, label: L('experiment') });
    return steps;
  }
  const wanted = new Set<string>(e.role === 'explorer' ? [...c.resources.values()].filter((r) => r.minDistance > 0).map((r) => r.code) : []);
  for (const k of mine) wanted.add(k);
  if (e.role === 'gatherer' || e.role === 'elder') for (const b of near) for (const k of needsOf(w, b.role)) wanted.add(k);
  // The wild (rule wild_distance) hurts the unsheltered: only the healthy go there.
  const fit = e.hp >= e.maxHp * 0.8;
  const raw = [...wanted].map((k) => c.resources.get(k)).filter((r) => r && r.source === 'biome' && (e.inventory[r.code] ?? 0) < 4 && (fit || r.minDistance <= w.r('wild_distance')));
  const pick = raw.length ? raw[Math.floor(rng.next() * raw.length)]! : undefined;
  if (pick) {
    // Where it is found (biome, distance, region); out of the wild when possible.
    const wild = (p: Point) => (w.distanceFromCenter(p) > w.r('wild_distance') ? 1000 : 0);
    const tile = w.tiles
      .filter((x) => w.walkable(x.x, x.y) && w.canGatherAt(pick.code, x))
      .sort((a, b) => dist(a) + wild(a) - dist(b) - wild(b))[0];
    if (tile) {
      if (dist(tile) > 0) steps.push({ action: 'move_to', args: { x: tile.x, y: tile.y }, label: L('move', tile) });
      for (let i = 0; i < 2; i++) steps.push({ action: 'gather', args: { resource: pick.code }, label: L('gatherItem', { name: pick.name }) });
      // What the gathering completes: a recipe of mine without tools or station, followed right there.
      const after = { ...e.inventory, [pick.code]: (e.inventory[pick.code] ?? 0) + 2 * Math.max(1, Math.floor(pick.gatherYield)) };
      const done = knownRecipes(c, new Set(w.discovered.keys())).find((r) => (!r.role || r.role === e.role) && !r.station && !r.tools.length
        && r.inputs[pick.code] !== undefined && Object.entries(r.inputs).every(([k, n]) => (after[k] ?? 0) >= n));
      if (done) steps.push({ action: 'craft', args: { recipe: done.code }, label: L('craft', { name: done.name }) });
    }
  }
  return steps;
}

/** Plans `count` steps for one person by simulating its position and inventory forward. */
export function mockSteps(t: Translate, w: RtWorld, e: RtEntity, count: { min: number; max: number }, knobs: MockKnobs): MockPlan {
  const { wanderRadius, experimentChance = 0 } = knobs;
  const rng = createRng(hash(`${e.id}:${Math.floor(w.clock)}`));
  const steps: PlanStep[] = [];
  let pos: Point = tileOf(e);
  let food = e.inventory.food ?? 0;
  let wood = e.inventory.wood ?? 0;
  let hunger = e.hunger;
  let reason = '';
  const L = (key: string, vars: Record<string, string | number> = {}) => t(`rt.mock.label.${key}`, vars);
  const radius = Math.max(2, Math.floor(w.r('vision_radius')) * 2);
  const crit = w.r('critical_hunger');
  const cost = w.r('shelter_wood_cost');
  const gatherFood = Math.max(1, Math.floor(w.r('gather_food_yield')));
  const gatherWood = Math.max(1, Math.floor(w.r('gather_wood_yield')));
  const hungerPerStep = w.r('food_per_tick') / Math.max(1, w.r('turn_minutes')) * w.r('gather_minutes');
  const dist = (a: Point) => Math.max(Math.abs(a.x - pos.x), Math.abs(a.y - pos.y));
  // Everyday errands stay out of the wild (rule wild_distance), where the unsheltered get hurt.
  const safe = (p: Point) => w.distanceFromCenter(p) <= w.r('wild_distance');
  const nearest = (pred: (x: { food: number; wood: number; shelter: number }) => boolean) =>
    w.tiles.filter((x) => pred(x) && w.walkable(x.x, x.y) && dist(x) <= radius && safe(x)).sort((a, b) => dist(a) - dist(b) + (rng.next() - 0.5))[0];
  const push = (s: PlanStep) => {
    if (steps.length < count.max) steps.push(s);
  };
  const go = (p: Point) => {
    if (p.x === pos.x && p.y === pos.y) return;
    push({ action: 'move_to', args: { x: p.x, y: p.y }, label: L('move', p) });
    pos = { x: p.x, y: p.y };
  };
  const why = (key: string) => (reason ||= t(`rt.mock.reason.${key}`));
  // Plans take longer in game time than the steps suggest (walking, waiting for a decision): eat early.
  const eatAt = Math.min(crit - 1, knobs.eatAtHunger ?? crit - 1);
  const eat = () => {
    why('eat');
    push({ action: 'eat', args: {}, label: L('eat') });
    food -= Math.min(food, Math.ceil(hunger));
    hunger = 0;
  };
  if (hunger >= eatAt && food >= 1) eat();
  // Out in the wild: head back first.
  if (!safe(pos)) {
    const back = w.tiles.filter((x) => w.walkable(x.x, x.y) && safe(x)).sort((a, b) => dist(a) - dist(b))[0];
    if (back) go(back);
  }

  const eco = e.hunger < w.r('critical_hunger') - 1 ? mockEconomy(t, w, e, experimentChance, knobs.offerChance ?? 0) : [];
  for (const s of eco) push(s);
  if (eco.length) {
    reason = t('rt.mock.reason.work');
    const last = [...eco].reverse().find((s) => s.action === 'move_to');
    if (last) pos = { x: Number(last.args.x), y: Number(last.args.y) };
  }

  // Talking: planners greet the nearest person now and then.
  const other = w.living().filter((b) => b.id !== e.id && Math.hypot(b.x - e.x, b.y - e.y) <= w.r('speech_radius'))[0];
  if (other && e.tier !== 'haiku' && rng.next() < 0.35) push({ action: 'say', args: { to: other.name, text: t('rt.mock.say.greet', { name: other.name }) }, label: L('say') });

  for (let guard = 0; steps.length < count.min && guard < count.max * 3; guard++) {
    hunger += hungerPerStep;
    if (w.isNight() && !(w.tile(pos.x, pos.y)?.shelter ?? 0)) {
      const sh = nearest((x) => x.shelter > 0);
      if (sh) {
        why('shelter');
        go(sh);
        push({ action: 'sleep', args: { minutes: 20 }, label: L('sleep') });
        continue;
      }
    }
    if (hunger >= eatAt && food >= 1) {
      eat();
      continue;
    }
    if (food < 2 || (e.role === 'gatherer' && food < 6)) {
      const f = nearest((x) => x.food >= 1);
      if (f) {
        why('food');
        go(f);
        push({ action: 'gather', args: { resource: 'food' }, label: L('gatherFood') });
        push({ action: 'gather', args: { resource: 'food' }, label: L('gatherFood') });
        food += 2 * gatherFood;
        continue;
      }
    }
    const caring = (e.role === 'healer' || e.role === 'elder') && food >= 2 && w.r('sharing_allowed') >= 1;
    const needy = caring ? w.living().find((b) => b.id !== e.id && b.hunger >= crit && b.inventory.food < 1) : undefined;
    if (needy && rng.next() < 0.6) {
      why('care');
      push({ action: 'approach', args: { to: needy.name }, label: L('approach', { name: needy.name }) });
      push({ action: 'give', args: { to: needy.name, resource: 'food', amount: 1 }, label: L('give', { name: needy.name }) });
      push({ action: 'say', args: { to: needy.name, text: t('rt.mock.say.help', { name: needy.name }) }, label: L('say') });
      food -= 1;
      pos = tileOf(needy);
      continue;
    }
    if (e.role === 'builder' || (w.season() === 'autumn' && e.tier !== 'haiku')) {
      if (wood >= cost) {
        why('build');
        push({ action: 'build', args: {}, label: L('build') });
        wood -= cost;
        continue;
      }
      const f = nearest((x) => x.wood >= 1);
      if (f) {
        why('wood');
        go(f);
        for (let i = 0; i < 3; i++) push({ action: 'gather', args: { resource: 'wood' }, label: L('gatherWood') });
        wood += 3 * gatherWood;
        continue;
      }
    }
    if (e.role === 'explorer' || rng.next() < 0.25) {
      const tx = pos.x + Math.round((rng.next() * 2 - 1) * wanderRadius);
      const ty = pos.y + Math.round((rng.next() * 2 - 1) * wanderRadius);
      if (w.walkable(tx, ty) && (safe({ x: tx, y: ty }) || e.role === 'explorer')) {
        why('explore');
        go({ x: tx, y: ty });
        push({ action: 'wait', args: { minutes: 2 }, label: L('wait') });
        continue;
      }
    }
    const here = w.tile(pos.x, pos.y);
    if (here && here.food >= 1) {
      why('idle');
      push({ action: 'gather', args: { resource: 'food' }, label: L('gatherFood') });
      food += gatherFood;
    } else push({ action: 'rest', args: { minutes: 3 }, label: L('rest') });
  }
  return { steps, reason: reason || t('rt.mock.reason.idle') };
}

/** A joint plan: each member's own mock plan, tagged with `who`. */
export function mockGroupPlan(t: Translate, w: RtWorld, members: RtEntity[], count: { min: number; max: number }, knobs: MockKnobs): { summary: string; steps: PlanStep[] } {
  const parts: string[] = [];
  const steps: PlanStep[] = [];
  for (const m of members) {
    const p = mockSteps(t, w, m, count, knobs);
    parts.push(t('rt.mock.part', { name: m.name, label: p.steps[0]?.label ?? t('rt.mock.label.wait') }));
    for (const s of p.steps) steps.push({ ...s, args: { ...s.args, who: m.id } });
  }
  return { summary: t('rt.mock.summary', { parts: parts.join('; ') }), steps };
}

const MODEL_NAME: Record<string, string> = Object.fromEntries(Object.entries(ACTION_ALIASES).map(([model, step]) => [step, model]));

/** Flattens steps to the shape a model writes (`{who?, action, ...args, label}`, model action names). */
export function flatSteps(steps: PlanStep[]): Array<Record<string, unknown>> {
  return steps.map((s) => ({ action: MODEL_NAME[s.action] ?? s.action, ...s.args, label: s.label }));
}
