// Offline fallback policy used by the mock provider (no model, no network), so the demo runs
// without an API key. It is not how real agents are prompted: see docs/prompts.md. Behaviour follows from role, state and the laws;
// the tier sets how far ahead a person thinks:
//   haiku  greedy and short-sighted: eats at once, chases the nearest food, ignores winter
//   sonnet plans: keeps a food reserve and gets under a shelter (or builds one) before winter
//   opus   plans and cooperates: also shares with the hungry and talks to the others
import type { MockTurn, ModelRequest } from 'reinloop';
import type { Translate } from '../i18n.ts';
import { rule, seasonOf, ticksUntilWinter, type World } from '../world/engine.ts';
import type { AgentState, Rules, Tile } from '../world/types.ts';

export interface MockHost {
  world(): World;
  rules(): Rules;
  t: Translate;
  reserveFoodTicks: number;
}

interface Call {
  name: string;
  args: Record<string, unknown>;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function stepToward(world: World, from: { x: number; y: number }, to: { x: number; y: number }): { dx: number; dy: number } | undefined {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  for (const [sx, sy] of [[dx, dy], [dx, 0], [0, dy]] as const) {
    if (!sx && !sy) continue;
    const t = world.tile(from.x + sx, from.y + sy);
    if (t && t.biome !== 'water') return { dx: sx, dy: sy };
  }
  return undefined;
}

function wander(world: World, a: AgentState, salt: number): { dx: number; dy: number } | undefined {
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const;
  const start = (hash(a.id) + world.tick * 7 + salt) % dirs.length;
  for (let i = 0; i < dirs.length; i++) {
    const [dx, dy] = dirs[(start + i) % dirs.length]!;
    const t = world.tile(a.x + dx, a.y + dy);
    if (t && t.biome !== 'water') return { dx, dy };
  }
  return undefined;
}

/** Plans this tick's tool calls from the person's own perception. */
export function plan(world: World, rules: Rules, a: AgentState, reserveFoodTicks: number, t: Translate): { calls: Call[]; intent: string } {
  const calls: Call[] = [];
  const tier = a.tier;
  const radius = Math.floor(rule(rules, 'vision_radius'));
  const season = seasonOf(world.tick, rules);
  const toWinter = ticksUntilWinter(world.tick, rules);
  const threshold = rule(rules, 'starvation_threshold');
  const shelterCost = rule(rules, 'shelter_wood_cost');
  const sharing = rule(rules, 'sharing_allowed') >= 1;
  const reserve = Math.ceil(rule(rules, 'food_per_tick') * Math.max(reserveFoodTicks, tier === 'haiku' ? 0 : rule(rules, 'winter_length_ticks')));
  const pos = { x: a.x, y: a.y };
  let food = a.inventory.food;
  let wood = a.inventory.wood;
  let hunger = a.hunger;
  let actions = a.actionsLeft;
  let intent = '';

  const visible = (pred: (t: Tile) => boolean) =>
    world.tiles.filter((t) => dist(t, pos) <= radius && pred(t)).sort((p, q) => dist(p, pos) - dist(q, pos));
  const shelters = world.tiles.filter((t) => t.shelter).sort((p, q) => dist(p, pos) - dist(q, pos));
  const neighbours = world.living().filter((b) => b.id !== a.id && dist(b, a) <= 1);
  const here = () => world.tile(pos.x, pos.y)!;
  const move = (step: { dx: number; dy: number } | undefined) => {
    if (!step || actions <= 0) return false;
    calls.push({ name: 'move', args: step });
    pos.x += step.dx;
    pos.y += step.dy;
    actions--;
    return true;
  };
  const eat = (upTo: number) => {
    const n = Math.min(food, Math.ceil(upTo));
    if (n >= 1) {
      calls.push({ name: 'eat', args: { amount: n } });
      food -= n;
      hunger = Math.max(0, hunger - n);
    }
  };

  // Eating: haiku eats whenever hungry; planners wait until it matters.
  if (tier === 'haiku' ? hunger > 0 : hunger >= threshold - rule(rules, 'food_per_tick')) eat(hunger);

  // Cooperation (opus, and sonnet healers): feed a hungry neighbour.
  if (sharing && (tier === 'opus' || (tier === 'sonnet' && a.role === 'healer')) && actions > 0) {
    const needy = neighbours.filter((b) => b.inventory.food < 1 && b.hunger >= threshold - 1).sort((p, q) => q.hunger - p.hunger)[0];
    if (needy && food > reserve) {
      const amount = Math.max(1, Math.floor((food - reserve) / 2));
      calls.push({ name: 'give', args: { to: needy.name, resource: 'food', amount } });
      food -= amount;
      actions--;
      intent ||= t('mock.shared', { name: needy.name, amount });
    }
  }

  const winterNear = season === 'winter' || toWinter <= reserveFoodTicks + 1;
  const planner = tier !== 'haiku';
  const wantsShelter = planner && winterNear;

  const foodYield = Math.max(1, Math.floor(rule(rules, 'gather_food_yield') * (season === 'winter' ? rule(rules, 'winter_food_yield_multiplier') : 1)));
  const woodYield = Math.max(1, Math.floor(rule(rules, 'gather_wood_yield')));
  const gatherFood = () => {
    calls.push({ name: 'gather', args: { resource: 'food' } });
    food += foodYield;
    actions--;
  };
  const seekFood = () => {
    if (here().food >= 1) return gatherFood(), true;
    // Planners avoid tiles others already stand on; haiku runs for the closest food.
    const taken = new Set(world.living().filter((b) => b.id !== a.id).map((b) => `${b.x},${b.y}`));
    const fields = visible((x) => x.food >= 1 && (x.x !== pos.x || x.y !== pos.y));
    const score = (x: Tile) => x.food - dist(x, pos) - (taken.has(`${x.x},${x.y}`) ? foodYield : 0) + (hash(`${a.id}${x.x},${x.y}`) % 3) / 3;
    const field = planner ? [...fields].sort((p, q) => score(q) - score(p))[0] : fields[0];
    return !!field && move(stepToward(world, pos, field));
  };

  while (actions > 0) {
    const cur = here();
    const urgent = food < 1 && hunger >= threshold - rule(rules, 'food_per_tick');
    if (urgent && seekFood()) { intent ||= t('mock.hungry'); continue; }
    if (wantsShelter && food < reserve && season !== 'winter' && seekFood()) { intent ||= t('mock.storing'); continue; }
    if (wantsShelter && cur.shelter) {
      if (food < reserve && cur.food >= 1) { gatherFood(); continue; }
      calls.push({ name: 'rest', args: {} });
      actions--;
      intent ||= t('mock.staying');
      continue;
    }
    if (wantsShelter && shelters[0] && dist(shelters[0], pos) <= Math.max(radius * 2, toWinter + 1)) {
      if (move(stepToward(world, pos, shelters[0]))) { intent ||= t('mock.heading', { x: shelters[0].x, y: shelters[0].y }); continue; }
    }
    // Builders (any tier) and planners without a shelter in reach work on wood.
    const needsWood = (a.role === 'builder' && food >= reserve) || (wantsShelter && !shelters.length);
    if (needsWood && wood >= shelterCost && !cur.shelter && cur.biome !== 'water') {
      calls.push({ name: 'build_shelter', args: {} });
      wood -= shelterCost;
      actions--;
      intent ||= t('mock.built');
      continue;
    }
    if (needsWood && wood < shelterCost) {
      if (cur.wood >= 1) { calls.push({ name: 'gather', args: { resource: 'wood' } }); wood += woodYield; actions--; intent ||= t('mock.wood'); continue; }
      const forest = visible((x) => x.wood >= 1)[0];
      if (forest && move(stepToward(world, pos, forest))) continue;
    }
    // Food: haiku grabs everything in reach, planners keep a reserve.
    const explorer = a.role === 'explorer';
    if ((tier === 'haiku' || food < reserve * 2) && !(explorer && tier === 'haiku' && world.tick % 2 === 0) && seekFood()) {
      intent ||= t(tier === 'haiku' ? 'mock.grab' : 'mock.store');
      continue;
    }
    if (a.hp < a.maxHp && hunger <= threshold && food >= 1) { calls.push({ name: 'rest', args: {} }); actions--; continue; }
    if (!move(wander(world, { ...a, ...pos }, calls.length))) break;
    intent ||= t('mock.wander');
  }

  // Talking: opus speaks up about shelters, winter and hunger; others rarely.
  const speaks = tier === 'opus' ? (hash(a.id) + world.tick) % 3 === 0 : tier === 'sonnet' && (hash(a.id) + world.tick) % 7 === 0;
  if (speaks) {
    const shelter = shelters[0];
    const text = winterNear && shelter
      ? t('mock.sayShelter', { x: shelter.x, y: shelter.y })
      : winterNear
        ? t('mock.sayNoShelter', { x: pos.x, y: pos.y })
        : food > reserve + 2 && sharing
          ? t('mock.saySpare', { x: pos.x, y: pos.y })
          : t('mock.sayWhere', { x: pos.x, y: pos.y, state: t(visible((x) => x.food >= 1).length ? 'mock.plenty' : 'mock.scarce') });
    calls.push({ name: 'say', args: { to: 'all', text } });
  }
  return { calls, intent: intent || t('mock.idle') };
}

/** Mock step for reinloop's mockProvider: plans on the first turn, comments on the results after. */
export function mockStep(host: MockHost, agentId: string) {
  return (req: ModelRequest): MockTurn => {
    const last = req.messages.at(-1);
    const world = host.world();
    const a = world.get(agentId);
    if (!a || !a.alive) return { text: '...' };
    if (last?.role === 'tool') {
      const failed = last.parts.filter((p) => p.type === 'tool_result' && p.isError).length;
      return { text: failed ? host.t('mock.failed', { n: failed }) : host.t('mock.done') };
    }
    const { calls, intent } = plan(world, host.rules(), a, host.reserveFoodTicks, host.t);
    return { text: intent, toolCalls: calls.map((c) => ({ name: c.name, args: c.args })) };
  };
}
