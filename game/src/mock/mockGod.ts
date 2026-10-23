import type {
  AgentMind,
  ConversationLine,
  DecisionTraceEntry,
  GameTime,
  Group,
  GroupPattern,
  LorebaseLogEntry,
  Memory,
  ObservatorySummary,
  PlanStep,
  ProposalInfo,
  ServerMsg,
  Tier,
} from '../net/protocol';
import { CHATTER } from './mockData';

/** What the ledger needs from the mock world. */
export interface GodHost {
  r: () => number;
  now: () => GameTime;
  agent: (id: string) => { id: string; name: string; tier: Tier; groupId: string | null; steps: PlanStep[]; current: number } | undefined;
  agentIds: () => string[];
  memories: (id: string) => Memory[] | undefined;
  revision: () => { branch: string; revision: string };
  counts: () => Record<string, number>;
}

const MAX_LINES = 600;
const MAX_PER_AGENT = 30;
/** Mock token prices (USD per 1k tokens) and tokens per decision run, per tier. */
const PRICE: Record<string, number> = { opus: 0.03, sonnet: 0.006, haiku: 0.0015, human: 0 };
const TOKENS_PER_RUN: Record<string, [number, number]> = { opus: [2400, 900], sonnet: [1800, 600], haiku: [1100, 300], human: [0, 0] };
const MODEL_OF: Record<string, string> = { opus: 'claude-opus', sonnet: 'claude-sonnet', haiku: 'claude-haiku' };

/** Extra deliberation voices per pattern, used on top of the group's last decision trace. */
const DELIBERATION: Partial<Record<GroupPattern, DecisionTraceEntry['role'][]>> = {
  orchestrator: ['leader', 'proposer', 'proposer'],
  council: ['proposer', 'proposer', 'leader'],
  router: ['router', 'proposer'],
  chain: ['proposer', 'router', 'leader'],
  mentor: ['proposer', 'critic', 'proposer'],
  assembly: ['proposer', 'proposer', 'voter', 'voter'],
};
const VOICE: Record<DecisionTraceEntry['role'], string[]> = {
  leader: ['Decido io: prima la legna, poi il cibo.', 'Ognuno al suo posto, ci ritroviamo al fuoco.', 'Il piano è questo, niente deviazioni.'],
  proposer: ['Propongo di raccogliere a est finché c’è luce.', 'Potrei portare legna al cantiere.', 'Serve qualcuno di guardia alle scorte.'],
  critic: ['È rischioso: l’inverno è vicino.', 'Troppa strada per così poco cibo.', 'Buona idea, ma prima mangia.'],
  router: ['Questo è lavoro per il taglialegna.', 'Lo affido a chi conosce il sentiero.', 'Gli attrezzi a chi costruisce.'],
  voter: ['Voto sì.', 'Voto per restare.', 'Mi astengo, decidete voi.'],
};

/**
 * Mock bookkeeping behind god mode: global conversation log, per-agent thoughts and consults,
 * decision-loop counters, Lorebase log and open proposals.
 */
export class GodLedger {
  private lines: ConversationLine[] = [];
  private seq = 1;
  private thoughts = new Map<string, { at: GameTime; text: string }[]>();
  private consults = new Map<string, { at: GameTime; tool: string; query: string }[]>();
  private streams = new Map<string, string>();
  private runs = 0;
  private decisions = 0;
  private groupDecisions = 0;
  private failures = 0;
  private tokens = { input: 0, output: 0 };
  private costByModel: Record<string, number> = {};
  private costByTier: Record<string, number> = {};
  private log: LorebaseLogEntry[] = [];
  private proposals: ProposalInfo[] = [];
  private propSeq = 1;
  private deliberatedAt = new Map<string, number>();
  private lastCompaction = new Date(Date.now() - 42 * 60_000).toISOString();

  constructor(private host: GodHost) {
    this.seedHistory();
  }

