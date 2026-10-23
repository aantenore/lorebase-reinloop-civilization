// Who a newborn is. Every individual agent is one more LLM mind (and its cost), so births are
// bounded: beyond `maxAgentMinds` a birth is blocked or the child joins the crowd (one shared
// cheap mind). The child's tier is one of its parents' tiers at random, or a fixed tier.
import type { Tier } from '../world/types.ts';
import type { GameConfig } from './config.ts';
import type { EntityKind, RtEntity } from './world.ts';

export interface ChildSpec {
  tier: Tier;
  kind: EntityKind;
}

type Parent = Pick<RtEntity, 'tier' | 'kind'>;

const TIERS: Tier[] = ['haiku', 'sonnet', 'opus'];
const asTier = (t: string, fallback: Tier): Tier => (TIERS.includes(t as Tier) ? (t as Tier) : fallback);

/**
 * The newborn of `a` and `b`, or undefined when no birth may happen. `agentMinds` counts the
 * living individual agents; `rnd` is the world's seeded generator.
 */
export function childSpec(cfg: Pick<GameConfig, 'births' | 'crowd'>, a: Parent, b: Parent, agentMinds: number, rnd: () => number): ChildSpec | undefined {
  const crowd: ChildSpec = { tier: cfg.crowd.tier, kind: 'crowd' };
  // Two crowd extras have a crowd child: it adds no individual mind.
  if (a.kind !== 'agent' && b.kind !== 'agent') return crowd;
  if (agentMinds >= cfg.births.maxAgentMinds) return cfg.births.atCap === 'crowd' ? crowd : undefined;
  const parents = [a, b].filter((p) => p.kind === 'agent');
  const pick = parents.length > 1 ? (rnd() < 0.5 ? parents[0]! : parents[1]!) : parents[0]!;
  const tier = cfg.births.childTier === 'random-parent' ? asTier(pick.tier, cfg.crowd.tier) : asTier(cfg.births.childTier, cfg.crowd.tier);
  return { tier, kind: 'agent' };
}

/** Whether one more individual agent may be added (births and the roster API share the cap). */
export function canAddAgentMind(cfg: Pick<GameConfig, 'births'>, agentMinds: number): boolean {
  return agentMinds < cfg.births.maxAgentMinds;
}
