// Scenario presets (config/scenarios.json): several rule changes applied as one Proposal.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseYaml } from 'reinloop';
import { ROOT } from '../config.ts';

export interface Scenario {
  name: string;
  title: string;
  description: string;
  changes: Array<{ key: string; value: number }>;
}

export function loadScenarios(): Scenario[] {
  const raw = JSON.parse(readFileSync(resolve(ROOT, 'config/scenarios.json'), 'utf8')) as Record<string, { title: string; description: string; changes: Record<string, number> | 'seed' }>;
  return Object.entries(raw).map(([name, s]) => ({
    name,
    title: s.title,
    description: s.description,
    changes: s.changes === 'seed' ? seedValues() : Object.entries(s.changes).map(([key, value]) => ({ key, value })),
  }));
}

export function seedValues(): Array<{ key: string; value: number }> {
  const seed = parseYaml(readFileSync(resolve(ROOT, 'lorebase/rules.seed.yaml'), 'utf8')) as { rules: Array<{ code: string; value: number }> };
  return seed.rules.map((r) => ({ key: r.code, value: r.value }));
}
