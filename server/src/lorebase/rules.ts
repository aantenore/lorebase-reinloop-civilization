// Rule Records <-> the rule shape used by the simulation and the HTTP API.
import type { LorebaseClient, RecordItem } from './client.ts';

export interface Rule {
  key: string;
  value: number;
  text: string;
  category: string;
  unit: string;
}

export interface RuleChange {
  key: string;
  old: number | null;
  new: number | null;
  text: string;
}

export interface Role {
  key: string;
  title: string;
  description: string;
  /** Speed multipliers used by the real-time world; absent means 1. */
  moveFactor?: number;
  workFactor?: number;
}

export interface RoleChange {
  key: string;
  title: string;
  description: string | null;
}

/** Laws (Rule) and social roles (Role) of one Revision of the branch. */
export interface RuleSnapshot {
  revision: string;
  rules: Rule[];
  roles: Role[];
}

export interface LawKinds {
  ruleKind: string;
  roleKind: string;
}

export function ruleFromRecord(r: RecordItem): Rule {
  const v = r.values;
  return {
    key: String(v.code ?? r.key),
    value: Number(v.value),
    text: String(v.text ?? ''),
    category: String(v.category ?? ''),
    unit: String(v.unit ?? ''),
  };
}

export function roleFromRecord(r: RecordItem): Role {
  const v = r.values;
  const factor = (x: unknown) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? undefined : Number(x));
  return {
    key: String(v.code ?? r.key),
    title: String(v.title ?? v.code ?? r.key),
    description: String(v.description ?? ''),
    moveFactor: factor(v.move_factor),
    workFactor: factor(v.work_factor),
  };
}

export async function loadRules(client: LorebaseClient, kinds: LawKinds, branch: string): Promise<RuleSnapshot> {
  const rules = await client.listRecords(kinds.ruleKind, branch);
  const roles = await client.listRecords(kinds.roleKind, branch).catch(() => ({ revision: rules.revision, items: [] as RecordItem[] }));
  return {
    revision: rules.revision,
    rules: rules.items.map(ruleFromRecord).sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key)),
    roles: roles.items.map(roleFromRecord).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export function diffRoles(before: Role[], after: Role[]): RoleChange[] {
  const old = new Map(before.map((r) => [r.key, r]));
  const changes: RoleChange[] = after
    .filter((r) => {
      const o = old.get(r.key);
      return o?.description !== r.description || o?.title !== r.title || o?.moveFactor !== r.moveFactor || o?.workFactor !== r.workFactor;
    })
    .map((r) => ({ key: r.key, title: r.title, description: r.description }));
  const now = new Set(after.map((r) => r.key));
  for (const o of before) if (!now.has(o.key)) changes.push({ key: o.key, title: o.title, description: null });
  return changes;
}

export function ruleValues(rules: Rule[]): Record<string, number> {
  return Object.fromEntries(rules.map((r) => [r.key, r.value]));
}

export function diffRules(before: Rule[], after: Rule[]): RuleChange[] {
  const old = new Map(before.map((r) => [r.key, r]));
  const now = new Map(after.map((r) => [r.key, r]));
  const changes: RuleChange[] = [];
  for (const [key, r] of now) {
    const o = old.get(key);
    if (!o || o.value !== r.value || o.text !== r.text) changes.push({ key, old: o?.value ?? null, new: r.value, text: r.text });
  }
  for (const [key, o] of old) if (!now.has(key)) changes.push({ key, old: o.value, new: null, text: o.text });
  return changes;
}
