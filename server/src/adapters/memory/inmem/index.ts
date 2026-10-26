// Private memory kept in this process (tests, offline runs): nothing survives a restart.
// Recall scores the words a memory shares with the query, weighted by importance, emotion and
// fidelity; fidelity fades with real time (`fadePerHour`) and a memory below `forgetBelow` is
// forgotten. The change feed reports added, recalled, blurred and forgotten memories.
import type { Sink } from 'reinloop';
import type {
  ConversationLine, ConversationRow, GameTime, Memory, MemoryEvent, MemoryInfo, MemoryItem, MemoryStats,
} from '../../../ports/memory.ts';
import type { SocietySnapshot } from '../../../rt/society.ts';

export interface InMemConfig {
  /** Fading period (real ms). */
  pollMs: number;
  /** Fidelity lost per real hour (0: never fades). */
  fadePerHour: number;
  forgetBelow: number;
  maxPerOwner: number;
  maxConversations: number;
}

export interface InMemSettings {
  enabled: boolean;
  recallLimit: number;
  textMaxChars: number;
  inmem: InMemConfig;
}

const words = (s: string) => new Set(s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** Relevance of a memory to a query: shared words, weighted by importance, emotion and fidelity. Pure. */
export function score(m: Pick<MemoryItem, 'text' | 'importance' | 'emotion' | 'fidelity'>, query: string): number {
  const q = words(query);
  const t = words(m.text);
  let shared = 0;
  for (const w of q) if (t.has(w)) shared++;
  const relevance = q.size ? shared / q.size : 0;
  return relevance * (0.5 + m.importance / 2) * (0.75 + Math.abs(m.emotion) / 4) * m.fidelity;
}

export class InMemoryMemory implements Memory {
  readonly info: MemoryInfo = { adapter: 'inmem', location: 'memory://' };
  readonly connected = true;
  private readonly cfg: InMemSettings;
  private readonly minds = new Map<string, MemoryItem[]>();
  private readonly lines: ConversationRow[] = [];
  private readonly societies = new Map<string, SocietySnapshot>();
  private readonly listeners = new Set<(ev: MemoryEvent) => void>();
  private timer: NodeJS.Timeout | undefined;
  private lastFade = Date.now();
  private seq = 0;
  private ids = 0;
  private lineSeq = 0;

  constructor(settings: InMemSettings) {
    this.cfg = settings;
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  private emit(agentId: string, action: MemoryEvent['action'], memory: MemoryItem): void {
    const ev = { seq: ++this.seq, agentId, action, memory: { ...memory } };
    for (const fn of this.listeners) fn(ev);
  }

  async remember(owner: string, text: string, opts: { importance: number; emotion: number; at: GameTime; source?: string }): Promise<MemoryItem | undefined> {
    if (!this.enabled) return undefined;
    const m: MemoryItem = {
      id: `m${++this.ids}`, text: text.slice(0, this.cfg.textMaxChars), fidelity: 1,
      importance: Math.max(0, Math.min(1, opts.importance)), emotion: Math.max(-1, Math.min(1, opts.emotion)),
      kind: 'episodic', createdAt: { day: opts.at.day, minute: opts.at.minute }, recalls: 0,
    };
    const list = this.minds.get(owner) ?? [];
    // Over capacity: the least important earlier memory goes first.
    while (list.length && list.length >= this.cfg.inmem.maxPerOwner) {
      const weakest = list.reduce((a, b) => (a.importance * a.fidelity <= b.importance * b.fidelity ? a : b));
      list.splice(list.indexOf(weakest), 1);
      this.emit(owner, 'forgotten', weakest);
    }
    list.push(m);
    this.minds.set(owner, list);
    this.emit(owner, 'added', m);
    return { ...m };
  }

  async recall(owner: string, query: string, limit = this.cfg.recallLimit): Promise<Array<MemoryItem & { score: number }> | undefined> {
    if (!this.enabled) return undefined;
    const hits = (this.minds.get(owner) ?? [])
      .map((m) => ({ m, s: score(m, query) }))
      .filter((h) => h.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit);
    for (const h of hits) {
      h.m.recalls++;
      this.emit(owner, 'recalled', h.m);
    }
    return hits.map((h) => ({ ...h.m, score: Math.round(h.s * 1000) / 1000 }));
  }

  async list(owner: string): Promise<MemoryItem[]> {
    return (this.minds.get(owner) ?? []).map((m) => ({ ...m }));
  }

  async deleteOwner(owner: string, opts: { speaker?: string; runAgent?: string } = {}): Promise<{ memories: number; conversations: number; runs: number } | undefined> {
    if (!this.enabled) return undefined;
    const memories = this.minds.get(owner)?.length ?? 0;
    this.minds.delete(owner);
    let conversations = 0;
    if (opts.speaker) {
      for (let i = this.lines.length - 1; i >= 0; i--) {
        if (this.lines[i]!.from === opts.speaker) {
          this.lines.splice(i, 1);
          conversations++;
        }
      }
    }
    return { memories, conversations, runs: 0 };
  }

  async stats(): Promise<MemoryStats> {
    let memories = 0;
    for (const l of this.minds.values()) memories += l.length;
    return { memories, dbBytes: null, lastCompaction: null, embedder: null };
  }

  watch(onEvent: (ev: MemoryEvent) => void): void {
    this.listeners.add(onEvent);
    if (this.timer || !this.enabled) return;
    this.lastFade = Date.now();
    this.timer = setInterval(() => this.fade(), this.cfg.inmem.pollMs);
    this.timer.unref();
  }

  /** Fidelity fades with time; faint memories are forgotten. */
  fade(now = Date.now()): void {
    const loss = (this.cfg.inmem.fadePerHour * (now - this.lastFade)) / 3_600_000;
    this.lastFade = now;
    if (loss <= 0) return;
    for (const [owner, list] of this.minds) {
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i]!;
        const before = m.fidelity;
        // Important and emotional memories fade slower.
        m.fidelity = Math.max(0, m.fidelity - loss * (1 - m.importance / 2) * (1 - Math.abs(m.emotion) / 2));
        if (m.fidelity < this.cfg.inmem.forgetBelow) {
          list.splice(i, 1);
          this.emit(owner, 'forgotten', m);
        } else if (before >= 0.5 && m.fidelity < 0.5) this.emit(owner, 'blurred', m);
      }
    }
  }

  converse(line: ConversationLine): void {
    if (!this.enabled) return;
    this.lines.push({ ...line, text: line.text.slice(0, this.cfg.textMaxChars), id: String(++this.lineSeq) });
    if (this.lines.length > this.cfg.inmem.maxConversations) this.lines.splice(0, this.lines.length - this.cfg.inmem.maxConversations);
  }

  async conversations(q: Record<string, string>): Promise<ConversationRow[]> {
    const limit = Math.max(1, Math.floor(Number(q.limit)) || 100);
    const since = Number(q.since);
    const rows = this.lines.filter((l) =>
      (!Number.isFinite(since) || !q.since || Number(l.id) > since)
      && (!q.agent || l.from === q.agent || l.to === q.agent)
      && (!q.with || l.from === q.with || l.to === q.with)
      && (!q.group || l.groupId === q.group));
    return rows.slice(-limit);
  }

  runSinks(): Sink[] {
    return [];
  }

  async loadSociety(world: string): Promise<SocietySnapshot | undefined> {
    const s = this.societies.get(world);
    return s && structuredClone(s);
  }

  async saveSociety(world: string, s: SocietySnapshot, maxOpinions: number): Promise<boolean> {
    if (!this.enabled) return false;
    const prev = this.societies.get(world);
    const opinions = [...(prev?.opinions ?? []), ...s.opinions].slice(-maxOpinions);
    this.societies.set(world, structuredClone({ ...s, opinions }));
    return true;
  }

  async forgetPerson(world: string, name: string): Promise<void> {
    const s = this.societies.get(world);
    if (!s) return;
    s.people = s.people.filter((p) => p.name !== name);
    s.opinions = s.opinions.filter((o) => o.from !== name && o.to !== name);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
