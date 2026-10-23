import { useSim } from '../state/store';
import { ruleLabel, t } from '../i18n';

export function RuleBanner() {
  const { state, actions } = useSim();
  const b = state.banner;
  if (!b) return null;
  return (
    <div className="rule-banner" key={b.revision} role="status">
      <div className="rb-head">
        <span className="rb-seal">⚖</span>
        <span>
          {t.banner.revision} <code>{b.revision.slice(0, 7)}</code> · {t.banner.day} {b.tick}
        </span>
        <button className="chip-btn" onClick={actions.dismissBanner} aria-label={t.banner.dismiss}>✕</button>
      </div>
      <ul>
        {b.changes.map((c) => (
          <li key={c.key}>
            <span className="rb-key">{ruleLabel(c.key)}</span>
            <s>{c.old}</s>
            <span className="rb-arrow">→</span>
            <b className={c.new > c.old ? 'up' : 'down'}>{c.new}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
