import type { Economy, FlowEdge, GameTime, ItemBag, Recipe, Resource, Tech, ToolState } from '../net/protocol';

/** Station name for recipes that need the village fire. */
export const FIRE = 'fuoco';

export const RESOURCES: Resource[] = [
  { code: 'food', name: 'Bacche', perishable: true },
  { code: 'wood', name: 'Legna', perishable: false },
  { code: 'stone', name: 'Pietra', perishable: false },
  { code: 'clay', name: 'Argilla', perishable: false },
  { code: 'fiber', name: 'Fibra', perishable: false },
  { code: 'herbs', name: 'Erbe', perishable: true },
  { code: 'meat', name: 'Carne', perishable: true },
  { code: 'rope', name: 'Corda', perishable: false },
  { code: 'basket', name: 'Cesto', perishable: false },
  { code: 'stone_axe', name: 'Ascia di pietra', perishable: false },
  { code: 'poultice', name: 'Impiastro', perishable: false },
  { code: 'pot', name: 'Vaso di ceramica', perishable: false },
  { code: 'smoked_meat', name: 'Carne affumicata', perishable: false },
  { code: 'brick', name: 'Mattone', perishable: false },
  { code: 'wall', name: 'Muro', perishable: false },
];

export const RES_NAME: Record<string, string> = Object.fromEntries(RESOURCES.map((r) => [r.code, r.name]));
export const PERISHABLE = RESOURCES.filter((r) => r.perishable).map((r) => r.code);

/** Items that, once handed over, are carried as tools (with durability) instead of bag items. */
export const TOOL_ITEMS: Record<string, number> = { stone_axe: 8, basket: 10 };

export const RECIPES: Recipe[] = [
  { code: 'stone_axe', name: 'Ascia di pietra', inputs: { wood: 2, stone: 1 }, outputs: { stone_axe: 1 }, role: 'builder', tech: 'stone_tools', station: null },
  { code: 'poultice', name: 'Impiastro', inputs: { herbs: 2 }, outputs: { poultice: 1 }, role: 'healer', tech: 'herbalism', station: null },
  { code: 'basket', name: 'Cesto', inputs: { fiber: 3 }, outputs: { basket: 1 }, role: 'builder', tech: 'weaving', station: null },
  { code: 'rope', name: 'Corda', inputs: { fiber: 2 }, outputs: { rope: 1 }, role: 'builder', tech: 'weaving', station: null },
  { code: 'pot', name: 'Vaso di ceramica', inputs: { clay: 2, wood: 1 }, outputs: { pot: 1 }, role: 'elder', tech: 'pottery', station: FIRE },
  { code: 'brick', name: 'Mattone', inputs: { clay: 2 }, outputs: { brick: 2 }, role: 'builder', tech: 'pottery', station: FIRE },
  { code: 'smoked_meat', name: 'Carne affumicata', inputs: { meat: 2, wood: 1 }, outputs: { smoked_meat: 2 }, role: 'hunter', tech: 'smoking', station: FIRE },
  { code: 'wall', name: 'Muro', inputs: { brick: 3, stone: 2 }, outputs: { wall: 1 }, role: 'builder', tech: 'masonry', station: null },
];

export interface TechDef {
  code: string;
  name: string;
  description: string;
  unlocks: string[];
  /** Elapsed seconds (speed-scaled) of the scripted discovery; null = known at start; -1 = never. */
  at: number | null;
  /** Role of the discoverer. */
  byRole: string;
}

export const TECHS: TechDef[] = [
  { code: 'fire', name: 'Fuoco', description: 'Un fuoco acceso e custodito scalda, illumina e cuoce.', unlocks: ['smoking', 'pottery'], at: null, byRole: 'elder' },
  { code: 'stone_tools', name: 'Utensili di pietra', description: 'Pietre scheggiate per tagliare e raschiare.', unlocks: ['stone_axe', 'masonry'], at: null, byRole: 'builder' },
  { code: 'herbalism', name: 'Erboristeria', description: 'Riconoscere le erbe che curano e prepararle.', unlocks: ['poultice', 'weaving'], at: null, byRole: 'healer' },
  { code: 'weaving', name: 'Intreccio', description: 'Intrecciare le fibre per fare corde e ceste.', unlocks: ['basket', 'rope'], at: 35, byRole: 'gatherer' },
  { code: 'pottery', name: 'Ceramica', description: 'Modellare l’argilla e cuocerla al fuoco: vasi e mattoni.', unlocks: ['pot', 'brick'], at: 80, byRole: 'elder' },
  { code: 'smoking', name: 'Affumicatura', description: 'Affumicare la carne perché si conservi più a lungo.', unlocks: ['smoked_meat'], at: 140, byRole: 'hunter' },
  { code: 'masonry', name: 'Muratura', description: 'Alzare muri con mattoni e pietra.', unlocks: ['wall'], at: -1, byRole: 'builder' },
];

