// Laws proposed by agents. A person esteemed enough (rule law_proposal_min_esteem) writes a law
// change on its own branch (`law/agent-…`: built-in create_rule or update_rule) and opens a
// Proposal into main. The world NEVER approves or merges it: a human does, in god mode or in
// Lorebase's review UI. The desk polls the Proposals it opened and reports when they are
// merged (the law then reaches everyone through the change feed) or closed.
import type { LorebaseClient } from '../lorebase/client.ts';
import type { Rule } from '../lorebase/rules.ts';
import { RULE_KEY } from '../lorebase/writer.ts';
import type { SocietyConfig } from './config.ts';

export type LawProposalStatus = 'open' | 'merged' | 'rejected';

export interface LawProposal {
  /** Lorebase Proposal id. */
  id: string;
  /** Entity id of the proposer (its name after a restart). */
  by: string;
  byName: string;
  text: string;
  key: string;
  category: string;
  value: number;
  branch: string;
  status: LawProposalStatus;
}

export const LAW_CATEGORIES = ['survival', 'economy', 'climate', 'society', 'time'];

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').slice(0, 40).replace(/^_+|_+$/g, '');

/** Validates and completes a proposal from an agent: key (from the text when missing), category, value. Pure. */
export function lawDraft(input: { key?: unknown; text?: unknown; category?: unknown; value?: unknown }, maxText: number, defaultValue: number): { key: string; text: string; category: string; value: number } | { error: string } {
  const text = typeof input.text === 'string' ? input.text.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, maxText) : '';
  if (!text) return { error: 'empty' };
  const category = String(input.category ?? '').trim().toLowerCase();
  if (!LAW_CATEGORIES.includes(category)) return { error: 'category' };
  const raw = typeof input.key === 'string' && input.key.trim() ? input.key.trim().toLowerCase() : `legge_${slug(text)}`;
  const key = raw.slice(0, 60);
  if (!RULE_KEY.test(key)) return { error: 'key' };
  const v = input.value === undefined || input.value === null || input.value === '' ? defaultValue : Number(input.value);
  if (!Number.isFinite(v)) return { error: 'value' };
  return { key, text, category, value: v };
}

export interface LawDeskEvents {
  changed(p: LawProposal): void;
}

export class LawDesk {
  readonly proposals = new Map<string, LawProposal>();
  private readonly client: LorebaseClient;
  private readonly main: string;
  private readonly cfg: SocietyConfig['lawProposals'];
  private readonly ops: { create: string; update: string; ruleKind: string };
  private readonly events: LawDeskEvents;
  private polling = false;

  constructor(client: LorebaseClient, main: string, cfg: SocietyConfig['lawProposals'], ops: { create: string; update: string; ruleKind: string }, events: LawDeskEvents) {
    this.client = client;
    this.main = main;
    this.cfg = cfg;
    this.ops = ops;
    this.events = events;
  }

  openBy(id: string): LawProposal[] {
    return [...this.proposals.values()].filter((p) => p.status === 'open' && p.by === id);
  }

