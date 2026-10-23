import { en } from './en';
import { it, type Dict } from './it';

// Language is chosen once at load: ?lang=en, otherwise Italian.
export type Lang = 'it' | 'en';
const DICTS: Record<Lang, Dict> = { it, en };

const param = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('lang') : null;
export const lang: Lang = param && param in DICTS ? (param as Lang) : 'it';
export const t: Dict = DICTS[lang];

export const roleLabel = (role: string) => t.roles[role] ?? role ?? t.roleFallback;
export const categoryLabel = (c: string) => t.categories[c] ?? c;
export const ruleLabel = (key: string) => t.ruleLabels[key] ?? key.replace(/_/g, ' ');
