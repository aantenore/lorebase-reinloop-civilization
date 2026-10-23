// The economy of the real-time world: items (Resource), recipes and technologies read from
// Lorebase, and the pure rules that move items around: crafting, experimenting (discovery),
// using, giving, bartering, tool wear and decay. No IO and no numbers of its own: catalog
// values come from Lorebase Records, world numbers from Lorebase Rules passed in by the caller.

export type Bag = Record<string, number>;
export type ResourceCategory = 'food' | 'material' | 'tool' | 'medicine' | 'structure';

export interface ResourceDef {
  code: string;
  name: string;
  description: string;
  category: ResourceCategory;
  perishable: boolean;
  decayPerDay: number;
  /** Tools: uses before breaking. Structures: days before falling apart. */
  durability: number;
  nourish: number;
  heal: number;
  protection: number;
  boosts: string[];
  boost: number;
  source: 'tile' | 'biome' | 'craft';
  biomes: string[];
  gatherYield: number;
  minDistance: number;
}

export interface RecipeDef {
  code: string;
  name: string;
  description: string;
  inputs: Bag;
  outputs: Bag;
  tools: string[];
  role: string | null;
  tech: string | null;
  station: string | null;
  minutes: number;
}

export interface TechDef {
  code: string;
  name: string;
  description: string;
  prerequisites: string[];
}

export interface Discovery {
  by: string;
  role: string;
  day: number;
  minute: number;
}

export interface Catalog {
  resources: Map<string, ResourceDef>;
  recipes: Map<string, RecipeDef>;
  techs: Map<string, TechDef>;
}

export interface ToolInstance {
  item: string;
  durability: number;
  max: number;
}

/** What an economy actor carries (entity subset). */
export interface Holder {
  role: string;
  inventory: Bag;
  tools: ToolInstance[];
}

export const STATION_SHELTER = 'shelter';

const num = (v: unknown, d = 0) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
function bag(v: unknown): Bag {
  const raw = typeof v === 'string' ? safeJson(v) : v;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Bag = {};
  for (const [k, n] of Object.entries(raw as Record<string, unknown>)) {
    const x = num(n);
    if (x > 0) out[k] = x;
  }
  return out;
}
function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function resourceFrom(v: Record<string, unknown>): ResourceDef {
  return {
    code: String(v.code),
    name: String(v.name ?? v.code),
    description: String(v.description ?? ''),
    category: (String(v.category ?? 'material') as ResourceCategory),
    perishable: v.perishable === true || v.perishable === 'true',
    decayPerDay: num(v.decay_per_day),
    durability: num(v.durability),
    nourish: num(v.nourish),
    heal: num(v.heal),
    protection: Math.max(0, Math.min(1, num(v.protection))),
    boosts: list(typeof v.boosts === 'string' ? safeJson(v.boosts) ?? v.boosts : v.boosts),
    boost: num(v.boost, 1),
    source: (['tile', 'biome', 'craft'].includes(String(v.source)) ? String(v.source) : 'craft') as ResourceDef['source'],
    biomes: list(typeof v.biomes === 'string' ? safeJson(v.biomes) ?? v.biomes : v.biomes),
    gatherYield: num(v.gather_yield),
    minDistance: num(v.min_distance),
  };
}

export function recipeFrom(v: Record<string, unknown>, tech?: string): RecipeDef {
  return {
    code: String(v.code),
    name: String(v.name ?? v.code),
    description: String(v.description ?? ''),
    inputs: bag(v.inputs),
    outputs: bag(v.outputs),
    tools: list(typeof v.tools === 'string' ? safeJson(v.tools) ?? v.tools : v.tools),
    role: str(v.role),
    tech: str(v.tech) ?? tech ?? null,
    station: str(v.station),
    minutes: Math.max(0, num(v.minutes)),
  };
}

export function techFrom(v: Record<string, unknown>): TechDef {
  return {
    code: String(v.code),
    name: String(v.name ?? v.code),
    description: String(v.description ?? ''),
    prerequisites: list(typeof v.prerequisites === 'string' ? safeJson(v.prerequisites) ?? v.prerequisites : v.prerequisites),
  };
}

// ---- knowledge ------------------------------------------------------------------------

/** A recipe is known when it needs no technology or its technology is discovered. */
export function recipeKnown(r: RecipeDef, discovered: ReadonlySet<string>): boolean {
  return !r.tech || discovered.has(r.tech);
}

export function knownRecipes(c: Catalog, discovered: ReadonlySet<string>): RecipeDef[] {
  return [...c.recipes.values()].filter((r) => recipeKnown(r, discovered));
}

export function unlocksOf(c: Catalog, tech: string): string[] {
  return [...c.recipes.values()].filter((r) => r.tech === tech).map((r) => r.code);
}

