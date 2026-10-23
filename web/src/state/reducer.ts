import { config } from '../config';
import { t } from '../i18n';
import type { ConnState } from '../api/transport';
import type { Agent, RosterEntry, Rule, RuleChange, RuleMode, Season, ServerEvent, SimStatus, Stats, World } from '../types';

export type FeedKind = 'action' | 'message' | 'birth' | 'death' | 'season' | 'rules' | 'build' | 'starvation' | 'cold';

export interface FeedItem {
  id: number;
  tick: number;
  kind: FeedKind;
  text: string;
  agentId?: string;
  to?: string;
  ok?: boolean;
  tool?: string;
}

export interface Bubble {
  id: number;
  agentId: string;
  text: string;
  to: string;
  at: number;
}

export interface RuleMarker {
  tick: number;
  revision: string;
  changes: RuleChange[];
}

export interface PendingRule {
  value: number;
  mode: RuleMode;
  since: number;
  proposalId?: string;
}

export interface State {
  conn: ConnState;
  ready: boolean;
  tick: number;
  season: Season;
  world: World | null;
  worldVersion: number;
  agents: Record<string, Agent>;
  order: string[];
  thoughts: Record<string, string>;
  rules: Rule[];
  ruleFlash: Record<string, { old: number; new: number; at: number }>;
  pending: Record<string, PendingRule>;
  /** Last write error per rule key (e.g. Lorebase never confirmed). */
  ruleErrors: Record<string, string>;
  history: Stats[];
  markers: RuleMarker[];
  status: SimStatus | null;
  revisionPulse: number;
  feed: FeedItem[];
  timelines: Record<string, FeedItem[]>;
  bubbles: Bubble[];
  banner: (RuleMarker & { at: number }) | null;
  roster: RosterEntry[];
}

export type Action =
  | { type: 'event'; ev: ServerEvent }
  | { type: 'conn'; state: ConnState }
  | { type: 'pending'; key: string; pending: PendingRule | null }
  | { type: 'dismiss_banner' }
  | { type: 'gc'; now: number };

export const initialState: State = {
  conn: 'connecting',
  ready: false,
  tick: 0,
  season: 'spring',
  world: null,
  worldVersion: 0,
  agents: {},
  order: [],
  thoughts: {},
  rules: [],
  ruleFlash: {},
  pending: {},
  ruleErrors: {},
  history: [],
  markers: [],
  status: null,
  revisionPulse: 0,
  feed: [],
  timelines: {},
  bubbles: [],
  banner: null,
  roster: [],
};

let seq = 0;
const nextId = () => ++seq;

function pushFeed(s: State, item: Omit<FeedItem, 'id'>): Pick<State, 'feed' | 'timelines'> {
  const full = { ...item, id: nextId() };
  const feed = [full, ...s.feed].slice(0, config.feedLimit);
  let timelines = s.timelines;
  if (item.agentId) {
    const prev = timelines[item.agentId] ?? [];
    timelines = { ...timelines, [item.agentId]: [full, ...prev].slice(0, config.timelineLimit) };
  }
  return { feed, timelines };
}

function fmtArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args !== 'object') return String(args);
  const entries = Object.entries(args as Record<string, unknown>);
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'conn':
      return { ...s, conn: a.state };
    case 'pending': {
      const pending = { ...s.pending };
      const ruleErrors = { ...s.ruleErrors };
      if (a.pending) {
        pending[a.key] = a.pending;
        delete ruleErrors[a.key];
      } else delete pending[a.key];
      return { ...s, pending, ruleErrors };
    }
    case 'dismiss_banner':
      return { ...s, banner: null };
    case 'gc': {
      const bubbles = s.bubbles.filter((b) => a.now - b.at < config.bubbleMs);
      const banner = s.banner && a.now - s.banner.at > config.bannerMs ? null : s.banner;
      const expired = Object.entries(s.pending).filter(([, p]) => a.now - p.since > config.pendingTimeoutMs);
      if (bubbles.length === s.bubbles.length && banner === s.banner && !expired.length) return s;
      if (!expired.length) return { ...s, bubbles, banner };
      const pending = { ...s.pending };
      const ruleErrors = { ...s.ruleErrors };
      for (const [k] of expired) {
        delete pending[k];
        ruleErrors[k] = t.laws.timeout(Math.round(config.pendingTimeoutMs / 1000));
      }
      return { ...s, bubbles, banner, pending, ruleErrors };
    }
    case 'event':
      return onEvent(s, a.ev);
  }
}

