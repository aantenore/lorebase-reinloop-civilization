// What a person of the real-time world reads: identity, personality, role (code and title from
// the Lorebase Role Record) and a factual statement of its faculties (a mind connected to
// Lorebase, a private memory); then short factual perception, what was said to them and what
// they lived. The laws are NOT in the prompt: they are in Lorebase, to be consulted through
// the MCP tools. No tasks, goals or strategy. Texts come from config/i18n.
import type { Translate } from '../i18n.ts';
import type { Role, RuleChange } from '../lorebase/rules.ts';
import { tileOf } from './plan.ts';
import { DAY_MINUTES, type RtEntity, type RtWorld } from './world.ts';

export interface GroupView {
  id: string;
  name: string;
  pattern: string;
  members: string[];
}

export interface PromptLimits {
  lookMaxTiles: number;
  lookMaxPeople: number;
  nearbyGroupsMax: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function rtInstructions(t: Translate, e: Pick<RtEntity, 'name' | 'personality' | 'role'>, role: Role | undefined, plan: { horizon: number }): string {
  return t('rt.instructions', {
    name: e.name,
    personality: e.personality || '-',
    roleTitle: role?.title ?? e.role,
    role: e.role,
    horizon: Math.round(plan.horizon),
  });
}

/** Which laws changed since the person last thought (a fact it perceives); empty when none. */
export function changedBlock(t: Translate, changed: RuleChange[]): string {
  if (!changed.length) return '';
  const none = t('rt.observation.none');
  return t('rt.observation.changed', { changes: changed.map((c) => t('rt.observation.changeLine', { key: c.key, old: c.old ?? none, new: c.new ?? none })).join('\n') });
}

/** How a law change is proclaimed to every person: the full text of the law from Lorebase, and its value. */
export function proclamation(t: Translate, c: RuleChange): string {
  if (c.new === null) return t('rt.proclamation.removed', { text: c.text, key: c.key });
  if (c.old === null) return t('rt.proclamation.new', { text: c.text, key: c.key, value: c.new });
  return t('rt.proclamation.changed', { text: c.text, key: c.key, old: c.old, new: c.new });
}

/** Memories recalled from the private memory for the moment at hand; empty when none. */
export function recalledBlock(t: Translate, lines: string[]): string {
  return lines.length ? t('rt.observation.recalled', { memory: lines.map((m) => `- ${m}`).join('\n') }) : '';
}

export function timeLine(t: Translate, w: RtWorld): string {
  const season = w.season();
  const year = Math.max(1, Math.round(w.r('winter_every_ticks')));
  const winterTurns = Math.min(year, Math.max(0, Math.round(w.r('winter_length_ticks'))));
  const p = w.seasonTurn % year;
  const winter = season === 'winter'
    ? t('rt.observation.winterNow')
    : winterTurns === 0
      ? t('rt.observation.noWinter')
      : t('rt.observation.winterIn', { minutes: Math.round((year - winterTurns - p) * w.r('season_turn_minutes') - ((w.clock - w.epoch) % w.r('season_turn_minutes'))) });
  return t('rt.observation.header', {
    day: w.day, clock: w.clockText(), daypart: t(`rt.daypart.${w.isNight() ? 'night' : 'day'}`), season: t(`season.${season}`), winter,
  });
}

/** What a person carries, by name and code (codes are how tools and recipes name items). */
export function carried(t: Translate, w: RtWorld, e: RtEntity): { items: string; tools: string } {
  const name = (code: string) => w.catalog.resources.get(code)?.name ?? code;
  const toolCodes = new Set(e.tools.map((x) => x.item));
  const items = Object.entries(e.inventory).filter(([k, n]) => n >= 1 && !toolCodes.has(k)).map(([code, n]) => t('rt.observation.itemLine', { amount: Math.floor(n), name: name(code), code }));
  const tools = e.tools.map((x) => t('rt.observation.toolLine', { name: name(x.item), code: x.item, durability: round1(x.durability), max: x.max }));
  return { items: items.join(', ') || t('rt.observation.nothingCarried'), tools: tools.join(', ') || t('rt.observation.noTools') };
}

export function selfLine(t: Translate, w: RtWorld, e: RtEntity): string {
  const p = tileOf(e);
  return t('rt.observation.self', {
    hp: round1(e.hp), maxHp: e.maxHp, hunger: round1(e.hunger), ...carried(t, w, e), x: p.x, y: p.y,
    shelter: t(w.isSheltered(e) ? 'rt.observation.sheltered' : 'rt.observation.unsheltered'),
    speed: round1(w.speedOf(e) / Math.max(1e-6, w.r('game_minutes_per_real_second'))), work: round1(w.workSpeedOf(e)),
  });
}

/** `about(b)`: what the person has heard of `b` (hearsay, appended to the person's line). */
export function look(t: Translate, w: RtWorld, e: RtEntity, groups: GroupView[], roleTitle: (code: string) => string, limits: PromptLimits, about?: (b: RtEntity) => string): string {
  const here = tileOf(e);
  const ht = w.tile(here.x, here.y)!;
  const r = Math.max(0, Math.floor(w.r('vision_radius')));
  const dist = (a: { x: number; y: number }) => Math.max(Math.abs(a.x - here.x), Math.abs(a.y - here.y));
  const tiles = w.tiles
    .filter((x) => x !== ht && dist(x) <= r && (x.food >= 1 || x.wood >= 1 || x.shelter > 0 || Object.keys(x.structures).length > 0))
    .sort((a, b) => dist(a) - dist(b))
    .slice(0, limits.lookMaxTiles)
    .map((x) => t('rt.look.tile', { x: x.x, y: x.y, biome: t(`rt.biome.${x.biome}`), food: x.food, wood: x.wood, shelter: `${x.shelter ? t('rt.look.tileShelter', { level: x.shelter }) : ''}${structuresText(t, w, x)}` }));
  const groupName = (id: string | null) => groups.find((g) => g.id === id)?.name;
  const people = w.living()
    .filter((b) => b.id !== e.id && dist(tileOf(b)) <= r)
    .sort((a, b) => dist(tileOf(a)) - dist(tileOf(b)))
    .slice(0, limits.lookMaxPeople)
    .map((b) => {
      const bp = tileOf(b);
      const g = groupName(b.groupId);
      return t('rt.look.person', {
        name: b.name, role: roleTitle(b.role), group: g ? t('rt.look.personGroup', { group: g }) : '', x: bp.x, y: bp.y,
        hp: round1(b.hp), hunger: round1(b.hunger), food: b.inventory.food, busy: b.kind === 'player' ? t('rt.look.personPlayer') : '',
      }) + (about?.(b) ?? '');
    });
  const shelters = w.tiles.filter((x) => x.shelter > 0).sort((a, b) => dist(a) - dist(b));
  const nearest = shelters[0] ? t('rt.look.shelterAt', { x: shelters[0].x, y: shelters[0].y, level: shelters[0].shelter, steps: dist(shelters[0]) }) : t('rt.look.noShelter');
  const near = groups
    .filter((g) => g.members.some((id) => {
      const m = w.entities.get(id);
      return m && m.alive && dist(tileOf(m)) <= r;
    }))
    .slice(0, limits.nearbyGroupsMax)
    .map((g) => t('rt.look.groupLine', { name: g.name, pattern: g.pattern, members: g.members.map((id) => w.entities.get(id)?.name ?? id).join(', ') }));
  return [
    t('rt.look.here', { x: here.x, y: here.y, biome: t(`rt.biome.${ht.biome}`), elev: ht.elev, food: ht.food, wood: ht.wood, shelter: `${ht.shelter ? t('rt.look.shelterHere', { level: ht.shelter }) : ''}${structuresText(t, w, ht)}` }) + (w.distanceFromCenter(here) > w.r('wild_distance') ? t('rt.look.wild') : ''),
    t('rt.look.map', { w: w.width, h: w.height }),
    t('rt.look.tiles', { radius: r, tiles: tiles.length ? tiles.join('; ') : t('rt.look.nothing') }),
    t('rt.look.people', { people: people.length ? people.join('; ') : t('rt.look.nobody') }),
    t('rt.look.shelters', { shelter: nearest }),
    t('rt.look.groups', { groups: near.length ? near.join('; ') : t('rt.look.noGroups') }),
  ].join('\n');
}

function structuresText(t: Translate, w: RtWorld, tile: { structures: Record<string, number> }): string {
  const list = Object.keys(tile.structures).map((code) => t('rt.look.structureLine', { name: w.catalog.resources.get(code)?.name ?? code, code }));
  return list.length ? t('rt.look.structures', { list: list.join(', ') }) : '';
}

const clockOf = (minute: number) => {
  const m = Math.floor(minute % DAY_MINUTES);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export function inboxBlock(t: Translate, e: RtEntity): string {
  const lines = e.inbox.map((m) => t(m.to === 'all' ? 'rt.observation.messageToAll' : 'rt.observation.messageToYou', { clock: clockOf(m.minute), from: m.fromName, text: m.text }));
  return t('rt.observation.messages', { messages: lines.length ? lines.join('\n') : t('rt.observation.noMessages') });
}

export function memoryBlock(t: Translate, e: RtEntity): string {
  return t('rt.observation.memory', { memory: e.memory.length ? e.memory.map((m) => `- ${m}`).join('\n') : t('rt.observation.noMemory') });
}

export function doingLine(t: Translate, e: RtEntity): string {
  const p = e.plan;
  if (!p || p.current >= p.steps.length) return t('rt.observation.idle');
  return t('rt.observation.doing', { reason: p.reason, current: p.current + 1, total: p.steps.length, label: p.steps[p.current]!.label });
}

export function groupLine(t: Translate, w: RtWorld, e: RtEntity, groups: GroupView[]): string {
  const g = groups.find((x) => x.id === e.groupId);
  if (!g) return t('rt.observation.noGroup');
  return t('rt.observation.group', { name: g.name, pattern: t(`rt.pattern.${g.pattern}`), members: g.members.map((id) => w.entities.get(id)?.name ?? id).join(', ') });
}

/** The full observation of one person at decision time. */
export function rtObservation(
  t: Translate, w: RtWorld, e: RtEntity, why: string, groups: GroupView[], roleTitle: (code: string) => string, limits: PromptLimits,
  changed: RuleChange[],
  society?: { about(e: RtEntity, b: RtEntity): string; blocks(e: RtEntity): string[] },
): string {
  return [
    timeLine(t, w),
    selfLine(t, w, e),
    groupLine(t, w, e, groups),
    doingLine(t, e),
    t('rt.observation.why', { why }),
    t('rt.observation.perceive', { look: look(t, w, e, groups, roleTitle, limits, society ? (b) => society.about(e, b) : undefined) }),
    ...(society?.blocks(e) ?? []),
    inboxBlock(t, e),
    memoryBlock(t, e),
    changedBlock(t, changed),
  ].filter(Boolean).join('\n\n');
}

/** One line per member, for group decisions. */
export function memberLine(t: Translate, w: RtWorld, e: RtEntity, roleTitle: (code: string) => string): string {
  const p = tileOf(e);
  const cur = e.plan && e.plan.current < e.plan.steps.length ? e.plan.steps[e.plan.current]!.label : undefined;
  return t('rt.group.member', {
    name: e.name, id: e.id, role: roleTitle(e.role), x: p.x, y: p.y, hp: round1(e.hp), maxHp: e.maxHp, hunger: round1(e.hunger),
    food: e.inventory.food ?? 0, wood: e.inventory.wood ?? 0, doing: cur ? t('rt.group.memberDoing', { label: cur }) : t('rt.group.memberIdle'),
  });
}