/**
 * Which undiscovered technology (if any) a combination of items reveals: one whose
 * prerequisites are known and that has a recipe whose input set equals `items` (amounts
 * ignored). Ties go to the first technology in catalog order.
 */
export function matchDiscovery(c: Catalog, discovered: ReadonlySet<string>, items: string[]): { tech: TechDef; recipe: RecipeDef } | undefined {
  const want = [...new Set(items)].sort().join('|');
  if (!want) return undefined;
  for (const r of c.recipes.values()) {
    if (!r.tech || discovered.has(r.tech)) continue;
    const tech = c.techs.get(r.tech);
    if (!tech || !tech.prerequisites.every((p) => discovered.has(p))) continue;
    if (Object.keys(r.inputs).sort().join('|') === want) return { tech, recipe: r };
  }
  return undefined;
}

// ---- holdings ------------------------------------------------------------------------------

/** Tile stocks every world has, even with an empty catalog. */
export const BASE_ITEMS = new Set(['food', 'wood']);

/** A finite, non-negative amount (NaN, Infinity and negatives count as 0: never fail open). */
export const amountOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** A syntactically safe item code that cannot collide with object internals. */
export function isItemCode(item: unknown): item is string {
  return typeof item === 'string' && /^[a-z][a-z0-9_]{0,40}$/.test(item) && !(item in Object.prototype);
}

/** An item the world knows: in the catalog, or a base tile stock. */
export function knownItem(c: Catalog, item: unknown): item is string {
  return isItemCode(item) && (c.resources.has(item) || BASE_ITEMS.has(item));
}

/** An empty inventory without prototype (codes can never reach Object.prototype). */
export function newInventory(): Bag {
  const inv = Object.create(null) as Bag;
  for (const k of BASE_ITEMS) inv[k] = 0;
  return inv;
}

export function count(h: Pick<Holder, 'inventory'>, item: string): number {
  return isItemCode(item) && Object.hasOwn(h.inventory, item) ? amountOf(h.inventory[item]) : 0;
}

export function hasAll(h: Pick<Holder, 'inventory'>, need: Bag): boolean {
  return Object.entries(need).every(([k, n]) => count(h, k) >= amountOf(n));
}

/** Adds (or with a negative amount removes) items; tools get or lose instances to match. */
export function addItems(h: Holder, item: string, n: number, def?: ResourceDef): void {
  if (!isItemCode(item) || !Number.isFinite(n) || n === 0) return;
  const next = Math.round((count(h, item) + n) * 100) / 100;
  h.inventory[item] = Math.max(0, next);
  if (def?.category !== 'tool') return;
  const want = Math.max(0, Math.floor(h.inventory[item] ?? 0));
  const mine = h.tools.filter((t) => t.item === item);
  for (let i = mine.length; i < want; i++) h.tools.push({ item, durability: def.durability, max: def.durability });
  if (mine.length > want) {
    // Remove the most worn instances first.
    const drop = mine.sort((a, b) => a.durability - b.durability).slice(0, mine.length - want);
    h.tools = h.tools.filter((t) => !drop.includes(t));
  }
}

/** The tool instance used for `item` (best durability first). */
export function bestTool(h: Holder, item: string): ToolInstance | undefined {
  return h.tools.filter((t) => t.item === item && t.durability > 0).sort((a, b) => b.durability - a.durability)[0];
}

/** Wears a tool instance; returns true when it broke (and was removed). */
export function wearTool(h: Holder, tool: ToolInstance, wear: number): boolean {
  tool.durability = Math.round((tool.durability - wear) * 100) / 100;
  if (tool.durability > 0) return false;
  h.tools = h.tools.filter((t) => t !== tool);
  h.inventory[tool.item] = Math.max(0, (h.inventory[tool.item] ?? 0) - 1);
  return true;
}

/** Gathering multiplier of the best carried tool that boosts `item`, if any. */
export function gatherTool(c: Catalog, h: Holder, item: string): { tool: ToolInstance; boost: number } | undefined {
  let best: { tool: ToolInstance; boost: number } | undefined;
  for (const t of h.tools) {
    const def = c.resources.get(t.item);
    if (!def || t.durability <= 0 || !def.boosts.includes(item)) continue;
    if (!best || def.boost > best.boost || (def.boost === best.boost && t.durability > best.tool.durability)) best = { tool: t, boost: def.boost };
  }
  return best;
}

// ---- crafting ----------------------------------------------------------------------------

export type CraftError = 'unknown_recipe' | 'wrong_role' | 'tech_unknown' | 'missing_station' | 'missing_inputs' | 'missing_tool';

