import { useMemo, useRef, useState } from 'react';
import { useSim } from '../state/store';
import type { RuleMarker } from '../state/reducer';
import { CHART_SERIES, TIER_STYLE } from '../theme/tokens';
import { TIERS, type Stats } from '../types';
import { ruleLabel, t } from '../i18n';
import { useUi } from '../state/ui';
import { PanelHead, panelClass } from './PanelChrome';

// Hand-made SVG small multiples sharing one x (tick) axis.
// One y-scale per panel (never dual-axis); vertical markers at rule-change ticks.

interface Series {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
}

const W = 320;
const H = 58;
const PAD = { l: 30, r: 34, t: 6, b: 4 };

function useHover() {
  const [hover, setHover] = useState<number | null>(null);
  return { hover, setHover };
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function Multiple({
  title,
  series,
  ticks,
  markers,
  hover,
  onHover,
  showAxis,
  legend,
}: {
  title: string;
  series: Series[];
  ticks: number[];
  markers: RuleMarker[];
  hover: number | null;
  onHover(i: number | null): void;
  showAxis?: boolean;
  legend?: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const n = ticks.length;
  const t0 = ticks[0] ?? 0;
  const t1 = ticks[n - 1] ?? 1;
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values.filter((v): v is number => v != null))));
  const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);

  const paths = series.map((s) => {
    let d = '';
    s.values.forEach((v, i) => {
      if (v == null) return;
      d += `${d ? 'L' : 'M'}${x(ticks[i]).toFixed(1)},${y(v).toFixed(1)}`;
    });
    return d;
  });

  const move = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const t = t0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (t1 - t0);
    let best = 0;
    let bd = Infinity;
    ticks.forEach((tk, i) => {
      const d = Math.abs(tk - t);
      if (d < bd) { bd = d; best = i; }
    });
    onHover(n ? best : null);
  };

  const hi = hover != null && hover < n ? hover : null;
  const last = n - 1;

  return (
    <figure className="mult">
      <figcaption>
        <span className="mult-title">{title}</span>
        {legend && (
          <span className="legend">
            {series.map((s) => (
              <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>
            ))}
          </span>
        )}
        <span className="mult-val">
          {series.length === 1
            ? fmt(series[0].values[hi ?? last])
            : hi != null
              ? series.map((s) => `${s.label} ${fmt(s.values[hi])}`).join(' · ')
              : ''}
          {hi != null && <em> {t.feed.tickPrefix}{ticks[hi]}</em>}
        </span>
      </figcaption>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onPointerMove={move} onPointerLeave={() => onHover(null)} role="img" aria-label={title}>
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} className="axis" />
        <line x1={PAD.l} x2={W - PAD.r} y1={y(max / 2)} y2={y(max / 2)} className="grid" />
        <text x={PAD.l - 4} y={y(max) + 6} className="ytick" textAnchor="end">{fmt(max)}</text>
        <text x={PAD.l - 4} y={y(0)} className="ytick" textAnchor="end">0</text>
        {markers.map((m) => m.tick >= t0 && m.tick <= t1 && (
          <g key={m.revision} className="marker">
            <line x1={x(m.tick)} x2={x(m.tick)} y1={PAD.t - 4} y2={H} />
            {showAxis && <title>{`${t.charts.rev} ${m.revision}: ${m.changes.map((c) => `${ruleLabel(c.key)} ${c.old}→${c.new}`).join(', ')}`}</title>}
          </g>
        ))}
        {paths.map((d, i) => d && <path key={series[i].key} d={d} className="line" style={{ stroke: series[i].color }} vectorEffect="non-scaling-stroke" />)}
        {/* direct end labels for multi-series (<=4) */}
        {series.length > 1 && series.map((s) => {
          const v = s.values[last];
          return v == null ? null : (
            <text key={s.key} x={W - PAD.r + 3} y={y(v) + 3} className="endlabel">{fmt(v)}</text>
          );
        })}
        {hi != null && (
          <g className="cross">
            <line x1={x(ticks[hi])} x2={x(ticks[hi])} y1={PAD.t} y2={H} />
            {series.map((s) => s.values[hi] != null && (
              <circle key={s.key} cx={x(ticks[hi])} cy={y(s.values[hi]!)} r={3.2} style={{ fill: s.color }} />
            ))}
          </g>
        )}
      </svg>
    </figure>
  );
}

