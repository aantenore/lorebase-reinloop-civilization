import { useMemo, useState } from 'react';
import { t } from '../i18n';
import { useSim } from '../state/store';
import { useUi } from '../state/ui';
import { PanelHead, panelClass } from './PanelChrome';
import type { FeedKind } from '../state/reducer';
import { FEED_STYLE } from '../theme/tokens';

const FILTERS: { key: keyof typeof t.feed.filters; kinds: FeedKind[] }[] = [
  { key: 'all', kinds: [] },
  { key: 'world', kinds: ['birth', 'death', 'season', 'build', 'starvation', 'cold'] },
  { key: 'laws', kinds: ['rules'] },
  { key: 'talk', kinds: ['message'] },
  { key: 'acts', kinds: ['action'] },
];

export function EventFeed() {
  const { state, setFocus } = useSim();
  const [f, setF] = useState<string>('all');
  const { prefs } = useUi();
  const items = useMemo(() => {
    const kinds = FILTERS.find((x) => x.key === f)?.kinds ?? [];
    return (kinds.length ? state.feed.filter((i) => kinds.includes(i.kind)) : state.feed).slice(0, 150);
  }, [state.feed, f]);

  return (
    <section className={panelClass('feed', prefs.collapsed.feed)}>
      <PanelHead id="feed" title={t.feed.title}>
        <div className="seg small">
          {FILTERS.map((x) => (
            <button key={x.key} className={`seg-btn ${f === x.key ? 'on' : ''}`} onClick={() => setF(x.key)}>{t.feed.filters[x.key]}</button>
          ))}
        </div>
      </PanelHead>
      <ol className="feed-list">
        {items.map((it) => {
          const who = it.agentId ? state.agents[it.agentId] : null;
          const to = it.to && it.to !== 'all' ? state.agents[it.to]?.name ?? it.to : it.to === 'all' ? t.feed.all : null;
          return (
            <li key={it.id} className={`fi fi-${it.kind} ${it.ok === false ? 'failed' : ''}`} style={{ ['--k' as string]: FEED_STYLE[it.kind]?.color }}>
              <span className="fi-tick">{t.feed.tickPrefix}{it.tick}</span>
              <span className="fi-kind">{t.feed.kinds[it.kind] ?? it.kind}</span>
              <span className="fi-text">
                {it.kind === 'message' && who ? (
                  <>
                    <button className="link" onClick={() => setFocus(who.id)}>{who.name}</button>
                    <span className="fi-to"> → {to}</span> “{it.text}”
                  </>
                ) : it.kind === 'action' && who ? (
                  <button className="link plain" onClick={() => setFocus(who.id)}>{it.text}</button>
                ) : (
                  it.text
                )}
              </span>
            </li>
          );
        })}
        {!items.length && <li className="empty">{t.feed.empty}</li>}
      </ol>
    </section>
  );
}
