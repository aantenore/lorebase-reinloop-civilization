import { useEffect, useMemo, useState } from 'react';
import { useSim } from '../state/store';
import { useUi } from '../state/ui';
import { t as tr } from '../i18n';
import { PanelHead, panelClass } from './PanelChrome';
import { ROLE_STYLE, TIER_STYLE, roleStyle } from '../theme/tokens';
import { TIERS, type Agent, type RosterInfo, type Tier } from '../types';
import { randomName } from '../lib/names';
import { RoleGlyph, TierBadge, TierMark } from './Glyphs';

type TierFilter = 'all' | Tier;

export function useRosterInfo() {
  const { actions, state } = useSim();
  const [info, setInfo] = useState<RosterInfo | null>(null);
  useEffect(() => {
    let alive = true;
    actions.roster().then((r) => alive && setInfo(r)).catch(() => alive && setInfo(null));
    return () => {
      alive = false;
    };
  }, [actions]);
  const roles = info?.roles?.length ? info.roles : Object.keys(ROLE_STYLE);
  return { info, roles, roster: info?.agents ?? state.roster };
}

export function Roster() {
  const { state, focusId, setFocus } = useSim();
  const [filter, setFilter] = useState<TierFilter>('all');
  const [grouped, setGrouped] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const { prefs } = useUi();

  const agents = state.order.map((id) => state.agents[id]).filter(Boolean) as Agent[];
  const visible = agents
    .filter((a) => filter === 'all' || a.tier === filter)
    .sort((a, b) => Number(b.alive) - Number(a.alive));
  const alive = agents.filter((a) => a.alive).length;

  const groups = useMemo(() => {
    if (!grouped) return [{ key: 'all', label: '', items: visible }];
    return TIERS.map((t) => ({ key: t as string, label: TIER_STYLE[t].label, items: visible.filter((a) => a.tier === t) }))
      .concat([{ key: 'none', label: tr.roster.untiered, items: visible.filter((a) => !a.tier) }])
      .filter((g) => g.items.length);
  }, [grouped, visible]);

  return (
    <section className={panelClass('roster', prefs.collapsed.roster)}>
      <PanelHead id="roster" title={tr.roster.title} extra={<span className="count">{alive}/{agents.length}</span>}>
        <button className="chip-btn accent" onClick={() => setSpawnOpen((o) => !o)}>{spawnOpen ? tr.roster.close : tr.roster.spawn}</button>
      </PanelHead>
      <div className="roster-tools">
        <div className="seg" role="tablist" aria-label={tr.roster.filterAria}>
          {(['all', ...TIERS] as TierFilter[]).map((t) => (
            <button key={t} className={`seg-btn ${filter === t ? 'on' : ''}`} onClick={() => setFilter(t)}>
              {t !== 'all' && <TierMark tier={t} />}
              {t === 'all' ? tr.roster.all : TIER_STYLE[t].label}
            </button>
          ))}
        </div>
        <label className="toggle">
          <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
          {tr.roster.group}
        </label>
      </div>
      {spawnOpen && <SpawnForm taken={agents.map((a) => a.name)} onDone={() => setSpawnOpen(false)} />}
      <div className="roster-list">
        {groups.map((g) => (
          <div key={g.key} className="roster-group">
            {g.label && (
              <div className={`group-label tier-${g.key}`}>
                {g.key !== 'none' && <TierMark tier={g.key as Tier} />} {g.label}
                <span>{tr.roster.alive(g.items.filter((a) => a.alive).length)}</span>
              </div>
            )}
            {g.items.map((a) => (
              <AgentRow key={a.id} a={a} thought={state.thoughts[a.id] ?? ''} focused={focusId === a.id} onFocus={() => setFocus(focusId === a.id ? null : a.id)} />
            ))}
          </div>
        ))}
        {!agents.length && <p className="empty">{tr.roster.empty}</p>}
      </div>
    </section>
  );
}

function Bar({ value, max, kind }: { value: number; max: number; kind: 'hp' | 'hunger' }) {
  const f = Math.max(0, Math.min(1, value / (max || 1)));
  return (
    <div className={`bar bar-${kind}`} title={`${kind === 'hp' ? tr.roster.hp : tr.roster.hunger} ${Math.round(value)}/${max}`}>
      <div className="bar-fill" style={{ width: `${f * 100}%` }} data-level={f > 0.6 ? 'hi' : f > 0.3 ? 'mid' : 'lo'} />
    </div>
  );
}

