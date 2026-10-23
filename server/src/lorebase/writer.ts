// Writes rule changes to Lorebase: directly on the live branch through the `set_rule`
// Operation (review policy `never`), or through a branch -> Proposal -> review -> merge.
// The simulation never sees these writes here: it learns of them from the change feed.
import type { LorebaseClient } from './client.ts';

export interface WriterConfig {
  branch: string;
  directOperation: string;
  updateOperation: string;
  proposalBranchPrefix: string;
  /** Operation creating a new law directly on the live branch (review policy never). */
  enactOperation: string;
  /** Built-in create Operation of the Rule Kind, used on proposal branches. */
  createOperation: string;
  /** Operation deleting a law directly on the live branch (review policy never). */
  repealOperation: string;
  /** Operation changing a law's wording/category/unit directly (review policy never). */
  amendOperation: string;
  /** Built-in delete Operation of the Rule Kind, used on proposal branches. */
  deleteOperation: string;
}

/** Runs one change directly, or on a `law/` branch merged through an approved Proposal. */
async function directOrProposal(client: LorebaseClient, cfg: WriterConfig, mode: WriteMode, message: string, name: string,
  direct: () => Promise<{ revision: string | null; head: string }>, onBranch: (branch: string) => Promise<unknown>): Promise<WriteResult> {
  try {
    if (mode === 'direct') {
      const out = await direct();
      return { ok: true, revision: out.revision ?? out.head };
    }
    const branch = `${cfg.proposalBranchPrefix}${slug(name)}-${Date.now().toString(36)}`;
    await client.createBranch(branch, cfg.branch);
    await onBranch(branch);
    const proposal = await client.createProposal(branch, cfg.branch, message, message);
    await client.review(proposal.id, 'approve', 'Approved from the civilization console');
    const merged = await client.merge(proposal.id, message);
    await client.deleteBranch(branch).catch(() => undefined);
    return { ok: true, revision: merged.revision, proposalId: proposal.id, branch };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Repeals a law (the Record is deleted; the change feed reports it with `new: null`). */
export function repealRule(client: LorebaseClient, cfg: WriterConfig, key: string, mode: WriteMode, message: string): Promise<WriteResult> {
  return directOrProposal(client, cfg, mode, message, `repeal-${key}`,
    () => client.execute(cfg.repealOperation, { rule: key }, { branch: cfg.branch, message }),
    (branch) => client.execute(cfg.deleteOperation, { key }, { branch, message }));
}

/** Changes the wording, category or unit of a law. */
export function amendRule(client: LorebaseClient, cfg: WriterConfig, rule: { key: string; text: string; category: string; unit?: string }, mode: WriteMode, message: string): Promise<WriteResult> {
  const values = { text: rule.text, category: rule.category, ...(rule.unit !== undefined ? { unit: rule.unit } : {}) };
  return directOrProposal(client, cfg, mode, message, `amend-${rule.key}`,
    () => client.execute(cfg.amendOperation, { rule: rule.key, ...values }, { branch: cfg.branch, message }),
    (branch) => client.execute(cfg.updateOperation, { key: rule.key, ...values }, { branch, message }));
}

export interface NewRule {
  key: string;
  value: number;
  text: string;
  category: string;
  unit?: string;
}

export const RULE_KEY = /^[a-z][a-z0-9_]*$/;

/** Creates a brand-new law: directly (`enact_rule`) or through branch -> Proposal -> merge. */
export async function createRule(client: LorebaseClient, cfg: WriterConfig, rule: NewRule, mode: WriteMode, message: string): Promise<WriteResult> {
  if (!RULE_KEY.test(rule.key)) return { ok: false, error: 'key must be snake_case' };
  if (!Number.isFinite(rule.value)) return { ok: false, error: 'value is not a number' };
  if (!rule.text.trim()) return { ok: false, error: 'text is required' };
  const params = { code: rule.key, value: rule.value, text: rule.text.trim(), category: rule.category, ...(rule.unit ? { unit: rule.unit } : {}) };
  try {
    if (mode === 'direct') {
      const out = await client.execute(cfg.enactOperation, params, { branch: cfg.branch, message });
      return { ok: true, revision: out.revision ?? out.head };
    }
    const branch = `${cfg.proposalBranchPrefix}${slug(`new-${rule.key}`)}-${Date.now().toString(36)}`;
    await client.createBranch(branch, cfg.branch);
    await client.execute(cfg.createOperation, params, { branch, message: `New law ${rule.key}` });
    const proposal = await client.createProposal(branch, cfg.branch, message, message);
    await client.review(proposal.id, 'approve', 'Approved from the civilization console');
    const merged = await client.merge(proposal.id, message);
    await client.deleteBranch(branch).catch(() => undefined);
    return { ok: true, revision: merged.revision, proposalId: proposal.id, branch };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type WriteMode = 'direct' | 'proposal';

export interface WriteResult {
  ok: boolean;
  revision?: string;
  proposalId?: string;
  branch?: string;
  error?: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'change';

export async function writeRules(
  client: LorebaseClient,
  cfg: WriterConfig,
  changes: Array<{ key: string; value: number }>,
  mode: WriteMode,
  message: string,
  title?: string,
): Promise<WriteResult> {
  if (!changes.length) return { ok: false, error: 'no changes' };
  for (const c of changes) if (!Number.isFinite(c.value)) return { ok: false, error: `value of ${c.key} is not a number` };
  try {
    if (mode === 'direct') {
      let revision: string | undefined;
      for (const c of changes) {
        const out = await client.execute(cfg.directOperation, { rule: c.key, value: c.value }, { branch: cfg.branch, message });
        revision = out.revision ?? out.head;
      }
      return { ok: true, revision };
    }
    const branch = `${cfg.proposalBranchPrefix}${slug(title ?? changes.map((c) => c.key).join('-'))}-${Date.now().toString(36)}`;
    await client.createBranch(branch, cfg.branch);
    for (const c of changes) {
      await client.execute(cfg.updateOperation, { key: c.key, value: c.value }, { branch, message: `${c.key} = ${c.value}` });
    }
    const proposal = await client.createProposal(branch, cfg.branch, title ?? message, message);
    await client.review(proposal.id, 'approve', 'Approved from the civilization console');
    const merged = await client.merge(proposal.id, message);
    await client.deleteBranch(branch).catch(() => undefined);
    return { ok: true, revision: merged.revision, proposalId: proposal.id, branch };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
