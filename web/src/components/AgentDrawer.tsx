import { t } from '../i18n';
import { useSim } from '../state/store';
import { FEED_STYLE, roleStyle } from '../theme/tokens';
import { RoleGlyph, TierBadge } from './Glyphs';

export function AgentDrawer() {
  const { state, focusId, setFocus } = useSim();
  const a = focusId ? state.agents[focusId] : null;
  if (!a) return null;
  const items = state.timelines[a.id] ?? [];
  const thought = state.thoughts[a.id] ?? a.thought;
  const rs = roleStyle(a.role);
  return (
    <aside className="drawer" style={{ ['--role' as string]: rs.color }}>
      <header className="drawer-head">
        <RoleGlyph role={a.role} size={28} dead={!a.alive} />
        <div>
          <h3>{a.name}</h3>
          <p>
            {rs.label} · {t.drawer.gen(a.generation)} · ({a.x},{a.y}) {a.alive ? '' : `· ${t.drawer.deceased}`}
          </p>
        </div>
        <TierBadge tier={a.tier} />
        <button className="chip-btn" onClick={() => setFocus(null)} aria-label={t.drawer.close}>✕</button>
      </header>
      <dl className="drawer-stats">
        <div><dt>{t.drawer.hp}</dt><dd>{Math.round(a.hp)}/{a.maxHp}</dd></div>
        <div><dt>{t.drawer.hunger}</dt><dd>{Math.round(a.hunger)}</dd></div>
        <div><dt>{t.drawer.food}</dt><dd>{a.inventory.food}</dd></div>
        <div><dt>{t.drawer.wood}</dt><dd>{a.inventory.wood}</dd></div>
        <div><dt>{t.drawer.model}</dt><dd className="mono">{a.model ?? '—'}</dd></div>
      </dl>
      {thought && (
        <blockquote className={`drawer-thought ${a.status === 'thinking' ? 'live' : ''}`}>
          {thought}
          {a.status === 'thinking' && <span className="caret" />}
        </blockquote>
      )}
      <h4>{t.drawer.timeline}</h4>
      <ol className="timeline">
        {items.map((it) => (
          <li key={it.id} className={`tl-${it.kind} ${it.ok === false ? 'failed' : ''}`} style={{ ['--k' as string]: FEED_STYLE[it.kind]?.color }}>
            <span className="tl-tick">{t.feed.tickPrefix}{it.tick}</span>
            <span className="tl-text">
              {it.kind === 'message' ? (
                <>
                  <b>{it.agentId === a.id ? `→ ${it.to === 'all' ? t.drawer.everyone : state.agents[it.to ?? '']?.name ?? it.to}` : `← ${state.agents[it.agentId ?? '']?.name}`}</b> “{it.text}”
                </>
              ) : (
                it.text
              )}
            </span>
          </li>
        ))}
        {!items.length && <li className="empty">{t.drawer.empty}</li>}
      </ol>
    </aside>
  );
}
