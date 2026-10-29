// Knowledge: the shared, governed knowledge of the world (laws, roles, chronicle, insights,
// recipes and technologies, families). Records are grouped by kind and keyed; every committed
// change is a revision on the live world. A change can be written directly or prepared on a
// draft and proposed: a proposal is reviewed, then accepted (merged into the live world) or
// rejected. A `scope` names a separate view of the knowledge: a draft, or a hidden catalog the
// people of the world never read. Only what the game uses is here.

export interface KnowledgeRecord {
  kind: string;
  key: string;
  values: Record<string, unknown>;
}

export interface RecordSet {
  /** Revision the records were read at. */
  revision: string;
  items: KnowledgeRecord[];
}

/** Links to other records by relation name (targets are record keys). */
export type Links = Record<string, string | string[]>;

export type Change =
  /** `upsert` writes many records in one revision (create or replace). */
  | { action: 'create' | 'update' | 'upsert'; kind: string; key: string; values: Record<string, unknown>; links?: Links }
  | { action: 'delete'; kind: string; key: string };

/** One committed revision of the live world, as the change feed reports it. */
export interface Revision {
  revision: string;
  message: string;
  author: string;
  at: string;
  /** Records touched per kind. */
  kinds: Record<string, number>;
}

/** One entry of the history of the live world. */
export interface HistoryEntry {
  revision: string;
  message: string;
  time: string;
  author: string;
  origin: string | null;
  changes: number | null;
  kinds: string[];
}

export type ProposalStatus = 'open' | 'accepted' | 'rejected';

export interface Proposal {
  id: string;
  title: string;
  description?: string;
  /** Scope holding the proposed changes. */
  draft: string;
  status: ProposalStatus;
  createdAt: string;
  author?: string;
}

export type Verdict = 'approve' | 'request_changes' | 'comment';

export interface WatchHandlers {
  /** A revision touched one of the watched kinds (undefined: reload everything). */
  onRevision(rev?: Revision): void;
  onStatus(connected: boolean, detail: string): void;
}

export interface Watch {
  readonly connected: boolean;
  stop(): void;
}

/** A read-only consultation the people of the world may make (search, read a record, history...). */
export interface ConsultTool {
  name: ConsultName;
  description?: string;
  schema: Record<string, unknown>;
  call(args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: string; isError: boolean }>;
}

/** Neutral names of the consultations, whatever the backend calls them. */
export const CONSULT_NAMES = [
  'conoscenza_cerca', 'conoscenza_leggi', 'conoscenza_interroga', 'conoscenza_storia',
  'conoscenza_differenze', 'conoscenza_cambiamenti', 'conoscenza_schema', 'conoscenza_quadro',
] as const;
export type ConsultName = (typeof CONSULT_NAMES)[number];
export const CONSULT_SEARCH: ConsultName = 'conoscenza_cerca';

/** The consultations of the live world (never a draft or a hidden scope). */
export interface KnowledgeConsult {
  readonly connected: boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
  tools(): ConsultTool[];
}

export interface KnowledgeInfo {
  /** Adapter name (e.g. `lorebase`, `memory`). */
  adapter: string;
  /** Where it lives (a URL, or `memory://`). */
  location: string;
  /** Name of the knowledge space (e.g. a domain). */
  space: string;
  /** Name of the live world (e.g. a branch). */
  live: string;
}

export class KnowledgeError extends Error {
  /** Retrying the same call will not succeed. */
  readonly permanent: boolean;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;
  constructor(message: string, opts: { permanent?: boolean; retryAfterMs?: number; status?: number } = {}) {
    super(message);
    this.permanent = opts.permanent ?? false;
    this.retryAfterMs = opts.retryAfterMs;
    this.status = opts.status;
  }
}

export interface WriteOptions {
  message: string;
  /** Default: the live world. */
  scope?: string;
}

export interface Knowledge {
  readonly info: KnowledgeInfo;
  readonly consult: KnowledgeConsult;
  /** Resolves when the knowledge answers; throws when unreachable. */
  ready(): Promise<void>;

  // ---- reading -------------------------------------------------------------------
  readAll(kind: string, opts?: { scope?: string }): Promise<RecordSet>;
  read(kind: string, key: string, opts?: { scope?: string }): Promise<KnowledgeRecord | undefined>;
  hasScope(scope: string): Promise<boolean>;
  /** Latest revisions of the live world, newest first. */
  history(limit: number): Promise<HistoryEntry[]>;
  /** Head revision and record counts of the given kinds on the live world. */
  overview(kinds: string[]): Promise<{ revision: string; counts: Record<string, number> }>;
  /** Follows the live world: `since` is the revision the caller already has. */
  watch(opts: { kinds: string[]; since(): string }, handlers: WatchHandlers): Watch;

  // ---- writing -------------------------------------------------------------------
  /** Applies changes directly (one revision per change, upserts batched). Returns the last revision. */
  write(changes: Change[], opts: WriteOptions): Promise<string>;
  /**
   * Opens a proposal from a draft: the draft is created from the live world unless it exists
   * already (prepared with `snapshot` and writes), then the changes are applied there.
   */
  propose(p: { draft: string; title: string; description?: string; message: string; changes: Change[] }): Promise<Proposal>;
  review(id: string, verdict: Verdict, note: string): Promise<void>;
  /** Merges an approved proposal into the live world and discards its draft. Returns the revision. */
  accept(id: string, message: string): Promise<string>;
  /** Closes a proposal (with a request for changes when a note is given) and discards its draft. */
  reject(id: string, note?: string): Promise<void>;
  proposal(id: string): Promise<Proposal | undefined>;
  /** Proposals into the live world with this status. */
  proposals(status: ProposalStatus): Promise<Proposal[]>;
  /** Draft scopes whose name starts with `prefix`. */
  drafts(prefix: string): Promise<string[]>;
  discardDraft(draft: string): Promise<void>;
  /** Deletes many records of one kind (missing ones skipped). Returns how many keys were sent. */
  removeMany(kind: string, keys: string[], opts: WriteOptions): Promise<number>;
  /** Keeps a named copy of the live world (replacing an earlier one with the same name); usable as a draft (a full branch on Lorebase). */
  snapshot(scope: string): Promise<void>;
  /** Keeps a read-only, permanent copy of the live world under `name` (readable by ref; not usable as a draft). */
  archive(name: string): Promise<void>;
  /** Makes sure the space and its schema exist. Returns the number of schema changes. */
  ensureSchema(): Promise<number>;
  close(): Promise<void>;
}