  /** Writes the draft on a new branch and opens a Proposal. Returns the proposal or an error code. */
  async propose(by: { id: string; name: string }, draft: { key: string; text: string; category: string; value: number }, laws: Rule[]): Promise<LawProposal | string> {
    if (this.openBy(by.id).length >= this.cfg.maxOpen) return 'too_many';
    if ([...this.proposals.values()].some((p) => p.status === 'open' && p.key === draft.key && p.text === draft.text)) return 'duplicate';
    const exists = laws.some((r) => r.key === draft.key);
    const branch = `${this.cfg.branchPrefix}${draft.key.replace(/_/g, '-')}-${Date.now().toString(36)}`;
    const message = `Law proposed by ${by.name}: ${draft.key}`;
    try {
      await this.client.createBranch(branch, this.main);
      const params = exists
        ? { key: draft.key, value: draft.value, text: draft.text, category: draft.category }
        : { code: draft.key, value: draft.value, text: draft.text, category: draft.category };
      await this.client.execute(exists ? this.ops.update : this.ops.create, params, { branch, message });
      const pr = await this.client.createProposal(branch, this.main, `Law proposal: ${draft.key} (by ${by.name})`, `Proposed by ${by.name} (${by.id}). Needs human review: the world never merges it.\n\n${draft.text}`);
      const p: LawProposal = { id: pr.id, by: by.id, byName: by.name, ...draft, branch, status: 'open' };
      this.proposals.set(p.id, p);
      this.events.changed(p);
      return p;
    } catch (err) {
      await this.client.deleteBranch(branch).catch(() => undefined);
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Follows the open Proposals: merged or closed ones are settled (and their branch deleted). */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const p of [...this.proposals.values()]) {
        if (p.status !== 'open') continue;
        const info = await this.client.getProposal(p.id).catch(() => undefined);
        if (!info || info.status === 'open') continue;
        this.settle(p, info.status === 'merged' ? 'merged' : 'rejected');
      }
    } finally {
      this.polling = false;
    }
  }

  private settle(p: LawProposal, status: LawProposalStatus): void {
    p.status = status;
    void this.client.deleteBranch(p.branch).catch(() => undefined);
    this.events.changed(p);
    this.proposals.delete(p.id);
  }

  /** Human decision (god mode): approve + merge, or close. */
  async decide(id: string, verdict: 'approve' | 'reject', note: string): Promise<LawProposal | string> {
    const p = this.proposals.get(id);
    if (!p || p.status !== 'open') return 'unknown';
    try {
      if (verdict === 'approve') {
        await this.client.review(id, 'approve', note);
        await this.client.merge(id, `Law ${p.key} proposed by ${p.byName}: ${note}`);
      } else {
        await this.client.review(id, 'request_changes', note).catch(() => undefined);
        await this.client.closeProposal(id);
      }
      this.settle(p, verdict === 'approve' ? 'merged' : 'rejected');
      return p;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * After a restart: open Proposals from agents' branches are followed again; `law/` branches
   * without an open Proposal (left by an interrupted write) are deleted.
   */
  async reconcile(lawPrefix: string): Promise<{ reloaded: number; branchesDeleted: number }> {
    const out = { reloaded: 0, branchesDeleted: 0 };
    const open = (await this.client.listProposals('open')).filter((p) => p.target_ref === this.main);
    for (const pr of open.filter((p) => p.source_ref.startsWith(this.cfg.branchPrefix))) {
      if (this.proposals.has(pr.id)) continue;
      const m = /^Law proposal: ([a-z][a-z0-9_]*) \(by (.+)\)$/.exec(pr.title);
      const key = m?.[1] ?? '';
      const rec = key ? await this.client.request<{ record?: { values: Record<string, unknown> } }>('GET', `${this.client.url}/api/v1/domains/${encodeURIComponent(this.client.domain)}/kinds/${encodeURIComponent(this.ops.ruleKind)}/records/${encodeURIComponent(key)}?branch=${encodeURIComponent(pr.source_ref)}`).catch(() => undefined) : undefined;
      const v = rec?.record?.values ?? {};
      this.proposals.set(pr.id, {
        id: pr.id, by: m?.[2] ?? '', byName: m?.[2] ?? '', key, text: String(v.text ?? pr.description ?? ''), category: String(v.category ?? 'society'),
        value: Number(v.value ?? this.cfg.defaultValue), branch: pr.source_ref, status: 'open',
      });
      out.reloaded++;
    }
    const busy = new Set(open.map((p) => p.source_ref));
    for (const b of await this.client.listBranches()) {
      if (!b.name.startsWith(lawPrefix) || busy.has(b.name)) continue;
      await this.client.deleteBranch(b.name).then(() => out.branchesDeleted++, () => undefined);
    }
    return out;
  }
}