/** Who gives what to whom, per role. `p` = chance per plan; `get` = barter counterpart. */
export interface Route {
  toRole: string;
  give: ItemBag;
  get?: ItemBag;
  p: number;
  label: string;
}

export const ROUTES: Record<string, Route[]> = {
  woodcutter: [
    { toRole: 'builder', give: { wood: 2 }, p: 1, label: 'Porta legna al costruttore' },
    { toRole: 'elder', give: { wood: 1 }, p: 0.5, label: 'Porta legna per il fuoco dell’anziano' },
  ],
  builder: [
    { toRole: 'woodcutter', give: { stone_axe: 1 }, p: 0.9, label: 'Consegna un’ascia al taglialegna' },
    { toRole: 'gatherer', give: { basket: 1 }, p: 0.9, label: 'Consegna un cesto alla raccoglitrice' },
  ],
  gatherer: [
    { toRole: 'healer', give: { herbs: 2, food: 1 }, get: { poultice: 1 }, p: 0.9, label: 'Porta erbe alla guaritrice' },
  ],
  healer: [
    { toRole: 'woodcutter', give: { poultice: 1 }, p: 0.7, label: 'Porta un impiastro al taglialegna' },
    { toRole: 'hunter', give: { poultice: 1 }, get: { meat: 1 }, p: 0.6, label: 'Porta un impiastro al cacciatore' },
  ],
  hunter: [
    { toRole: 'gatherer', give: { meat: 1 }, p: 0.8, label: 'Porta carne alla raccoglitrice' },
    { toRole: 'elder', give: { smoked_meat: 1 }, p: 0.7, label: 'Porta carne affumicata all’anziano' },
    { toRole: 'elder', give: { meat: 1 }, p: 0.4, label: 'Porta carne all’anziano' },
  ],
  scout: [
    { toRole: 'builder', give: { stone: 2 }, p: 1, label: 'Porta pietra al costruttore' },
    { toRole: 'elder', give: { clay: 2 }, p: 0.9, label: 'Porta argilla all’anziano' },
  ],
  elder: [
    { toRole: 'gatherer', give: { pot: 1 }, p: 0.9, label: 'Consegna un vaso alla raccoglitrice' },
    { toRole: 'chief', give: { smoked_meat: 1 }, p: 0.3, label: 'Offre carne affumicata al capo' },
  ],
};

/** Raw goods an agent of the role goes out to produce (timed work step). */
export const PRODUCE: Record<string, { items: ItemBag; label: string }> = {
  gatherer: { items: { fiber: 2, herbs: 2 }, label: 'Raccoglie fibre ed erbe' },
  scout: { items: { stone: 2, clay: 2 }, label: 'Cerca pietra e argilla' },
  hunter: { items: { meat: 2 }, label: 'Caccia nel bosco' },
};

/** Recipes a role tries to craft in its plan (in order). */
export const CRAFTS: Record<string, string[]> = {
  builder: ['stone_axe', 'basket'],
  healer: ['poultice'],
  elder: ['pot'],
  hunter: ['smoked_meat'],
};

export const START_INVENTORY: Record<string, ItemBag> = {
  builder: { stone: 3, fiber: 3 },
  healer: { herbs: 3 },
  elder: { clay: 2, wood: 2 },
  hunter: { meat: 3 },
  gatherer: { herbs: 2, fiber: 1 },
  scout: { stone: 2, clay: 2 },
  woodcutter: { wood: 1 },
};

