// Memory: each person's private mind. Memories are remembered with an importance and an
// emotion, recalled by relevance, and fade (fidelity), merge into gists or are forgotten over
// time on the backend's own schedule; the change feed reports it. The same store keeps the
// spoken lines, the decision run logs and the saved society of a world. Only what the game uses.
import type { Sink } from 'reinloop';
import type { SocietySnapshot } from '../rt/society.ts';

export interface GameTime {
  day: number;
  minute: number;
}

export interface MemoryItem {
  id: string;
  text: string;
  /** 1 vivid, towards 0 faded. */
  fidelity: number;
  importance: number;
  emotion: number;
  kind: 'episodic' | 'gist';
  createdAt: GameTime;
  recalls: number;
}

export interface MemoryEvent {
  seq: number;
  agentId: string;
  action: 'added' | 'blurred' | 'merged' | 'forgotten' | 'recalled';
  memory: MemoryItem;
  mergedFrom?: string[];
}

export interface ConversationLine {
  from: string;
  to: string;
  text: string;
  kind: 'speech' | 'thought' | 'deliberation';
  at: GameTime;
  groupId?: string;
}

export interface ConversationRow extends ConversationLine {
  id: string;
}

export interface MemoryStats {
  memories: number;
  dbBytes?: number | null;
  lastCompaction?: unknown;
  embedder?: unknown;
}

export interface MemoryInfo {
  adapter: string;
  location: string;
}

export interface Memory {
  readonly info: MemoryInfo;
  /** False when private memory is switched off: every call is then a no-op. */
  readonly enabled: boolean;
  readonly connected: boolean;

  remember(owner: string, text: string, opts: { importance: number; emotion: number; at: GameTime; source?: string }): Promise<MemoryItem | undefined>;
  /** Most relevant memories first; undefined when the memory is unavailable. */
  recall(owner: string, query: string, limit?: number): Promise<Array<MemoryItem & { score: number }> | undefined>;
  list(owner: string): Promise<MemoryItem[]>;
  /** Deletes everything of one person (it died): memories, the lines it spoke, its run logs. */
  deleteOwner(owner: string, opts?: { speaker?: string; runAgent?: string }): Promise<{ memories: number; conversations: number; runs: number } | undefined>;
  stats(): Promise<MemoryStats>;
  /** Follows fading, merging and forgetting (from now on, not earlier history). */
  watch(onEvent: (ev: MemoryEvent) => void): void;

  /** Spoken lines, thoughts and deliberations (batched). */
  converse(line: ConversationLine): void;
  conversations(q: Record<string, string>): Promise<ConversationRow[]>;
  /** Sinks keeping decision run logs (empty when not kept). */
  runSinks(): Sink[];

  /** The society of a world saved by an earlier run (undefined: none, or unavailable). */
  loadSociety(world: string): Promise<SocietySnapshot | undefined>;
  saveSociety(world: string, s: SocietySnapshot, maxOpinions: number): Promise<boolean>;
  forgetPerson(world: string, name: string): Promise<void>;

  stop(): void;
}

/** The key of a person's memory: its name, so a memory survives world resets. */
export const memoryKey = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