  private seedHistory() {
    const ids = this.host.agentIds();
    for (let i = 0; i < 10 && ids.length > 1; i++) {
      const a = ids[Math.floor(this.host.r() * ids.length)];
      const b = ids.find((x) => x !== a && this.host.r() < 0.4) ?? ids.find((x) => x !== a)!;
      const [l1, l2] = CHATTER[i % CHATTER.length];
      const minute = 6 * 60 + i * 5;
      this.add({ at: { day: 1, minute }, from: a, to: b, text: l1, kind: 'speech' });
      this.add({ at: { day: 1, minute: minute + 1 }, from: b, to: a, text: l2, kind: 'speech' });
    }
    const t0 = Date.now();
    const seedLog: [string, string, string[]][] = [
      ['9c1d2e0', 'Seed del mondo: leggi, ruoli e mappa iniziale', ['rule', 'role', 'world']],
      ['4be7a19', 'Coscienza dei ruoli: prime idee condivise', ['insight']],
      ['7f30c55', 'Economia: risorse e ricette di base', ['resource', 'recipe', 'tech']],
      ['a3f9c1e', 'Legge aggiornata: durata delle stagioni', ['rule']],
    ];
    seedLog.forEach(([revision, message, kinds], i) => this.log.unshift({ revision, message, kinds, time: new Date(t0 - (seedLog.length - i) * 9 * 60_000).toISOString() }));
    this.proposals.push({ id: `p-${this.propSeq++}`, title: 'Più cibo per ogni cespuglio (food.per_gather 2 → 3)', branch: 'proposal/food-per-gather', status: 'open', author: 'Elsa' });
  }

  private add(l: Omit<ConversationLine, 'id'>) {
    this.lines.push({ id: `cv-${this.seq++}`, ...l });
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
  }

  private keep<T>(map: Map<string, T[]>, id: string, item: T) {
    let arr = map.get(id);
    if (!arr) map.set(id, (arr = []));
    arr.push(item);
    if (arr.length > MAX_PER_AGENT) arr.shift();
  }

  /** Called for every message the mock emits. */
  observe(msg: ServerMsg) {
    const at = this.host.now();
    switch (msg.type) {
      case 'say':
        this.add({ at, from: msg.from, to: msg.to, text: msg.text, kind: msg.kind });
        if (msg.kind === 'thought') this.keep(this.thoughts, msg.from, { at, text: msg.text });
        break;
      case 'say_delta': {
        const text = (this.streams.get(msg.from) ?? '') + msg.delta;
        if (msg.done) {
          this.streams.delete(msg.from);
          this.add({ at, from: msg.from, to: msg.to, text, kind: 'speech' });
        } else this.streams.set(msg.from, text);
        break;
      }
      case 'deliberation':
        this.add({ at, from: msg.member, to: msg.groupId, text: msg.text, kind: 'deliberation', groupId: msg.groupId });
        break;
      case 'consult':
        this.keep(this.consults, msg.agentId, { at, tool: msg.tool, query: msg.query });
        break;
      case 'thinking': {
        if (!msg.on) break;
        const tier = this.host.agent(msg.id)?.tier ?? 'haiku';
        this.runs++;
        if (this.host.r() < 0.03) this.failures++;
        const [inp, out] = TOKENS_PER_RUN[tier] ?? [1000, 300];
        const i = Math.round(inp * (0.7 + this.host.r() * 0.6));
        const o = Math.round(out * (0.7 + this.host.r() * 0.6));
        this.tokens.input += i;
        this.tokens.output += o;
        const cost = ((i + o) / 1000) * (PRICE[tier] ?? 0);
        const model = MODEL_OF[tier] ?? tier;
        this.costByModel[model] = (this.costByModel[model] ?? 0) + cost;
        this.costByTier[tier] = (this.costByTier[tier] ?? 0) + cost;
        break;
      }
      case 'plan':
        if (msg.scope === 'group') this.groupDecisions++;
        else this.decisions++;
        break;
    }
  }

  /** Lorebase commit (direct change or merged proposal). */
  commit(revision: string, message: string, kinds: string[]) {
    this.log.unshift({ revision, message, kinds, time: new Date().toISOString() });
    if (this.log.length > 100) this.log.pop();
  }

  openProposal(title: string, branch: string, author: string): ProposalInfo {
    const p: ProposalInfo = { id: `p-${this.propSeq++}`, title, branch, status: 'open', author };
    this.proposals.unshift(p);
    return p;
  }