const fmt = (v: number | null | undefined) => (v == null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(1));

function window_(history: Stats[], max = 160) {
  return history.length > max ? history.slice(-max) : history;
}

export function StatsChart() {
  const { state } = useSim();
  const { hover, setHover } = useHover();
  const { prefs } = useUi();
  const h = window_(state.history);
  const ticks = h.map((s) => s.tick);
  const panels = (['population', 'food', 'wood', 'avgHp'] as const).map((k) => ({
    key: k,
    title: CHART_SERIES[k].label,
    series: [{ key: k, label: CHART_SERIES[k].label, color: CHART_SERIES[k].color, values: h.map((s) => s[k]) }],
  }));
  return (
    <section className={panelClass('chart vitals', prefs.collapsed.vitals)}>
      <PanelHead id="vitals" title={t.charts.vital}>
        <span className="sub"><i className="marker-key" /> {t.charts.lawChanged}</span>
      </PanelHead>
      <div className="mults">
        {panels.map((p, i) => (
          <Multiple key={p.key} title={p.title} series={p.series} ticks={ticks} markers={state.markers} hover={hover} onHover={setHover} showAxis={i === 0} />
        ))}
      </div>
    </section>
  );
}

export function TierChart() {
  const { state } = useSim();
  const { hover, setHover } = useHover();
  const { prefs } = useUi();
  const h = window_(state.history);
  const has = h.some((s) => s.byTier);
  // fall back to deriving current alive/avgHp from agents if backend omits byTier
  const derived = useMemo(() => {
    const out: Record<string, { alive: number; total: number; avgHp: number }> = {};
    for (const tier of TIERS) {
      const g = Object.values(state.agents).filter((a) => a.tier === tier);
      const alive = g.filter((a) => a.alive);
      out[tier] = { alive: alive.length, total: g.length, avgHp: alive.length ? Math.round(alive.reduce((s, a) => s + a.hp, 0) / alive.length) : 0 };
    }
    return out;
  }, [state.agents]);
  const ticks = h.map((s) => s.tick);
  const mk = (field: 'alive' | 'avgHp') =>
    TIERS.map((tier) => ({ key: tier, label: TIER_STYLE[tier].label, color: TIER_STYLE[tier].chart, values: h.map((s) => s.byTier?.[tier]?.[field] ?? null) }));

  return (
    <section className={panelClass('chart tierchart', prefs.collapsed.tiers)}>
      <PanelHead id="tiers" title={t.charts.tierTitle} />
      <div className="tier-tiles">
        {TIERS.map((tier) => (
          <div key={tier} className={`tier-tile tier-${tier}`}>
            <span className="tt-name"><i style={{ background: TIER_STYLE[tier].chart }} />{TIER_STYLE[tier].label}</span>
            <b>{derived[tier].alive}<small>/{derived[tier].total}</small></b>
            <span className="tt-hp">{t.charts.hp} {derived[tier].avgHp}</span>
          </div>
        ))}
      </div>
      {has ? (
        <div className="mults">
          <Multiple title={t.charts.alive} series={mk('alive')} ticks={ticks} markers={state.markers} hover={hover} onHover={setHover} legend />
          <Multiple title={t.charts.avgHp} series={mk('avgHp')} ticks={ticks} markers={state.markers} hover={hover} onHover={setHover} />
        </div>
      ) : (
        <p className="empty">{t.charts.waiting}</p>
      )}
    </section>
  );
}
