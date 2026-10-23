import { config } from '../../config';
import { roleLabel, t, type I18nKey } from '../../i18n';
import type { AgentMind, GameTime } from '../../net/protocol';
import { session } from '../../net/session';
import { store, type EntityState } from '../../state/store';
import { h, throttle } from '../dom';
import { patternLabel, stepList, tierBadge } from '../inspector';
import { MemoryView } from '../memoryView';
import type { GodTab } from './godMode';
import { fmtAt, focusEntity } from './godShared';

interface MindState {
  plan: AgentMind['plan'];
  thoughts: { at: GameTime; text: string }[];
  consults: { at: GameTime; tool: string; query: string }[];
  remote: 'loading' | 'ok' | 'fail';
}

const now = (): GameTime => ({ day: store.time.day, minute: store.time.minute });

/** Any agent's mind: plan, thoughts, Lorebase consults, private memories (fading) and group. */
export function mountGodMinds(): GodTab {
  let agentId: string | null = null;
  let visible = false;
  let loadSeq = 0;
  let mind: MindState = { plan: null, thoughts: [], consults: [], remote: 'ok' };

  const agentList = h('div', { class: 'scroll god-agents' });
  const head = h('div');
  const dyn = h('div');
  const memory = new MemoryView();
  const detail = h('div', { class: 'scroll god-mind' }, head, dyn, memory.el);
  const el = h('div', { class: 'god-tab god-split' }, h('div', { class: 'god-col' }, h('div', { class: 'section-title' }, t('god.agents')), agentList), detail);

  const status = (e: EntityState) => (!e.alive ? t('god.status.dead') : e.thinking ? t('god.status.thinking') : t(`anim.${e.anim}` as I18nKey));

  const renderAgents = () => {
    const agents = [...store.entities.values()].filter((e) => e.kind === 'agent').sort((a, b) => a.name.localeCompare(b.name));
    agentList.replaceChildren(
      ...agents.map((e) =>
        h(
          'div',
          { class: `god-agent${e.id === agentId ? ' on' : ''}${e.alive ? '' : ' dead'}`, onclick: () => pick(e.id) },
          h('div', {}, tierBadge(e.effectiveTier ?? e.tier), h('b', {}, e.name)),
          h('div', { class: 'muted' }, `${roleLabel(e.role)} · ${status(e)}`),
        ),
      ),
    );
  };
  const renderAgentsSoon = throttle(() => visible && renderAgents(), 1000);

  const renderMind = () => {
    const e = agentId ? store.entities.get(agentId) : undefined;
    if (!e) {
      head.replaceChildren(h('div', { class: 'note' }, t('god.pickAgent')));
      dyn.replaceChildren();
      return;
    }
    const g = e.groupId ? store.groups.get(e.groupId) : undefined;
    const plan = store.plans.get(e.id) ?? (mind.plan ? { ...mind.plan } : undefined);
    head.replaceChildren(
      h(
        'div',
        { class: 'god-row' },
        h('div', { class: 'name' }, e.name),
        tierBadge(e.effectiveTier ?? e.tier),
        h('span', { class: 'sub' }, `${roleLabel(e.role)} · ${status(e)}`),
        e.thinking ? h('span', { class: 'thinking-tag' }, t('insp.thinking')) : null,
        h('button', { class: 'btn', onclick: () => focusEntity(e.id) }, t('god.focus')),
      ),
      mind.remote === 'fail' ? h('div', { class: 'note' }, t('god.mindUnavailable')) : '',
    );
    dyn.replaceChildren(
      h('div', { class: 'section-title' }, t('god.plan')),
      plan && plan.steps.length
        ? h('div', {}, plan.reason ? h('div', { class: 'quote' }, h('b', {}, `${t('insp.reason')}: `), plan.reason) : null, stepList(plan.steps, plan.current, false))
        : h('div', { class: 'note' }, t('god.noPlan')),
      h('div', { class: 'section-title' }, t('god.thoughts')),
      ...(mind.thoughts.length
        ? mind.thoughts.map((x) => h('div', { class: 'quote thought' }, h('span', { class: 'muted' }, `${fmtAt(x.at)} `), x.text))
        : [h('div', { class: 'note' }, t('god.noThoughts'))]),
      h('div', { class: 'section-title' }, t('god.consults')),
      ...(mind.consults.length
        ? mind.consults.map((c) => h('div', { class: 'consult' }, h('span', { class: 'c-tool' }, c.tool), h('span', { class: 'c-q' }, c.query), h('span', { class: 'muted' }, fmtAt(c.at))))
        : [h('div', { class: 'note' }, t('god.noConsults'))]),
      h('div', { class: 'section-title' }, t('god.group')),
      g
        ? h(
            'div',
            {},
            h('div', { class: 'group-row' }, h('span', { class: 'swatch', style: `background:${g.color}` }), h('span', {}, g.name), h('span', { class: 'pattern' }, patternLabel(g))),
            h('div', { class: 'sub' }, g.members.map((m) => store.name(m) + (g.leader === m ? ` (${t('insp.leader')})` : '')).join(', ')),
            g.lastDecision ? h('div', { class: 'quote' }, h('b', {}, `${t('group.decision')}: `), g.lastDecision.summary) : null,
          )
        : h('div', { class: 'note' }, t('god.noGroup')),
    );
  };
  const renderMindSoon = throttle(() => visible && renderMind(), 400);

  const keep = <T>(arr: T[]) => arr.slice(0, config.god.mindItemsKept);

  const load = async (id: string) => {
    const seq = ++loadSeq;
    const local = (store.logs.get(id) ?? []).filter((l) => l.kind === 'thought' && l.from === id).reverse();
    mind = {
      plan: null,
      thoughts: local.map((l) => ({ at: now(), text: l.text })),
      consults: [...(store.consults.get(id) ?? [])].reverse().map((c) => ({ at: { day: c.day, minute: c.minute }, tool: c.tool, query: c.query })),
      remote: 'loading',
    };
    renderMind();
    try {
      const res = await session.transport!.getJson<AgentMind>(`/agents/${encodeURIComponent(id)}/mind`);
      if (seq !== loadSeq) return;
      mind = {
        plan: res.plan ?? null,
        thoughts: keep(res.thoughts?.length ? [...res.thoughts].reverse() : mind.thoughts),
        consults: keep(res.consults?.length ? [...res.consults].reverse() : mind.consults),
        remote: 'ok',
      };
    } catch {
      if (seq !== loadSeq) return;
      mind.remote = 'fail';
    }
    renderMind();
  };

  const pick = (id: string) => {
    if (agentId === id) return;
    agentId = id;
    memory.setAgent(id);
    renderAgents();
    void load(id);
  };

  // live updates
  store.on('say', (l) => {
    if (l.kind === 'thought' && l.from === agentId) {
      mind.thoughts = keep([{ at: now(), text: l.text }, ...mind.thoughts]);
      renderMindSoon();
    }
  });
  store.on('consult', (c) => {
    if (c.agentId !== agentId) return;
    mind.consults = keep([{ at: now(), tool: c.tool, query: c.query }, ...mind.consults]);
    renderMindSoon();
  });
  store.on('plan', (p) => (p.id === agentId || p.id === store.entities.get(agentId ?? '')?.groupId) && renderMindSoon());
  store.on('plan_progress', (p) => p.id === agentId && renderMindSoon());
  store.on('thinking', ({ id }) => {
    if (id === agentId) renderMindSoon();
    renderAgentsSoon();
  });
  store.on('entity_added', renderAgentsSoon);
  store.on('entity_removed', renderAgentsSoon);
  store.on('hello', renderAgentsSoon);
  // clicking an agent in the world while god mode is open shows its mind
  store.on('select', ({ id }) => {
    const e = id ? store.entities.get(id) : undefined;
    if (e?.kind === 'agent' && visible) pick(e.id);
  });

  return {
    el,
    show: () => {
      visible = true;
      const sel = store.selectedId ? store.entities.get(store.selectedId) : undefined;
      if (sel?.kind === 'agent') pick(sel.id);
      renderAgents();
      renderMind();
    },
    hide: () => {
      visible = false;
    },
  };
}