  closeProposal(id: string, status: 'merged' | 'rejected') {
    const p = this.proposals.find((x) => x.id === id);
    if (p) p.status = status;
  }

  /** Deliberation lines for a group's new joint plan, at most once per `minGapSec` per group. */
  deliberation(g: Group, elapsed: number, minGapSec: number): { member: string; role: DecisionTraceEntry['role']; text: string }[] {
    if (g.pattern === 'crowd' || elapsed - (this.deliberatedAt.get(g.id) ?? -Infinity) < minGapSec) return [];
    this.deliberatedAt.set(g.id, elapsed);
    const pick = <T>(arr: T[]) => arr[Math.floor(this.host.r() * arr.length)];
    const trace = g.lastDecision?.trace ?? [];
    if (trace.length && this.host.r() < 0.5) return trace.map((x) => ({ ...x }));
    const roles = DELIBERATION[g.pattern] ?? ['proposer', 'leader'];
    return roles.map((role, i) => ({
      member: role === 'leader' && g.leader ? g.leader : g.members[i % g.members.length],
      role,
      text: pick(VOICE[role]),
    }));
  }

  // ------------------------------------------------------------ REST

  conversations(q: URLSearchParams, groups: Map<string, Group>): ConversationLine[] {
    const agent = q.get('agent');
    const other = q.get('with');
    const group = q.get('group');
    const since = Number(q.get('since') || 0);
    const limit = Math.max(1, Math.min(1000, Number(q.get('limit') || 200)));
    const g = group ? groups.get(group) : undefined;
    const out = this.lines.filter((l) => {
      if (since && Number(l.id.slice(3)) <= since) return false;
      if (agent && other) return (l.from === agent && l.to === other) || (l.from === other && l.to === agent);
      if (agent && l.from !== agent && l.to !== agent) return false;
      if (other && l.from !== other && l.to !== other) return false;
      if (group && l.groupId !== group && !g?.members.includes(l.from)) return false;
      return true;
    });
    return out.slice(-limit);
  }

  mind(id: string): AgentMind | undefined {
    const a = this.host.agent(id);
    if (!a) return undefined;
    return {
      agentId: id,
      plan: a.steps.length ? { steps: a.steps, current: a.current, reason: '' } : null,
      thoughts: this.thoughts.get(id) ?? [],
      consults: this.consults.get(id) ?? [],
      groupId: a.groupId,
    };
  }

  summary(): ObservatorySummary {
    const { branch, revision } = this.host.revision();
    const perAgent = this.host.agentIds().map((id) => {
      const mem = this.host.memories(id) ?? [];
      return {
        agentId: id,
        name: this.host.agent(id)?.name ?? id,
        count: mem.length,
        avgFidelity: mem.length ? +(mem.reduce((s, m) => s + m.fidelity, 0) / mem.length).toFixed(2) : 0,
        gists: mem.filter((m) => m.kind === 'gist').length,
      };
    });
    const memories = perAgent.reduce((s, a) => s + a.count, 0);
    const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(4)]));
    const total = Object.values(this.costByModel).reduce((s, v) => s + v, 0);
    return {
      lorebase: { url: 'http://localhost:5180', domain: 'world', branch, revision, counts: { ...this.host.counts(), proposals: this.proposals.filter((p) => p.status === 'open').length } },
      mnemo: { memories, perAgent, dbBytes: memories * 640 + 48_000, lastCompaction: this.lastCompaction },
      reinloop: {
        runs: this.runs,
        decisions: this.decisions,
        groupDecisions: this.groupDecisions,
        failures: this.failures,
        tokens: { ...this.tokens },
        costUsd: { total: +total.toFixed(4), byModel: round(this.costByModel), byTier: round(this.costByTier) },
      },
    };
  }

  lorebaseLog(limit: number): LorebaseLogEntry[] {
    return this.log.slice(0, limit);
  }

  proposalList(status: string | null): ProposalInfo[] {
    return status ? this.proposals.filter((p) => p.status === status) : this.proposals;
  }
}
