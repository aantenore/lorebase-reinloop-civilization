// The body's reflex: what a person does by itself while it has no plan (its mind has not decided
// yet, or is still thinking, or is paused). Physics, not strategy: when hungry it eats what it
// carries, or walks to the nearest food and gathers it. Nothing else, and its plan never wakes the
// mind (the mind decides on its own schedule; a plan it commits replaces the reflex at once).
// A busy body only reacts once hunger is critical (rule critical_hunger): it eats what it carries
// without leaving its plan, or, carrying nothing to eat, suspends its plan to fetch food by reflex and
// resumes it afterwards.
import type { Translate } from '../i18n.ts';
import { type PlanStep, tileOf } from './plan.ts';
import type { RtEntity, RtWorld } from './world.ts';

/** `eatAtHunger`: hunger at which the reflex starts; `searchRadius`: tiles (Chebyshev) searched for food; `checkMs`: how often idle bodies are checked. */
export interface ReflexConfig {
  enabled: boolean;
  eatAtHunger: number;
  searchRadius: number;
  checkMs: number;
}

/** Something the person carries that feeds (plain food or a nourishing item of the catalog). */
function carriesFood(w: RtWorld, e: RtEntity): boolean {
  return Object.entries(e.inventory).some(([k, n]) => (n ?? 0) >= 1 && (k === 'food' || (w.catalog.resources.get(k)?.nourish ?? 0) > 0));
}

/** A busy body at critical hunger eats what it carries (true when it ate). */
export function reflexEat(w: RtWorld, e: RtEntity, cfg: ReflexConfig): boolean {
  if (!cfg.enabled || !e.alive || e.hunger < w.r('critical_hunger') || !carriesFood(w, e)) return false;
  return w.eat(e).ok;
}

/** The reflex plan for an idle body, or undefined when there is nothing to do by reflex. */
export function reflexSteps(t: Translate, w: RtWorld, e: RtEntity, cfg: ReflexConfig): PlanStep[] | undefined {
  if (!cfg.enabled || !e.alive || e.hunger < cfg.eatAtHunger) return undefined;
  const eat: PlanStep = { action: 'eat', args: {}, label: t('rt.reflex.eat') };
  if (carriesFood(w, e)) return [eat];
  const here = tileOf(e);
  let best: { x: number; y: number; d: number } | undefined;
  for (const tile of w.tiles) {
    if (tile.food < 1 || !w.walkable(tile.x, tile.y)) continue;
    const d = Math.max(Math.abs(tile.x - here.x), Math.abs(tile.y - here.y));
    if (d <= cfg.searchRadius && (!best || d < best.d)) best = { x: tile.x, y: tile.y, d };
  }
  if (!best) return undefined;
  const gather: PlanStep = { action: 'gather', args: { resource: 'food' }, label: t('rt.reflex.gather') };
  const walk: PlanStep[] = best.d > 0 ? [{ action: 'move_to', args: { x: best.x, y: best.y }, label: t('rt.reflex.move') }] : [];
  return [...walk, gather, eat];
}
