import { en } from './en';
import { it, type Dict } from './it';

export type I18nKey = keyof Dict;

const DICTS: Record<string, Dict> = { it, en };
export const lang = (() => {
  const q = new URLSearchParams(location.search).get('lang');
  return q && DICTS[q] ? q : 'it';
})();
const dict = DICTS[lang];

/** Translate a key, substituting `{name}` placeholders. */
export function t(key: I18nKey, params?: Record<string, string | number>): string {
  let s = dict[key] ?? it[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Role label: known roles are translated, unknown ones are shown as sent by the server. */
export function roleLabel(role: string): string {
  const k = `role.${role.toLowerCase()}` as I18nKey;
  return k in dict ? dict[k] : role;
}