function AgentRow({ a, thought, focused, onFocus }: { a: Agent; thought: string; focused: boolean; onFocus(): void }) {
  const { actions } = useSim();
  const [confirm, setConfirm] = useState(false);
  const rs = roleStyle(a.role);
  const shownThought = thought.length > 180 ? '…' + thought.slice(-180) : thought;
  return (
    <article
      className={`agent-row ${a.alive ? '' : 'dead'} ${focused ? 'focused' : ''} ${a.tier ? `tier-${a.tier}` : ''} status-${a.status}`}
      style={{ ['--role' as string]: rs.color }}
      onClick={onFocus}
    >
      <div className="agent-head">
        <RoleGlyph role={a.role} dead={!a.alive} />
        <div className="agent-id">
          <b>{a.name}</b>
          <span className="agent-role">
            {rs.label}
            {a.generation > 1 && <> · {tr.roster.gen(a.generation)}</>}
          </span>
        </div>
        <TierBadge tier={a.tier} />
        <button
          className={`row-x ${confirm ? 'confirm' : ''}`}
          title={confirm ? tr.roster.removeConfirmTitle : tr.roster.remove}
          onClick={(e) => {
            e.stopPropagation();
            if (!confirm) {
              setConfirm(true);
              setTimeout(() => setConfirm(false), 2500);
            } else actions.removeAgent(a.id);
          }}
        >
          {confirm ? tr.roster.removeConfirm : '×'}
        </button>
      </div>
      {a.alive ? (
        <>
          <div className="agent-bars">
            <span className="lbl">{tr.roster.hp}</span>
            <Bar value={a.hp} max={a.maxHp} kind="hp" />
            <span className="lbl">{tr.roster.hunger}</span>
            <Bar value={a.hunger} max={100} kind="hunger" />
          </div>
          <div className="agent-meta">
            <span title={tr.roster.food}>❀ {a.inventory.food}</span>
            <span title={tr.roster.wood}>▤ {a.inventory.wood}</span>
            {a.sheltered && <span className="sheltered">{tr.roster.sheltered}</span>}
            {a.model && <span className="model" title={a.model}>{a.model}</span>}
          </div>
          <div className="agent-status">
            {a.status === 'thinking' ? (
              <p className="thought live">
                <span className="spinner" aria-hidden />
                {shownThought || <i>{tr.roster.thinking}</i>}
                <span className="caret" />
              </p>
            ) : (
              <p className="last-action">
                <span className={`status-dot s-${a.status}`} />
                {a.lastAction ?? tr.roster.idle}
              </p>
            )}
          </div>
        </>
      ) : (
        <p className="epitaph">{tr.roster.epitaph}</p>
      )}
    </article>
  );
}

function SpawnForm({ taken, onDone }: { taken: string[]; onDone(): void }) {
  const { actions } = useSim();
  const { roles, info } = useRosterInfo();
  const [name, setName] = useState(() => randomName(taken));
  const [role, setRole] = useState('gatherer');
  const [tier, setTier] = useState<Tier>('sonnet');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="spawn-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        const res = await actions.spawnAgent({ name: name.trim(), role, tier, model: info?.models?.[tier] });
        setBusy(false);
        if (res.ok) onDone();
        else setErr(res.error ?? tr.roster.spawnFail);
      }}
    >
      <div className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr.roster.namePh} required maxLength={24} />
        <button type="button" className="chip-btn" title={tr.roster.randomName} onClick={() => setName(randomName(taken))}>⚄</button>
      </div>
      <div className="row">
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {roles.map((r) => (
            <option key={r} value={r}>{roleStyle(r).label}</option>
          ))}
        </select>
        <select value={tier} onChange={(e) => setTier(e.target.value as Tier)}>
          {TIERS.map((t) => (
            <option key={t} value={t}>{TIER_STYLE[t].label} {TIER_STYLE[t].cost}</option>
          ))}
        </select>
        <button className="ctl primary" disabled={busy}>{busy ? '…' : tr.roster.spawnBtn}</button>
      </div>
      {err && <p className="form-err">{err}</p>}
    </form>
  );
}
