import { t } from '../i18n';
import type { Role, Season, Tier } from '../types';

// Flavor data for the mock world. Localized text lives in i18n (t.mock).

export const NAMES: { name: string; role: Role; tier: Tier; model: string }[] = [
  { name: 'Aurelia', role: 'elder', tier: 'opus', model: 'claude-opus' },
  { name: 'Corvin', role: 'builder', tier: 'opus', model: 'claude-opus' },
  { name: 'Mira', role: 'gatherer', tier: 'sonnet', model: 'claude-sonnet' },
  { name: 'Tobias', role: 'explorer', tier: 'sonnet', model: 'claude-sonnet' },
  { name: 'Sefa', role: 'healer', tier: 'sonnet', model: 'claude-sonnet' },
  { name: 'Pip', role: 'gatherer', tier: 'haiku', model: 'claude-haiku' },
  { name: 'Wren', role: 'builder', tier: 'haiku', model: 'claude-haiku' },
  { name: 'Odo', role: 'explorer', tier: 'haiku', model: 'claude-haiku' },
];

export const CHILD_NAMES = ['Lio', 'Nell', 'Juno', 'Bram', 'Ysa', 'Kit', 'Ash', 'Rue', 'Fen', 'Ivo'];

const THOUGHTS: Record<Tier, string[]> = t.mock.thoughts;
const MESSAGES: Record<Tier, string[]> = t.mock.messages;

export function pick<T>(arr: T[], r: number): T {
  return arr[Math.floor(r * arr.length) % arr.length];
}

export function thoughtFor(tier: Tier, r: number, vars: Record<string, string | number>): string {
  return fill(pick(THOUGHTS[tier], r), vars);
}

export function messageFor(tier: Tier, r: number, vars: Record<string, string | number>): string {
  return fill(pick(MESSAGES[tier], r), vars);
}

function fill(s: string, vars: Record<string, string | number>) {
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

export const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter'];