export interface CraftCheck {
  /** Stations at the crafter's tile (`shelter` and structure codes). */
  stations: ReadonlySet<string>;
  discovered: ReadonlySet<string>;
}

export function canCraft(c: Catalog, h: Holder, code: string, ctx: CraftCheck): { recipe: RecipeDef } | { error: CraftError } {
  const r = c.recipes.get(code);
  if (!r) return { error: 'unknown_recipe' };
  if (!recipeKnown(r, ctx.discovered)) return { error: 'unknown_recipe' };
  if (r.role && r.role !== h.role) return { error: 'wrong_role' };
  if (r.station && !ctx.stations.has(r.station)) return { error: 'missing_station' };
  if (r.tools.some((t) => !bestTool(h, t))) return { error: 'missing_tool' };
  if (!hasAll(h, r.inputs)) return { error: 'missing_inputs' };
  return { recipe: r };
}

export interface CraftOutcome {
  inputs: Bag;
  outputs: Bag;
  /** Outputs that are structures: to be placed on the tile by the caller. */
  structures: Bag;
  broken: string[];
}

/** Applies a recipe already validated by `canCraft`. */
export function applyCraft(c: Catalog, h: Holder, r: RecipeDef, toolWear: number): CraftOutcome {
  for (const [k, n] of Object.entries(r.inputs)) addItems(h, k, -n, c.resources.get(k));
  const broken: string[] = [];
  for (const t of r.tools) {
    const inst = bestTool(h, t);
    if (inst && wearTool(h, inst, toolWear)) broken.push(t);
  }
  const outputs: Bag = {};
  const structures: Bag = {};
  for (const [k, n] of Object.entries(r.outputs)) {
    const def = c.resources.get(k);
    if (def?.category === 'structure') structures[k] = n;
    else {
      addItems(h, k, n, def);
      outputs[k] = n;
    }
  }
  return { inputs: { ...r.inputs }, outputs: { ...outputs, ...structures }, structures, broken };
}

/** Stations available on a tile. */
export function stationsOf(tile: { shelter: number; structures?: Bag }): Set<string> {
  const s = new Set<string>();
  if (tile.shelter > 0) s.add(STATION_SHELTER);
  for (const [k, v] of Object.entries(tile.structures ?? {})) if (v > 0) s.add(k);
  return s;
}

// ---- experimenting --------------------------------------------------------------------------

export type ExperimentResult =
  | { ok: false; error: 'too_few_items' | 'missing_inputs' }
  | { ok: true; consumed: Bag; found?: { tech: TechDef; recipe: RecipeDef } };

/** Combines one unit of each item: may discover a technology. Items are consumed either way. */
export function experiment(c: Catalog, h: Holder, items: string[], discovered: ReadonlySet<string>, minItems: number): ExperimentResult {
  const set = [...new Set(items.map((i) => String(i).trim()).filter(Boolean))];
  if (set.some((i) => !knownItem(c, i))) return { ok: false, error: 'missing_inputs' };
  if (set.length < minItems) return { ok: false, error: 'too_few_items' };
  if (set.some((i) => count(h, i) < 1)) return { ok: false, error: 'missing_inputs' };
  const consumed: Bag = {};
  for (const i of set) {
    addItems(h, i, -1, c.resources.get(i));
    consumed[i] = 1;
  }
  const found = matchDiscovery(c, discovered, set);
  return found ? { ok: true, consumed, found } : { ok: true, consumed };
}

// ---- using and eating --------------------------------------------------------------------------

export type UseError = 'unknown_item' | 'not_usable' | 'no_item';

export function useEffect(c: Catalog, h: Holder, item: string): { def: ResourceDef } | { error: UseError } {
  const def = c.resources.get(item);
  if (!def) return { error: 'unknown_item' };
  if (def.nourish <= 0 && def.heal <= 0) return { error: 'not_usable' };
  if (count(h, item) < 1) return { error: 'no_item' };
  return { def };
}

/** The food item someone eats when no item is named: the one closest to spoiling. */
export function defaultFood(c: Catalog, h: Holder): string | undefined {
  const foods = Object.keys(h.inventory).filter((k) => count(h, k) >= 1 && (c.resources.get(k)?.nourish ?? 0) > 0 && (c.resources.get(k)?.heal ?? 0) <= 0);
  return foods.sort((a, b) => (c.resources.get(b)!.decayPerDay - c.resources.get(a)!.decayPerDay))[0];
}

// ---- trading -------------------------------------------------------------------------------------

