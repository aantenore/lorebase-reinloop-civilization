// What a person is told. Instructions: identity, personality, role in society (a Role Record
// from Lorebase) and the fact that the world has laws. Each tick: the laws verbatim from
// Lorebase and what the person perceives. No goals beyond staying alive, no advice, no tasks.
// Every text comes from the language templates (config/i18n).
import type { Translate } from '../i18n.ts';
import type { Role, Rule, RuleChange } from '../lorebase/rules.ts';
import { seasonOf, ticksUntilWinter, type World } from '../world/engine.ts';
import type { AgentState, Rules } from '../world/types.ts';

export function instructions(t: Translate, a: Pick<AgentState, 'name' | 'role' | 'personality'>, role: Role | undefined): string {
  return t('instructions', {
    name: a.name,
    personality: a.personality || '-',
    roleTitle: role?.title ?? a.role,
    roleDescription: role?.description ?? '',
  });
}

export function lawsText(t: Translate, rules: Rule[]): string {
  return rules.map((r) => t('observation.lawLine', { key: r.key, value: r.value, unit: r.unit, text: r.text })).join('\n');
}

export function observation(
  t: Translate,
  world: World,
  a: AgentState,
  values: Rules,
  laws: Rule[],
  revision: string,
  lookText: string,
  changed: RuleChange[],
): string {
  const season = seasonOf(world.tick, values);
  const toWinter = ticksUntilWinter(world.tick, values);
  const winter = season === 'winter'
    ? t('observation.winterNow')
    : Number.isFinite(toWinter) ? t('observation.winterIn', { ticks: toWinter }) : t('observation.noWinter');
  const messages = a.inbox.length
    ? a.inbox.map((m) => t(m.to === 'all' ? 'observation.messageToAll' : 'observation.messageToYou', { from: m.fromName, text: m.text })).join('\n')
    : t('observation.noMessages');
  const parts = [
    t('observation.header', { tick: world.tick, season: t(`season.${season}`), winter }),
    t('observation.self', {
      hp: a.hp, maxHp: a.maxHp, hunger: a.hunger, food: a.inventory.food, wood: a.inventory.wood, actions: a.actionsLeft,
      shelter: t(world.isSheltered(a) ? 'observation.sheltered' : 'observation.unsheltered'),
    }),
    t('observation.perceive', { look: lookText }),
    t('observation.messages', { messages }),
    t('observation.laws', { revision: revision.slice(0, 8), laws: lawsText(t, laws) }),
  ];
  if (changed.length) {
    const none = t('observation.none');
    parts.push(t('observation.changed', { changes: changed.map((c) => t('observation.changeLine', { key: c.key, old: c.old ?? none, new: c.new ?? none })).join('\n') }));
  }
  return parts.join('\n\n');
}
