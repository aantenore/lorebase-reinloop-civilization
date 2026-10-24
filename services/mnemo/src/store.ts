// SQLite persistence (node:sqlite, WAL): memories with a manually synced FTS5 index, the event
// log, run events, retention and the global size cap. Brute-force cosine over one agent's rows
// is fine at the sizes the per-agent cap allows.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MnemoConfig } from './config.ts';
import { fidelityAt } from './fading.ts';
import { cosine } from './score.ts';

export interface MemRow {
  id: string;
  ns: string;
  agent: string;
  text: string;
  kind: 'episodic' | 'gist';
  importance: number;
  emotion: number;
  recalls: number;
  created_day: number;
  created_minute: number;
  created_ms: number;
  anchor_ms: number;
  anchor_fidelity: number;
  stability_ms: number;
  blur_level: number;
  pending_blur: number;
  source: string | null;
  meta: string | null;
  embedding: Float32Array;
  embedder: string;
}

export interface Candidate {
  row: MemRow;
  cosine: number;
  /** Raw FTS5 bm25 (negative, lower is better); undefined when FTS did not match. */
  bm25: number | undefined;
}

export interface StoredEvent {
  seq: number;
  at_ms: number;
  agent: string;
  action: string;
  memory: unknown;
}

const COLS = [
  'id', 'ns', 'agent', 'text', 'kind', 'importance', 'emotion', 'recalls', 'created_day', 'created_minute', 'created_ms',
  'anchor_ms', 'anchor_fidelity', 'stability_ms', 'blur_level', 'pending_blur', 'source', 'meta', 'embedding', 'embedder',
] as const;
const PATCHABLE = new Set<string>(COLS.filter((c) => c !== 'id'));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  rid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  ns TEXT NOT NULL, agent TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL,
  importance REAL NOT NULL, emotion REAL NOT NULL, recalls INTEGER NOT NULL,
  created_day INTEGER NOT NULL, created_minute INTEGER NOT NULL, created_ms INTEGER NOT NULL,
  anchor_ms INTEGER NOT NULL, anchor_fidelity REAL NOT NULL, stability_ms REAL NOT NULL,
  blur_level INTEGER NOT NULL, pending_blur INTEGER NOT NULL,
  source TEXT, meta TEXT, embedding BLOB NOT NULL, embedder TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_agent ON memories(ns, agent);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, agent TEXT NOT NULL, action TEXT NOT NULL, memory TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, at_ms INTEGER NOT NULL, event TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, seq);