/** Starting tools by agent id. */
export const START_TOOLS: Record<string, ToolState[]> = {
  'a-bruno': [{ item: 'stone_axe', durability: 5, max: 8 }],
  'a-ugo': [{ item: 'stone_axe', durability: 3, max: 8 }],
  'a-gaia': [{ item: 'basket', durability: 6, max: 10 }],
};

/** Plausible first flows, shown until real trades fill the window. */
const SEED_FLOWS: FlowEdge[] = [
  { fromRole: 'woodcutter', toRole: 'builder', item: 'wood', amount: 4 },
  { fromRole: 'builder', toRole: 'woodcutter', item: 'stone_axe', amount: 1 },
  { fromRole: 'scout', toRole: 'builder', item: 'stone', amount: 3 },
  { fromRole: 'gatherer', toRole: 'healer', item: 'herbs', amount: 3 },
  { fromRole: 'healer', toRole: 'hunter', item: 'poultice', amount: 1 },
  { fromRole: 'hunter', toRole: 'gatherer', item: 'meat', amount: 2 },
];

export const FLOW_WINDOW = 30;

export const fmtBag = (b: ItemBag): string =>
  Object.entries(b)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${RES_NAME[k] ?? k}`)
    .join(' e ');

/** Mutable economy knowledge (which techs are discovered) plus the trade ledger behind `flows`. */
export class EconomyState {
  private found = new Map<string, { by: string; at: GameTime }>();
  private ledger: { t: number; fromRole: string; toRole: string; item: string; amount: number }[] = [];
  private last: FlowEdge[] = SEED_FLOWS;

  constructor() {
    for (const t of TECHS) if (t.at === null) this.found.set(t.code, { by: 'gli antichi', at: { day: 1, minute: 0 } });
    // seed trades expire after roughly one window, by then real trades exist
    for (const e of SEED_FLOWS) this.ledger.push({ t: 0, ...e });
  }

  isDiscovered(code: string): boolean {
    return this.found.has(code);
  }

  discover(code: string, by: string, at: GameTime) {
    this.found.set(code, { by, at });
  }

  recipeKnown(r: Recipe): boolean {
    return r.tech === null || this.isDiscovered(r.tech);
  }

  /** False while the item can only come from a recipe nobody has discovered yet. */
  recipeKnownItem(item: string): boolean {
    const makers = RECIPES.filter((r) => item in r.outputs);
    return !makers.length || makers.some((r) => this.recipeKnown(r));
  }

  recipe(code: string): Recipe | undefined {
    const r = RECIPES.find((x) => x.code === code);
    return r && this.recipeKnown(r) ? r : undefined;
  }

  economy(): Economy {
    const techs: Tech[] = TECHS.map((t) => {
      const f = this.found.get(t.code);
      return f
        ? { code: t.code, name: t.name, description: t.description, discovered: true, discoveredBy: f.by, discoveredAt: f.at, unlocks: [...t.unlocks] }
        : { code: t.code, name: '???', description: '', discovered: false, discoveredBy: null, discoveredAt: null, unlocks: [...t.unlocks] };
    });
    const known = RECIPES.filter((r) => this.recipeKnown(r));
    return {
      resources: RESOURCES.map((r) => ({ ...r })),
      recipes: known.map((r) => structuredClone(r)),
      techs,
      hiddenRecipes: RECIPES.length - known.length,
    };
  }

  record(now: number, fromRole: string, toRole: string, bag: ItemBag) {
    for (const [item, amount] of Object.entries(bag)) if (amount > 0) this.ledger.push({ t: now, fromRole, toRole, item, amount });
  }

  /** Aggregate the trades inside the sliding window. */
  flows(now: number): FlowEdge[] {
    this.ledger = this.ledger.filter((l) => now - l.t <= FLOW_WINDOW);
    const agg = new Map<string, FlowEdge>();
    for (const l of this.ledger) {
      const k = `${l.fromRole}>${l.toRole}>${l.item}`;
      const e = agg.get(k);
      if (e) e.amount += l.amount;
      else agg.set(k, { fromRole: l.fromRole, toRole: l.toRole, item: l.item, amount: l.amount });
    }
    if (agg.size) this.last = [...agg.values()];
    return this.last.map((e) => ({ ...e }));
  }
}