function onEvent(s: State, ev: ServerEvent): State {
  switch (ev.type) {
    case 'snapshot': {
      const agents: Record<string, Agent> = {};
      const thoughts: Record<string, string> = {};
      for (const ag of ev.agents) {
        agents[ag.id] = ag;
        thoughts[ag.id] = ag.thought || '';
      }
      // keep feed/timelines across reconnects only if the tick did not go backwards (i.e. not a reset)
      const isReset = ev.tick < s.tick || !s.ready;
      return {
        ...s,
        ready: true,
        tick: ev.tick,
        season: ev.season,
        world: ev.world,
        worldVersion: s.worldVersion + 1,
        agents,
        order: ev.agents.map((x) => x.id),
        thoughts,
        rules: ev.rules,
        history: ev.history,
        status: ev.status,
        roster: ev.roster ?? s.roster,
        markers: isReset ? [] : s.markers,
        feed: isReset ? [] : s.feed,
        timelines: isReset ? {} : s.timelines,
        bubbles: [],
        pending: isReset ? {} : s.pending,
      };
    }
    case 'tick': {
      const last = s.history[s.history.length - 1];
      const history = last && last.tick === ev.stats.tick ? [...s.history.slice(0, -1), ev.stats] : [...s.history, ev.stats];
      return { ...s, tick: ev.tick, season: ev.season, history };
    }
    case 'agent_update': {
      const ag = ev.agent;
      const known = !!s.agents[ag.id];
      const thoughts = { ...s.thoughts };
      if (ag.status === 'thinking' && !ag.thought) thoughts[ag.id] = '';
      else if (ag.thought) thoughts[ag.id] = ag.thought;
      return {
        ...s,
        agents: { ...s.agents, [ag.id]: ag },
        order: known ? s.order : [...s.order, ag.id],
        thoughts,
      };
    }
    case 'agent_thought':
      return { ...s, thoughts: { ...s.thoughts, [ev.agentId]: (s.thoughts[ev.agentId] ?? '') + ev.delta } };
    case 'agent_action': {
      const name = s.agents[ev.agentId]?.name ?? ev.agentId;
      const args = fmtArgs(ev.args);
      return {
        ...s,
        ...pushFeed(s, {
          tick: ev.tick,
          kind: 'action',
          agentId: ev.agentId,
          tool: ev.tool,
          ok: ev.ok,
          text: `${name} ${ev.tool}${args ? ` (${args})` : ''}${ev.ok ? '' : ` — ${t.feed.failed}`}`,
        }),
      };
    }
    case 'message': {
      const bubble: Bubble = { id: nextId(), agentId: ev.from, text: ev.text, to: ev.to, at: Date.now() };
      const feedState = pushFeed(s, { tick: ev.tick, kind: 'message', agentId: ev.from, to: ev.to, text: ev.text });
      // also record on recipient timeline
      let timelines = feedState.timelines;
      if (ev.to !== 'all' && s.agents[ev.to]) {
        const item = feedState.feed[0];
        timelines = { ...timelines, [ev.to]: [item, ...(timelines[ev.to] ?? [])].slice(0, config.timelineLimit) };
      }
      return { ...s, feed: feedState.feed, timelines, bubbles: [...s.bubbles.filter((b) => b.agentId !== ev.from), bubble] };
    }
    case 'world_event':
      return { ...s, ...pushFeed(s, { tick: ev.tick, kind: ev.kind, text: ev.text }) };
    case 'tile_update': {
      if (!s.world) return s;
      const idx = ev.y * s.world.w + ev.x;
      const tiles = s.world.tiles;
      const cur = tiles[idx];
      if (!cur) return s;
      // mutate in place + bump version: tiles can be large and update often
      tiles[idx] = { ...cur, food: ev.food, wood: ev.wood, shelter: ev.shelter };
      return { ...s, worldVersion: s.worldVersion + 1 };
    }
    case 'rules_changed': {
      const now = Date.now();
      const flash = { ...s.ruleFlash };
      const pending = { ...s.pending };
      const ruleErrors = { ...s.ruleErrors };
      for (const c of ev.changes) delete ruleErrors[c.key];
      const rules = s.rules.map((r) => {
        const c = ev.changes.find((x) => x.key === r.key);
        if (!c) return r;
        flash[r.key] = { old: c.old, new: c.new, at: now };
        delete pending[r.key];
        return { ...r, value: c.new, text: c.text ?? r.text };
      });
      // rules unknown to us so far
      for (const c of ev.changes) {
        if (!rules.some((r) => r.key === c.key)) {
          rules.push({ key: c.key, value: c.new, text: c.text ?? '', category: 'other', unit: '' });
          flash[c.key] = { old: c.old, new: c.new, at: now };
          delete pending[c.key];
        }
      }
      const marker: RuleMarker = { tick: s.tick, revision: ev.revision, changes: ev.changes };
      const status = s.status ? { ...s.status, lorebase: { ...s.status.lorebase, revision: ev.revision } } : s.status;
      return {
        ...s,
        rules,
        ruleFlash: flash,
        pending,
        ruleErrors,
        markers: [...s.markers, marker],
        banner: { ...marker, at: now },
        status,
        revisionPulse: s.revisionPulse + 1,
      };
    }
    case 'status': {
      const prev = s.status?.lorebase;
      const next = ev.status.lorebase;
      const changed = !!prev && (prev.revision !== next.revision || prev.branch !== next.branch);
      return { ...s, status: ev.status, revisionPulse: changed ? s.revisionPulse + 1 : s.revisionPulse };
    }
  }
  return s;
}