/** Moves `n` units (tools keep their wear). Returns the amount moved. */
export function transfer(c: Catalog, from: Holder, to: Holder, item: string, n: number): number {
  if (!knownItem(c, item)) return 0;
  const moved = Math.floor(Math.min(amountOf(n), count(from, item)));
  if (moved < 1) return 0;
  const def = c.resources.get(item);
  if (def?.category === 'tool') {
    const sorted = from.tools.filter((t) => t.item === item).sort((a, b) => b.durability - a.durability).slice(0, moved);
    from.tools = from.tools.filter((t) => !sorted.includes(t));
    to.tools.push(...sorted);
    from.inventory[item] = Math.max(0, count(from, item) - moved);
    to.inventory[item] = count(to, item) + moved;
    return moved;
  }
  addItems(from, item, -moved, def);
  addItems(to, item, moved, def);
  return moved;
}

export function cleanBag(raw: unknown, c: Catalog, maxKinds: number): Bag {
  const out: Bag = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Math.floor(num(v));
    if (n >= 1 && knownItem(c, k) && Object.keys(out).length < maxKinds) out[k] = n;
  }
  return out;
}

/** A barter between two holders, both sides checked first. Returns false (nothing moved) if either side lacks items. */
export function barter(c: Catalog, a: Holder, b: Holder, give: Bag, want: Bag): boolean {
  if (!Object.keys(give).length && !Object.keys(want).length) return false;
  if (![...Object.keys(give), ...Object.keys(want)].every((k) => knownItem(c, k))) return false;
  if (!hasAll(a, give) || !hasAll(b, want)) return false;
  for (const [k, n] of Object.entries(give)) transfer(c, a, b, k, n);
  for (const [k, n] of Object.entries(want)) transfer(c, b, a, k, n);
  return true;
}

// ---- decay -----------------------------------------------------------------------------------------

/**
 * Perishable stock spoils continuously: `acc` keeps the fraction not yet lost. Returns the
 * whole units lost per item over `minutes`.
 */
export function spoil(c: Catalog, h: Holder, acc: Bag, minutes: number, dayMinutes: number, factor = 1): Bag {
  const lost: Bag = {};
  for (const [item, n] of Object.entries(h.inventory)) {
    const def = c.resources.get(item);
    if (!def?.perishable || def.decayPerDay <= 0 || n <= 0) continue;
    acc[item] = (acc[item] ?? 0) + n * def.decayPerDay * factor * (minutes / dayMinutes);
    const whole = Math.floor(acc[item]!);
    if (whole >= 1) {
      const take = Math.min(whole, Math.floor(n));
      acc[item]! -= whole;
      if (take >= 1) {
        addItems(h, item, -take, def);
        lost[item] = take;
      }
    }
  }
  for (const k of Object.keys(acc)) if (!h.inventory[k]) delete acc[k];
  return lost;
}

/** Structures wear by their decay per day; returns the codes that fell apart. */
export function wearStructures(c: Catalog, structures: Bag, minutes: number, dayMinutes: number): string[] {
  const gone: string[] = [];
  for (const [k, left] of Object.entries(structures)) {
    const rate = c.resources.get(k)?.decayPerDay ?? 0;
    if (rate <= 0) continue;
    const next = Math.round((left - rate * (minutes / dayMinutes)) * 10000) / 10000;
    if (next <= 0) {
      delete structures[k];
      gone.push(k);
    } else structures[k] = next;
  }
  return gone;
}

/** Share of cold/wilds damage warded off by the best protective item carried. */
export function protectionOf(c: Catalog, h: Holder): { share: number; tool?: ToolInstance } {
  let best: { share: number; tool?: ToolInstance } = { share: 0 };
  for (const t of h.tools) {
    const p = c.resources.get(t.item)?.protection ?? 0;
    if (t.durability > 0 && p > best.share) best = { share: p, tool: t };
  }
  return best;
}

/** Can `item` be gathered on a tile of `biome` at `distance` from the centre of the world? */
export function gatherableAt(def: ResourceDef, biome: string, distance: number): boolean {
  return def.source === 'biome' && def.biomes.includes(biome) && distance >= def.minDistance;
}

// ---- flows ---------------------------------------------------------------------------------------

export interface FlowEdge {
  fromRole: string;
  toRole: string;
  item: string;
  amount: number;
}

/** Goods moved between roles over a window. */
export class Flows {
  private edges = new Map<string, FlowEdge>();
  add(fromRole: string, toRole: string, item: string, amount: number): void {
    if (amount <= 0) return;
    const key = `${fromRole}|${toRole}|${item}`;
    const e = this.edges.get(key) ?? { fromRole, toRole, item, amount: 0 };
    e.amount += amount;
    this.edges.set(key, e);
  }
  /** Returns the window's edges (largest first) and starts a new window. */
  take(): FlowEdge[] {
    const out = [...this.edges.values()].sort((a, b) => b.amount - a.amount);
    this.edges.clear();
    return out;
  }
}
