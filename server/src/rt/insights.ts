// Shared consciousness of each social role, kept in Lorebase as `Insight` Records. An insight is
// written on its own branch `role/<role>/<slug>` and proposed into main; a PEER (another living
// person of the same role, never the author) approves or rejects it. All agents share one
// Keeper principal, so the peer rule is enforced here; the reviewer is recorded on the Record,
// in the review comment and in the merge message. A role with a single living member gets its
// insights accepted after `autoAcceptMinutes` of game time.
import { randomUUID } from 'node:crypto';
import type { LorebaseClient, RecordItem } from '../lorebase/client.ts';
import type { InsightConfig } from './config.ts';

export type InsightStatus = 'proposed' | 'accepted' | 'retired' | 'rejected';

export interface Insight {
  code: string;
  role: string;
  text: string;
  confidence: number;
  author: string;
  reviewer?: string;
  day: number;
  evidence?: string;
  status: InsightStatus;
}

interface Pending {
  insight: Insight;
  branch: string;
  proposalId: string;
  /** Game clock (minutes) when it was shared. */
  sharedAt: number;
  /** Weight of the approvals so far (an insight is merged once it reaches 1). */
  approved: number;
  approvers: string[];
}

export interface InsightEvents {
  changed(insight: Insight, action: 'proposed' | 'accepted' | 'rejected' | 'retired', reviewer?: string): void;
  /** Weight of one approval by this reviewer (esteem); 1 by default, Infinity approves alone. */
  approvalWeight?(reviewer: { name: string; role: string }): number;
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'insight';

export function insightFromRecord(r: RecordItem): Insight {
  const v = r.values;
  return {
    code: String(v.code ?? r.key),
    role: String(v.role ?? ''),
    text: String(v.text ?? ''),
    confidence: Number(v.confidence ?? 0),
    author: String(v.author ?? ''),
    reviewer: v.reviewer ? String(v.reviewer) : undefined,
    day: Number(v.day ?? 0),
    evidence: v.evidence ? String(v.evidence) : undefined,
    status: (String(v.status ?? 'proposed') as InsightStatus),
  };
}

/** Who may judge an insight: a different person holding the same role. Pure. */
export function peerCheck(insight: Pick<Insight, 'role' | 'author'>, reviewer: { name: string; role: string }): 'ok' | 'not_peer' | 'own' {
  if (reviewer.name === insight.author) return 'own';
  if (reviewer.role !== insight.role) return 'not_peer';
  return 'ok';
}

export class InsightBook {
  private readonly client: LorebaseClient;
  private readonly cfg: InsightConfig;
  private readonly main: string;
  private readonly events: InsightEvents;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  constructor(client: LorebaseClient, main: string, cfg: InsightConfig, events: InsightEvents) {
    this.client = client;
    this.main = main;
    this.cfg = cfg;
    this.events = events;
  }

  pendingFor(role: string, exceptAuthor?: string): Insight[] {
    return [...this.pending.values()].filter((p) => p.insight.role === role && p.insight.author !== exceptAuthor).map((p) => p.insight);
  }

  allPending(): Insight[] {
    return [...this.pending.values()].map((p) => p.insight);
  }

  /** Records on main (accepted or retired), optionally of one role. */
  async stored(role?: string): Promise<Insight[]> {
    const { items } = await this.client.listRecords(this.cfg.kind, this.main).catch(() => ({ items: [] as RecordItem[] }));
    return items.map(insightFromRecord).filter((i) => !role || i.role === role);
  }

