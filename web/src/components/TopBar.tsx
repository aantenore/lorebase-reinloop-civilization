import { useEffect, useState } from 'react';
import { config } from '../config';
import { t } from '../i18n';
import { useSim } from '../state/store';
import { useUi } from '../state/ui';
import { SEASON_STYLE } from '../theme/tokens';

export function SeasonClock({ compact = false }: { compact?: boolean }) {
  const { state } = useSim();
  const season = SEASON_STYLE[state.season];
  return (
    <div className={`clock ${compact ? 'compact' : ''}`}>
      <div className={`season-badge season-${state.season}`} key={state.season}>
        <span className="season-glyph">{season.glyph}</span>
        {season.label}
      </div>
      <div className="tick">
        <span className="tick-label">{t.top.day}</span>
        <span className="tick-num" key={state.tick}>{state.tick}</span>
      </div>
    </div>
  );
}

export function PlayButton() {
  const { state, actions } = useSim();
  const running = state.status?.running ?? false;
  return (
    <button className={`ctl primary ${running ? 'is-running' : ''}`} onClick={() => (running ? actions.pause() : actions.start())} title={running ? t.top.pauseTitle : t.top.playTitle}>
      {running ? t.top.pause : t.top.play}
    </button>
  );
}

export function LorebasePill() {
  const { state } = useSim();
  const lb = state.status?.lorebase;
  return (
    <span
      key={state.revisionPulse}
      className={`pill lorebase ${lb?.connected ? 'ok' : 'down'} ${state.revisionPulse ? 'pulse' : ''}`}
      title={lb ? t.top.lorebaseTitle(lb.url, lb.domain) : t.top.lorebase}
    >
      <span className="dot" />
      {t.top.lorebase}
      {lb && (
        <>
          <em className={lb.branch !== 'main' ? 'branch-alt' : ''}>⎇ {lb.branch}</em>
          <code>{lb.revision?.slice(0, 7)}</code>
        </>
      )}
    </span>
  );
}

export function TopBar({ onOpenSetup }: { onOpenSetup(): void }) {
  const { state, actions, transportKind } = useSim();
  const { setFocus } = useUi();
  const st = state.status;
  const [tickMs, setTickMs] = useState(st?.tickMs ?? 1800);
  useEffect(() => {
    if (st?.tickMs) setTickMs(st.tickMs);
  }, [st?.tickMs]);

  const speed = (1000 / tickMs).toFixed(tickMs > 1000 ? 2 : 1);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden>◈</span>
        <div>
          <h1>{t.app.title}</h1>
          <p className="brand-sub">{t.app.subtitle}</p>
        </div>
      </div>

      <SeasonClock />

      <div className="controls">
        <PlayButton />
        <button className="ctl" onClick={() => actions.reset()} title={t.top.resetTitle}>{t.top.reset}</button>
        <label className="speed" title={t.top.speedTitle}>
          <span>{speed}{t.top.perSec}</span>
          <input
            type="range"
            min={config.minTickMs}
            max={config.maxTickMs}
            step={50}
            // slider right = faster
            value={config.maxTickMs + config.minTickMs - tickMs}
            onChange={(e) => setTickMs(config.maxTickMs + config.minTickMs - Number(e.target.value))}
            onPointerUp={() => actions.speed(tickMs)}
            onKeyUp={() => actions.speed(tickMs)}
          />
        </label>
        <button className="ctl" onClick={onOpenSetup}>{t.top.colony}</button>
        <button className="ctl" onClick={() => setFocus(true)} title={t.layout.focusTitle}>{t.layout.focus}</button>
      </div>

      <div className="pills">
        <span className={`pill provider ${st?.provider === 'mock' || transportKind === 'mock' ? 'is-mock' : ''}`} title={t.top.providerTitle}>
          {transportKind === 'mock' ? t.top.mockStream : st?.provider ?? '—'}
          {st?.model && <em>{st.model}</em>}
        </span>
        <LorebasePill />
        <span className={`pill conn conn-${state.conn}`}>{t.top.conn[state.conn] ?? state.conn}</span>
      </div>
    </header>
  );
}
