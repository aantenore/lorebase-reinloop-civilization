// Writes law changes to the shared knowledge: directly on the live world, or through a draft ->
// proposal -> review -> accept. The simulation never sees these writes here: it learns of them
// from the change feed.
import type { Change, Knowledge } from '../ports/knowledge.ts';

export interface WriterConfig {
  ruleKind: string;
  /** Prefix of the drafts holding proposed law changes. */
  proposalPrefix: string;
}

export type WriteMode = 'direct' | 'proposal';

export interface WriteResult {
  ok: boolean;
  revision?: string;
  proposalId?: string;
  branch?: string;
  error?: string;
}

export interface NewRule {
  key: string;
  value: number;
  text: string;
  category: string;
  unit?: string;
}

export const RULE_KEY = /^[a-z][a-z0-9_]*$/;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'change';

/** Applies changes directly, or on a draft accepted through an approved proposal. */
async function apply(k: Knowledge, cfg: WriterConfig, changes: Change[], mode: WriteMode, message: string, name: string, title = message): Promise<WriteResult> {
  let opened: string | undefined;
  try {
    if (mode === 'direct') return { ok: true, revision: await k.write(changes, { message }) };
    const draft = `${cfg.proposalPrefix}${slug(name)}-${Date.now().toString(36)}`;
    const proposal = await k.propose({ draft, title, description: message, message, changes });
    opened = proposal.id;
    await k.review(proposal.id, 'approve', 'Approved from the civilization console');
    const revision = await k.accept(proposal.id, message);
    return { ok: true, revision, proposalId: proposal.id, branch: draft };
  } catch (err) {
    if (opened) await k.reject(opened).catch(() => undefined);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Repeals a law (the record is deleted; the change feed reports it with `new: null`). */
export function repealRule(k: Knowledge, cfg: WriterConfig, key: string, mode: WriteMode, message: string): Promise<WriteResult> {
  return apply(k, cfg, [{ action: 'delete', kind: cfg.ruleKind, key }], mode, message, `repeal-${key}`);
}

/** Changes the wording, category or unit of a law. */
export function amendRule(k: Knowledge, cfg: WriterConfig, rule: { key: string; text: string; category: string; unit?: string }, mode: WriteMode, message: string): Promise<WriteResult> {
  const values = { text: rule.text, category: rule.category, ...(rule.unit !== undefined ? { unit: rule.unit } : {}) };
  return apply(k, cfg, [{ action: 'update', kind: cfg.ruleKind, key: rule.key, values }], mode, message, `amend-${rule.key}`);
}

/** Creates a brand-new law. */
export async function createRule(k: Knowledge, cfg: WriterConfig, rule: NewRule, mode: WriteMode, message: string): Promise<WriteResult> {
  if (!RULE_KEY.test(rule.key)) return { ok: false, error: 'key must be snake_case' };
  if (!Number.isFinite(rule.value)) return { ok: false, error: 'value is not a number' };
  if (!rule.text.trim()) return { ok: false, error: 'text is required' };
  const values = { code: rule.key, value: rule.value, text: rule.text.trim(), category: rule.category, ...(rule.unit ? { unit: rule.unit } : {}) };
  return apply(k, cfg, [{ action: 'create', kind: cfg.ruleKind, key: rule.key, values }], mode, message, `new-${rule.key}`);
}

/** Changes the values of existing laws (one revision each when direct, one proposal otherwise). */
export async function writeRules(k: Knowledge, cfg: WriterConfig, changes: Array<{ key: string; value: number }>, mode: WriteMode, message: string, title?: string): Promise<WriteResult> {
  if (!changes.length) return { ok: false, error: 'no changes' };
  for (const c of changes) if (!Number.isFinite(c.value)) return { ok: false, error: `value of ${c.key} is not a number` };
  const list: Change[] = changes.map((c) => ({ action: 'update', kind: cfg.ruleKind, key: c.key, values: { value: c.value } }));
  return apply(k, cfg, list, mode, message, title ?? changes.map((c) => c.key).join('-'), title ?? message);
}