  async share(author: { name: string; role: string }, text: string, confidence: number, evidence: string, day: number, clock: number): Promise<Insight | string> {
    if (!this.cfg.enabled) return 'disabled';
    const clean = text.trim().slice(0, this.cfg.textMaxChars);
    if (!clean) return 'empty';
    if (this.pendingFor(author.role).length >= this.cfg.maxPendingPerRole) return 'too_many';
    const code = `ins-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const insight: Insight = {
      code, role: author.role, text: clean, confidence: Math.max(0, Math.min(1, Number(confidence) || 0)), author: author.name, day,
      evidence: evidence.trim().slice(0, this.cfg.textMaxChars) || undefined, status: 'proposed',
    };
    const branch = `${this.cfg.branchPrefix}${author.role}/${slug(clean)}-${Date.now().toString(36)}`;
    try {
      await this.client.createBranch(branch, this.main);
      await this.client.execute(this.cfg.operation, {
        code, role: author.role, role_code: author.role, text: insight.text, confidence: insight.confidence, author: author.name, day,
        ...(insight.evidence ? { evidence: insight.evidence } : {}),
      }, { branch, message: `Insight of ${author.role} by ${author.name}`, idempotencyKey: randomUUID() });
      const proposal = await this.client.createProposal(branch, this.main, `Insight (${author.role}): ${clean.slice(0, 60)}`, `Shared by ${author.name}. Waiting for a peer of the role ${author.role}.`);
      this.pending.set(code, { insight, branch, proposalId: proposal.id, sharedAt: clock, approved: 0, approvers: [] });
      this.events.changed(insight, 'proposed');
      return insight;
    } catch (err) {
      await this.client.deleteBranch(branch).catch(() => undefined);
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** A peer accepts or rejects a pending insight. Returns an error code or undefined. */
  async judge(code: string, reviewer: { name: string; role: string }, verdict: 'approve' | 'reject', reason: string): Promise<string | undefined> {
    const p = this.pending.get(code);
    if (!p) return 'unknown';
    const check = reviewer.name === 'auto' ? 'ok' : peerCheck(p.insight, reviewer);
    if (check !== 'ok') return check;
    const note = `Peer review by ${reviewer.name} (${reviewer.role}): ${verdict}${reason ? ` - ${reason}` : ''}`;
    if (verdict === 'approve' && reviewer.name !== 'auto') {
      if (p.approvers.includes(reviewer.name)) return 'already';
      const w = this.events.approvalWeight ? this.events.approvalWeight(reviewer) : 1;
      if (p.approved + w < 1) {
        // Not enough weight yet: the approval is noted and the insight keeps waiting for others.
        p.approved += w;
        p.approvers.push(reviewer.name);
        await this.client.review(p.proposalId, 'comment', `${note} (weight ${Math.round(w * 100) / 100})`).catch(() => undefined);
        return undefined;
      }
    }
    this.pending.delete(code);
    try {
      if (verdict === 'approve') {
        await this.client.execute(this.cfg.updateOperation, { key: code, status: 'accepted', reviewer: reviewer.name }, { branch: p.branch, message: note });
        await this.client.review(p.proposalId, 'approve', note);
        await this.client.merge(p.proposalId, note);
        p.insight.status = 'accepted';
      } else {
        await this.client.review(p.proposalId, 'request_changes', note);
        await this.client.closeProposal(p.proposalId);
        p.insight.status = 'rejected';
      }
      p.insight.reviewer = reviewer.name;
      await this.client.deleteBranch(p.branch).catch(() => undefined);
      this.events.changed(p.insight, verdict === 'approve' ? 'accepted' : 'rejected', reviewer.name);
      return undefined;
    } catch (err) {
      this.pending.set(code, p);
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * After a restart: open insight Proposals (`role/` branches) come back into the review queue, or
   * are closed when older than `reconcile.maxAgeHours` (or always, with mode `close`); `role/`
   * branches without an open Proposal are deleted. Returns what was done.
   */
  async reconcile(clock: number, now = Date.now()): Promise<{ reloaded: number; closed: number; branchesDeleted: number }> {
    const out = { reloaded: 0, closed: 0, branchesDeleted: 0 };
    if (!this.cfg.enabled) return out;
    const prefix = this.cfg.branchPrefix;
    const open = (await this.client.listProposals('open')).filter((p) => p.source_ref.startsWith(prefix) && p.target_ref === this.main);
    const maxAge = this.cfg.reconcile.maxAgeHours * 3600_000;
    for (const pr of open) {
      const records = await this.client.listRecords(this.cfg.kind, pr.source_ref).catch(() => ({ items: [] as RecordItem[] }));
      const insight = records.items.map(insightFromRecord).find((i) => i.status === 'proposed');
      const stale = this.cfg.reconcile.mode === 'close' || now - Date.parse(pr.created_at) > maxAge || !insight;
      if (stale || !insight) {
        await this.client.closeProposal(pr.id).catch(() => undefined);
        await this.client.deleteBranch(pr.source_ref).catch(() => undefined);
        out.closed++;
        continue;
      }
      if (this.pending.has(insight.code)) continue;
      this.pending.set(insight.code, { insight, branch: pr.source_ref, proposalId: pr.id, sharedAt: clock, approved: 0, approvers: [] });
      out.reloaded++;
    }
    const kept = new Set([...this.pending.values()].map((p) => p.branch));
    for (const b of await this.client.listBranches()) {
      if (!b.name.startsWith(prefix) || kept.has(b.name)) continue;
      await this.client.deleteBranch(b.name).then(() => out.branchesDeleted++, () => undefined);
    }
    return out;
  }

  /** Accepts insights of roles without any other living member, once they waited long enough. */
  async autoAccept(clock: number, livingOfRole: (role: string) => number): Promise<void> {
    for (const p of [...this.pending.values()]) {
      if (clock - p.sharedAt < this.cfg.autoAcceptMinutes) continue;
      if (livingOfRole(p.insight.role) > 1) continue;
      await this.judge(p.insight.code, { name: 'auto', role: p.insight.role }, 'approve', 'no peer of this role is alive');
    }
  }
}
