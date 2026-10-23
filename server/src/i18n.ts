// Language templates (config/i18n/<lang>.json): everything people read or say.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Loads `<lang>.json`; the real-time world's texts (`<lang>.rt.json`), when present, are under `rt`. */
export function loadTemplates(root: string, lang: string): Record<string, unknown> {
  const base = JSON.parse(readFileSync(resolve(root, 'config/i18n', `${lang}.json`), 'utf8')) as Record<string, unknown>;
  const rt = resolve(root, 'config/i18n', `${lang}.rt.json`);
  if (existsSync(rt)) base.rt = JSON.parse(readFileSync(rt, 'utf8')) as unknown;
  return base;
}

/** `t('act.gathered', { amount: 2 })`; arrays are joined with newlines; unknown keys return the key. */
export function translator(templates: Record<string, unknown>): Translate {
  return (key, vars = {}) => {
    let node: unknown = templates;
    for (const part of key.split('.')) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
    const text = Array.isArray(node) ? node.join('\n') : typeof node === 'string' ? node : key;
    return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
  };
}
