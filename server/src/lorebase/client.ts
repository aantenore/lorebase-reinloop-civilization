// Minimal Keeper REST client (only the endpoints this project uses; see Lorebase docs/openapi.json).
import { randomUUID } from 'node:crypto';

export class LorebaseError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;
  constructor(status: number, body: unknown, what: string) {
    const p = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    super(`${what}: ${status} ${String(p.code ?? p.title ?? '')} ${String(p.detail ?? '')}`.trim());
    this.status = status;
    this.code = typeof p.code === 'string' ? p.code : undefined;
    this.body = body;
  }
}

export interface RecordItem {
  kind: string;
  key: string;
  values: Record<string, unknown>;
  updated_revision?: string;
}

export interface RevisionEvent {
  sequence?: number | null;
  type: string;
  branch: string;
  revision: string;
  message: string;
  author: string;
  created_at: string;
  kinds: Record<string, number>;
  keys: Record<string, string[]>;
  schema_changed: boolean;
}

export interface ChangesPage {
  branch: string;
  head: string;
  items: RevisionEvent[];
  next_since: string;
  more: boolean;
}

export interface ProposalInfo {
  id: string;
  title: string;
  description?: string | null;
  source_ref: string;
  target_ref: string;
  status: 'open' | 'merged' | 'closed';
  created_at: string;
  merged_revision?: string | null;
}

export interface ExecuteOptions {
  branch: string;
  message?: string;
  idempotencyKey?: string;
}

export class LorebaseClient {
  readonly url: string;
  readonly domain: string;

  constructor(url: string, domain: string) {
    this.url = url.replace(/\/+$/, '');
    this.domain = domain;
  }

  private get base(): string {
    return `${this.url}/api/v1/domains/${encodeURIComponent(this.domain)}`;
  }

  async request<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const init: RequestInit = { method, headers: { Accept: 'application/json', ...headers } };
    if (body !== undefined) {
      if (typeof body === 'string') init.body = body;
      else {
        init.body = JSON.stringify(body);
        (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      }
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) throw new LorebaseError(res.status, json, `${method} ${url.replace(this.url, '')}`);
    return json as T;
  }

  ready(): Promise<unknown> {
    return this.request('GET', `${this.url}/readyz`);
  }

  getDomain(): Promise<{ id: string; head: string | null }> {
    return this.request('GET', this.base);
  }

  createDomain(displayName: string, description: string): Promise<unknown> {
    return this.request('POST', `${this.url}/api/v1/domains`, { id: this.domain, display_name: displayName, description }, { 'Idempotency-Key': randomUUID() });
  }

  getBranch(name: string): Promise<{ name: string; head: string; protected: boolean }> {
    return this.request('GET', `${this.base}/branches/${encodeURIComponent(name)}`);
  }

  createBranch(name: string, source: string): Promise<{ name: string; head: string }> {
    return this.request('POST', `${this.base}/branches`, { name, source }, { 'Idempotency-Key': randomUUID() });
  }

  deleteBranch(name: string): Promise<unknown> {
    return this.request('DELETE', `${this.base}/branches/${encodeURIComponent(name)}`);
  }

  applySchema(branch: string, yaml: string, message: string): Promise<{ status: string; revision: string | null; change_count: number }> {
    const q = new URLSearchParams({ message });
    return this.request('POST', `${this.base}/branches/${encodeURIComponent(branch)}/schema/changes?${q}`, yaml, { 'Content-Type': 'text/yaml' });
  }

  execute(operation: string, parameters: Record<string, unknown>, opts: ExecuteOptions): Promise<{ status: string; revision: string | null; head: string; edit_count: number }> {
    return this.request(
      'POST',
      `${this.base}/operations/${encodeURIComponent(operation)}/execute`,
      { parameters, branch: opts.branch, message: opts.message },
      { 'Idempotency-Key': opts.idempotencyKey ?? randomUUID() },
    );
  }

  /** Every Record of a Kind on a branch (follows cursors). */
  async listRecords(kind: string, branch: string): Promise<{ revision: string; items: RecordItem[] }> {
    const items: RecordItem[] = [];
    let cursor: string | undefined;
    let revision = '';
    do {
      const q = new URLSearchParams({ branch, limit: '200' });
      if (cursor) q.set('cursor', cursor);
      const page = await this.request<{ revision: string; items: RecordItem[]; next_cursor?: string | null }>(
        'GET', `${this.base}/kinds/${encodeURIComponent(kind)}/records?${q}`,
      );
      revision ||= page.revision;
      items.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return { revision, items };
  }

  createProposal(source: string, target: string, title: string, description?: string): Promise<{ id: string; status: string }> {
    return this.request('POST', `${this.base}/proposals`, { source_ref: source, target_ref: target, title, description }, { 'Idempotency-Key': randomUUID() });
  }

  review(proposalId: string, verdict: 'approve' | 'request_changes' | 'comment', comment?: string): Promise<{ approval: { satisfied: boolean } }> {
    return this.request('POST', `${this.base}/proposals/${encodeURIComponent(proposalId)}/reviews`, { verdict, comment });
  }

  merge(proposalId: string, message?: string): Promise<{ status?: string; result: string; revision: string }> {
    return this.request('POST', `${this.base}/proposals/${encodeURIComponent(proposalId)}/merge`, { message }, { 'Idempotency-Key': randomUUID() });
  }

  getProposal(proposalId: string): Promise<ProposalInfo> {
    return this.request('GET', `${this.base}/proposals/${encodeURIComponent(proposalId)}`);
  }

  closeProposal(proposalId: string): Promise<unknown> {
    return this.request('POST', `${this.base}/proposals/${encodeURIComponent(proposalId)}/close`, {});
  }

  /** Every Proposal with this status (follows cursors). */
  async listProposals(status: 'open' | 'merged' | 'closed'): Promise<ProposalInfo[]> {
    const out: ProposalInfo[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ status, limit: '100' });
      if (cursor) q.set('cursor', cursor);
      const page = await this.request<{ items: ProposalInfo[]; next_cursor?: string | null }>('GET', `${this.base}/proposals?${q}`);
      out.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return out;
  }

  /** Every branch of the Domain (follows cursors). */
  async listBranches(): Promise<Array<{ name: string; head: string; protected: boolean; created_at?: string }>> {
    const out: Array<{ name: string; head: string; protected: boolean; created_at?: string }> = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ limit: '200' });
      if (cursor) q.set('cursor', cursor);
      const page = await this.request<{ items: typeof out; next_cursor?: string | null }>('GET', `${this.base}/branches?${q}`);
      out.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return out;
  }

  changes(branch: string, since: string, kinds: string[]): Promise<ChangesPage> {
    const q = new URLSearchParams({ since, kinds: kinds.join(',') });
    return this.request('GET', `${this.base}/branches/${encodeURIComponent(branch)}/changes?${q}`);
  }

  eventsUrl(branch: string, kinds: string[]): string {
    return `${this.base}/branches/${encodeURIComponent(branch)}/events?${new URLSearchParams({ kinds: kinds.join(',') })}`;
  }
}
