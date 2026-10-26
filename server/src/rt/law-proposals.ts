// Laws proposed by agents. A person esteemed enough (rule law_proposal_min_esteem) writes a law
// change on its own draft (`law/agent-…`: a new law or a change of an existing one) and opens a
// proposal into the live world. The world NEVER approves or accepts it: a human does, in god mode
// or in the knowledge's own review UI. The desk polls the proposals it opened and reports when
// they are accepted (the law then reaches everyone through the change feed) or rejected.
import type { Knowledge } from '../ports/knowledge.ts';
import type { Rule } from '../laws/laws.ts';
import { RULE_KEY } from '../laws/writer.ts';
import type { SocietyConfig } from './config.ts';

export type LawProposalStatus = 'open' | 'merged' | 'rejected';

export interface LawProposal {
  /** Proposal id. */
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
  private readonly knowledge: Knowledge;
  private readonly cfg: SocietyConfig['lawProposals'];
  private readonly ruleKind: string;
  private readonly events: LawDeskEvents;
  private polling = false;

  constructor(knowledge: Knowledge, cfg: SocietyConfig['lawProposals'], ruleKind: string, events: LawDeskEvents) {
    this.knowledge = knowledge;
    this.cfg = cfg;
    this.ruleKind = ruleKind;
    this.events = events;
  }

  openBy(id: string): LawProposal[] {
    return [...this.proposals.values()].filter((p) => p.status === 'open' && p.by === id);
  }

  /** Writes the law on a new draft and opens a proposal. Returns the proposal or an error code. */
  async propose(by: { id: string; name: string }, draft: { key: string; text: string; category: string; value: number }, laws: Rule[]): Promise<LawProposal | string> {
    if (this.openBy(by.id).length >= this.cfg.maxOpen) return 'too_many';
    if ([...this.proposals.values()].some((p) => p.status === 'open' && p.key === draft.key && p.text === draft.text)) return 'duplicate';
    const exists = laws.some((r) => r.key === draft.key);
    const branch = `${this.cfg.branchPrefix}${draft.key.replace(/_/g, '-')}-${Date.now().toString(36)}`;
    const message = `Law proposed by ${by.name}: ${draft.key}`;
    try {
      const values = { value: draft.value, text: draft.text, category: draft.category };
      const pr = await this.knowledge.propose({
        draft: branch,
        title: `Law proposal: ${draft.key} (by ${by.name})`,
        description: `Proposed by ${by.name} (${by.id}). Needs human review: the world never merges it.\n\n${draft.text}`,
        message,
        changes: [exists
          ? { action: 'update', kind: this.ruleKind, key: draft.key, values }
          : { action: 'create', kind: this.ruleKind, key: draft.key, values: { code: draft.key, ...values } }],
      });
      const p: LawProposal = { id: pr.id, by: by.id, byName: by.name, ...draft, branch, status: 'open' };
      this.proposals.set(p.id, p);
      this.events.changed(p);
      return p;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Follows the open proposals: accepted or rejected ones are settled (and their draft discarded). */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const p of [...this.proposals.values()]) {
        if (p.status !== 'open') continue;
        const info = await this.knowledge.proposal(p.id).catch(() => undefined);
        if (!info || info.status === 'open') continue;
        this.settle(p, info.status === 'accepted' ? 'merged' : 'rejected');
      }
    } finally {
      this.polling = false;
    }
  }

  private settle(p: LawProposal, status: LawProposalStatus): void {
    p.status = status;
    void this.knowledge.discardDraft(p.branch).catch(() => undefined);
    this.events.changed(p);
    this.proposals.delete(p.id);
  }

  /** Human decision (god mode): approve + accept, or reject. */
  async decide(id: string, verdict: 'approve' | 'reject', note: string): Promise<LawProposal | string> {
    const p = this.proposals.get(id);
    if (!p || p.status !== 'open') return 'unknown';
    try {
      if (verdict === 'approve') {
        await this.knowledge.review(id, 'approve', note);
        await this.knowledge.accept(id, `Law ${p.key} proposed by ${p.byName}: ${note}`);
      } else {
        await this.knowledge.reject(id, note);
      }
      this.settle(p, verdict === 'approve' ? 'merged' : 'rejected');
      return p;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * After a restart: open proposals from agents' drafts are followed again; `law/` drafts
   * without an open proposal (left by an interrupted write) are discarded.
   */
  async reconcile(lawPrefix: string): Promise<{ reloaded: number; branchesDeleted: number }> {
    const out = { reloaded: 0, branchesDeleted: 0 };
    const open = await this.knowledge.proposals('open');
    for (const pr of open.filter((p) => p.draft.startsWith(this.cfg.branchPrefix))) {
      if (this.proposals.has(pr.id)) continue;
      const m = /^Law proposal: ([a-z][a-z0-9_]*) \(by (.+)\)$/.exec(pr.title);
      const key = m?.[1] ?? '';
      const rec = key ? await this.knowledge.read(this.ruleKind, key, { scope: pr.draft }).catch(() => undefined) : undefined;
      const v = rec?.values ?? {};
      this.proposals.set(pr.id, {
        id: pr.id, by: m?.[2] ?? '', byName: m?.[2] ?? '', key, text: String(v.text ?? pr.description ?? ''), category: String(v.category ?? 'society'),
        value: Number(v.value ?? this.cfg.defaultValue), branch: pr.draft, status: 'open',
      });
      out.reloaded++;
    }
    const busy = new Set(open.map((p) => p.draft));
    for (const draft of await this.knowledge.drafts(lawPrefix)) {
      if (busy.has(draft)) continue;
      await this.knowledge.discardDraft(draft).then(() => out.branchesDeleted++, () => undefined);
    }
    return out;
  }
}