CREATE TABLE IF NOT EXISTS conversations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, day INTEGER NOT NULL, minute INTEGER NOT NULL,
  speaker TEXT NOT NULL, listener TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL, group_id TEXT
);
CREATE INDEX IF NOT EXISTS conversations_speaker ON conversations(speaker, seq);
CREATE INDEX IF NOT EXISTS conversations_listener ON conversations(listener, seq);
CREATE INDEX IF NOT EXISTS conversations_group ON conversations(group_id, seq);
CREATE TABLE IF NOT EXISTS society_worlds (
  world TEXT PRIMARY KEY, clock REAL NOT NULL, updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS society_people (
  world TEXT NOT NULL, name TEXT NOT NULL, prior REAL NOT NULL, esteem REAL NOT NULL,
  fame REAL NOT NULL, fame_at REAL NOT NULL, skills TEXT NOT NULL, PRIMARY KEY (world, name)
);
CREATE TABLE IF NOT EXISTS society_opinions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, world TEXT NOT NULL, judge TEXT NOT NULL, target TEXT NOT NULL,
  score REAL NOT NULL, reason TEXT NOT NULL, at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS society_opinions_world ON society_opinions(world, seq);
`;

/** Society of one world kept across restarts (names, game clock). */
export interface SocietyState {
  clock: number;
  people: Array<{ name: string; prior: number; esteem: number; fame: number; fameAt: number; skills: Record<string, number> }>;
  opinions: Array<{ from: string; to: string; score: number; reason: string; at: number }>;
  /** Families with their members' names (replaced at every save). */
  families?: SavedFamily[];
}

export interface SavedFamily {
  id: string;
  name: string;
  founder: string;
  members: string[];
  foundedDay: number;
  color?: string;
}

/** One line of speech, thought or group deliberation (`from`/`to` are names; `to` may be 'all'). */
export interface ConversationLine {
  from: string;
  to: string;
  text: string;
  kind: 'speech' | 'thought' | 'deliberation';
  at: { day: number; minute: number };
  groupId?: string;
}

type Raw = Record<string, unknown>;

function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

function fromRaw(r: Raw): MemRow {
  const blob = r.embedding as Uint8Array;
  const row = { ...r } as unknown as MemRow;
  row.embedding = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
  delete (row as unknown as Raw).rid;
  return row;
}

/** Turns free text into an FTS5 OR query of quoted tokens (never a syntax error). */
export function ftsQuery(q: string): string {
  const toks = q.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(toks.map((t) => t.toLowerCase()))].map((t) => `"${t}"`).join(' OR ');
}

export class Store {
  readonly db: DatabaseSync;
  private readonly cfg: MnemoConfig;
  private runInserts = 0;

  constructor(cfg: MnemoConfig) {
    this.cfg = cfg;
    if (cfg.db.path !== ':memory:') mkdirSync(dirname(cfg.db.path), { recursive: true });
    this.db = new DatabaseSync(cfg.db.path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    // Added after the first release: databases created before keep working.
    const cols = (this.db.prepare('PRAGMA table_info(society_worlds)').all() as Raw[]).map((c) => c.name);
    if (!cols.includes('families')) this.db.exec("ALTER TABLE society_worlds ADD COLUMN families TEXT NOT NULL DEFAULT '[]'");
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // --- memories ---------------------------------------------------------------------------

  add(row: MemRow): void {
    this.tx(() => {
      const res = this.db
        .prepare(`INSERT INTO memories (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`)
        .run(...COLS.map((c) => (c === 'embedding' ? toBlob(row.embedding) : (row[c] as never))));
      this.db.prepare('INSERT INTO memories_fts (rowid, text) VALUES (?, ?)').run(res.lastInsertRowid, row.text);
    });
  }

  get(id: string): MemRow | undefined {
    const r = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Raw | undefined;
    return r ? fromRaw(r) : undefined;
  }

  /** All rows of an agent in a namespace, newest first. */
  listByAgent(agent: string, ns: string): MemRow[] {
    return (this.db.prepare('SELECT * FROM memories WHERE ns = ? AND agent = ? ORDER BY created_ms DESC, rid DESC').all(ns, agent) as Raw[]).map(fromRaw);
  }

  listAgents(ns: string): string[] {
    return (this.db.prepare('SELECT DISTINCT agent FROM memories WHERE ns = ? ORDER BY agent').all(ns) as Raw[]).map((r) => r.agent as string);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
  }

  /** Top-N by cosine over the scope plus the top-N FTS matches. `agent` undefined = whole namespace. */
  candidates(ns: string, agent: string | undefined, query: string, qvec: Float32Array, n: number): Candidate[] {
    const rows = (agent === undefined
      ? this.db.prepare('SELECT * FROM memories WHERE ns = ?').all(ns)
      : this.db.prepare('SELECT * FROM memories WHERE ns = ? AND agent = ?').all(ns, agent)) as Raw[];
    const byId = new Map<string, Candidate>();
    const scored = rows.map((r) => {
      const row = fromRaw(r);
      return { row, cosine: cosine(qvec, row.embedding), bm25: undefined as number | undefined };
    });
    scored.sort((a, b) => b.cosine - a.cosine);
    for (const c of scored.slice(0, n)) byId.set(c.row.id, c);
    const fts = ftsQuery(query);
    if (fts) {
      const sql = `SELECT m.*, bm25(memories_fts) AS b FROM memories_fts JOIN memories m ON m.rid = memories_fts.rowid
        WHERE memories_fts MATCH ? AND m.ns = ?${agent === undefined ? '' : ' AND m.agent = ?'} ORDER BY b LIMIT ?`;
      const args = agent === undefined ? [fts, ns, n] : [fts, ns, agent, n];
      for (const r of this.db.prepare(sql).all(...(args as never[])) as Raw[]) {
        const b = r.b as number;
        delete r.b;
        const row = fromRaw(r);
        const hit = byId.get(row.id);
        if (hit) hit.bm25 = b;
        else byId.set(row.id, { row, cosine: cosine(qvec, row.embedding), bm25: b });
      }
    }
    return [...byId.values()];
  }

  update(id: string, patch: Partial<Omit<MemRow, 'id'>>): void {
    const keys = Object.keys(patch).filter((k) => PATCHABLE.has(k));
    if (keys.length === 0) return;
    this.tx(() => {
      const vals = keys.map((k) => (k === 'embedding' ? toBlob(patch.embedding!) : ((patch as Raw)[k] as never)));
      this.db.prepare(`UPDATE memories SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
      if (patch.text !== undefined) {
        const r = this.db.prepare('SELECT rid FROM memories WHERE id = ?').get(id) as { rid: number } | undefined;
        if (r) this.db.prepare('UPDATE memories_fts SET text = ? WHERE rowid = ?').run(patch.text, r.rid);
      }
    });
  }

  delete(ids: string[]): void {
    if (ids.length === 0) return;
    this.tx(() => {
      for (const id of ids) {
        const r = this.db.prepare('SELECT rid FROM memories WHERE id = ?').get(id) as { rid: number } | undefined;
        if (!r) continue;
        this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(r.rid);
        this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      }
    });
  }

  /**
   * Forgets everything owned by one agent: its memories (rows, full-text index, embeddings), its
   * memory events, the conversation lines it spoke (`speaker`) and the runs it ran (`runAgent`,
   * the agent name in the run_start event). `vacuum` gives the freed pages back to the disk.
   */
  forgetAgent(agent: string, opts: { speaker?: string; runAgent?: string; vacuum?: boolean } = {}): { memories: number; conversations: number; runs: number } {
    const out = this.tx(() => {
      const rids = (this.db.prepare('SELECT rid FROM memories WHERE agent = ?').all(agent) as Array<{ rid: number }>).map((r) => r.rid);
      const delFts = this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?');
      for (const rid of rids) delFts.run(rid);
      this.db.prepare('DELETE FROM memories WHERE agent = ?').run(agent);
      this.db.prepare('DELETE FROM events WHERE agent = ?').run(agent);
      const conversations = opts.speaker ? Number(this.db.prepare('DELETE FROM conversations WHERE speaker = ?').run(opts.speaker).changes) : 0;
      let runs = 0;
      if (opts.runAgent) {
        const starts = this.db.prepare("SELECT DISTINCT run_id, event FROM run_events WHERE event LIKE '%run_start%'").all() as Raw[];
        const mine = starts.filter((r) => {
          try {
            const ev = JSON.parse(r.event as string) as { type?: string; data?: { agent?: string } };
            return ev.type === 'run_start' && ev.data?.agent === opts.runAgent;
          } catch {
            return false;
          }
        }).map((r) => r.run_id as string);
        this.deleteRuns([...new Set(mine)]);
        runs = new Set(mine).size;
      }
      return { memories: rids.length, conversations, runs };
    });
    if (opts.vacuum) this.db.exec('VACUUM');
    return out;
  }

  /** Rows whose embedding was produced by another embedder. */
  stale(embedderName: string, limit: number): MemRow[] {
    return (this.db.prepare('SELECT * FROM memories WHERE embedder != ? LIMIT ?').all(embedderName, limit) as Raw[]).map(fromRaw);
  }

  // --- events -----------------------------------------------------------------------------

  appendEvent(atMs: number, agent: string, action: string, memory: unknown): number {
    const res = this.db.prepare('INSERT INTO events (at_ms, agent, action, memory) VALUES (?, ?, ?, ?)').run(atMs, agent, action, JSON.stringify(memory));
    return Number(res.lastInsertRowid);
  }

  eventsSince(since: number, limit: number): StoredEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(since, limit) as Raw[];
    return rows.map((r) => ({ seq: r.seq as number, at_ms: r.at_ms as number, agent: r.agent as string, action: r.action as string, memory: JSON.parse(r.memory as string) }));
  }

  lastEventSeq(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events').get() as { s: number }).s;
  }

  trimEvents(maxKept: number): void {
    this.db.prepare('DELETE FROM events WHERE seq <= ?').run(this.lastEventSeq() - maxKept);
  }

  // --- runs -------------------------------------------------------------------------------

  appendRunEvents(events: Array<{ runId: string } & Record<string, unknown>>, nowMs: number): void {
    this.tx(() => {
      const next = new Map<string, number>();
      for (const e of events) {
        let seq = next.get(e.runId);
        if (seq === undefined) seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM run_events WHERE run_id = ?').get(e.runId) as { s: number }).s;
        seq++;
        next.set(e.runId, seq);
        this.db.prepare('INSERT INTO run_events (run_id, seq, at_ms, event) VALUES (?, ?, ?, ?)').run(e.runId, seq, nowMs, JSON.stringify(e));
      }
    });
    this.runInserts += events.length;
    if (this.runInserts >= this.cfg.runs.pruneEveryInserts) {
      this.runInserts = 0;
      this.pruneRuns(nowMs);
    }
  }

  loadRun(runId: string): unknown[] {
    return (this.db.prepare('SELECT event FROM run_events WHERE run_id = ? ORDER BY seq').all(runId) as Raw[]).map((r) => JSON.parse(r.event as string));
  }

  /** Run ids, oldest first. */
  listRuns(): string[] {
    return (this.db.prepare('SELECT run_id FROM run_events GROUP BY run_id ORDER BY MIN(at_ms), MIN(rowid)').all() as Raw[]).map((r) => r.run_id as string);
  }

  pruneRuns(nowMs: number): void {
    const cutoff = nowMs - this.cfg.runs.maxAgeHours * 3600e3;
    this.db.prepare('DELETE FROM run_events WHERE run_id IN (SELECT run_id FROM run_events GROUP BY run_id HAVING MAX(at_ms) < ?)').run(cutoff);
    const ids = this.listRuns();
    if (ids.length > this.cfg.runs.maxRuns) this.deleteRuns(ids.slice(0, ids.length - this.cfg.runs.maxRuns));
  }

  private deleteRuns(ids: string[]): void {
    const del = this.db.prepare('DELETE FROM run_events WHERE run_id = ?');
    for (const id of ids) del.run(id);
  }

  // --- size -------------------------------------------------------------------------------

  // --- society (opinions, esteem, fame, skills per world) ---------------------------------

  societyLoad(world: string): SocietyState | undefined {
    const meta = this.db.prepare('SELECT clock, families FROM society_worlds WHERE world = ?').get(world) as { clock: number; families: string } | undefined;
    if (!meta) return undefined;
    const people = (this.db.prepare('SELECT * FROM society_people WHERE world = ? ORDER BY name').all(world) as Raw[]).map((r) => ({
      name: String(r.name), prior: Number(r.prior), esteem: Number(r.esteem), fame: Number(r.fame), fameAt: Number(r.fame_at), skills: JSON.parse(String(r.skills)) as Record<string, number>,
    }));
    const opinions = (this.db.prepare('SELECT * FROM society_opinions WHERE world = ? ORDER BY seq').all(world) as Raw[]).map((r) => ({
      from: String(r.judge), to: String(r.target), score: Number(r.score), reason: String(r.reason), at: Number(r.at),
    }));
    return { clock: Number(meta.clock), people, opinions, families: JSON.parse(meta.families) as SavedFamily[] };
  }

  /** Upserts people, appends new opinions (keeping the latest `maxOpinions` of the world), records the clock. */
  societySave(world: string, s: SocietyState, maxOpinions: number, nowMs: number): void {
    this.tx(() => {
      this.db.prepare('INSERT INTO society_worlds (world, clock, updated_ms, families) VALUES (?, ?, ?, ?) ON CONFLICT(world) DO UPDATE SET clock = excluded.clock, updated_ms = excluded.updated_ms, families = excluded.families')
        .run(world, s.clock, nowMs, JSON.stringify(s.families ?? []));
      const person = this.db.prepare(`INSERT INTO society_people (world, name, prior, esteem, fame, fame_at, skills) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(world, name) DO UPDATE SET prior = excluded.prior, esteem = excluded.esteem, fame = excluded.fame, fame_at = excluded.fame_at, skills = excluded.skills`);
      for (const p of s.people) person.run(world, p.name, p.prior, p.esteem, p.fame, p.fameAt, JSON.stringify(p.skills ?? {}));
      const op = this.db.prepare('INSERT INTO society_opinions (world, judge, target, score, reason, at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const o of s.opinions) op.run(world, o.from, o.to, o.score, o.reason, o.at);
      this.db.prepare('DELETE FROM society_opinions WHERE world = ? AND seq NOT IN (SELECT seq FROM society_opinions WHERE world = ? ORDER BY seq DESC LIMIT ?)').run(world, world, Math.max(0, maxOpinions));
    });
  }

  /** A person died: its standing and the opinions it held go; opinions others hold about it stay. */
  societyForget(world: string, name: string): { people: number; opinions: number } {
    return this.tx(() => ({
      people: Number(this.db.prepare('DELETE FROM society_people WHERE world = ? AND name = ?').run(world, name).changes),
      opinions: Number(this.db.prepare('DELETE FROM society_opinions WHERE world = ? AND judge = ?').run(world, name).changes),
    }));
  }

  /** Used bytes (free pages excluded, so deletions count immediately). */
  /** Appends conversation lines; keeps at most `maxKept` (oldest dropped). */
  appendConversations(lines: ConversationLine[], nowMs: number, maxKept: number): void {
    const ins = this.db.prepare('INSERT INTO conversations (at_ms, day, minute, speaker, listener, text, kind, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const l of lines) ins.run(nowMs, Math.floor(l.at.day), Math.floor(l.at.minute), l.from, l.to, l.text, l.kind, l.groupId ?? null);
    this.db.prepare('DELETE FROM conversations WHERE seq <= (SELECT MAX(seq) FROM conversations) - ?').run(maxKept);
  }

  /** Conversation lines, newest last; filters combine (agent: spoke or heard; with: the other side). */
  conversations(f: { agent?: string; with?: string; group?: string; since?: number; limit: number }): Array<Record<string, unknown>> {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (f.agent) {
      where.push('(speaker = ? OR listener = ?)');
      args.push(f.agent, f.agent);
    }
    if (f.with) {
      where.push('(speaker = ? OR listener = ?)');
      args.push(f.with, f.with);
    }
    if (f.group) {
      where.push('group_id = ?');
      args.push(f.group);
    }
    if (f.since !== undefined) {
      where.push('seq > ?');
      args.push(f.since);
    }
    const sql = `SELECT * FROM (SELECT * FROM conversations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC`;
    const rows = this.db.prepare(sql).all(...args, f.limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.seq), at: { day: r.day, minute: r.minute }, from: r.speaker, to: r.listener, text: r.text, kind: r.kind, ...(r.group_id ? { groupId: r.group_id } : {}),
    }));
  }

  dbBytes(): number {
    const n = (sql: string) => Object.values(this.db.prepare(sql).get() as Raw)[0] as number;
    return (n('PRAGMA page_count') - n('PRAGMA freelist_count')) * n('PRAGMA page_size');
  }

  /** While over maxBytes: drop the lowest-fidelity fading memories and the oldest runs. */
  enforceCap(nowMs: number): number {
    let removed = 0;
    while (this.dbBytes() > this.cfg.db.maxBytes) {
      const ns = this.cfg.namespaces.fading;
      const rows = (this.db.prepare(`SELECT id, anchor_ms, anchor_fidelity, stability_ms FROM memories WHERE ns IN (${ns.map(() => '?').join(',')})`).all(...ns) as unknown as MemRow[])
        .map((r) => ({ id: r.id, f: fidelityAt(r, nowMs) }))
        .sort((a, b) => a.f - b.f)
        .slice(0, this.cfg.db.capBatch);
      const runs = this.listRuns().slice(0, this.cfg.db.capBatch);
      if (rows.length === 0 && runs.length === 0) break;
      this.delete(rows.map((r) => r.id));
      this.deleteRuns(runs);
      removed += rows.length + runs.length;
    }
    return removed;
  }
}
