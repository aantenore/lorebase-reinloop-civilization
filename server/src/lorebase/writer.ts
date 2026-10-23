// Writes rule changes to Lorebase: directly on the live branch through the `set_rule`
// Operation (review policy `never`), or through a branch -> Proposal -> review -> merge.
// The simulation never sees these writes here: it learns of them from the change feed.
import type { LorebaseClient } from './client.ts';

export interface WriterConfig {
  branch: string;
  directOperation: string;
  updateOperation: string;
  proposalBranchPrefix: string;
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
