import { useEffect, useState } from 'react';
import { t as tr } from '../i18n';
import { useSim } from '../state/store';
import { TIER_STYLE, roleStyle } from '../theme/tokens';
import { TIERS, type RosterEntry, type Tier } from '../types';
import { randomName } from '../lib/names';
import { RoleGlyph, TierMark } from './Glyphs';
import { useRosterInfo } from './Roster';

const MAX = 16;

const PRESETS: { label: string; counts: Record<Tier, number> }[] = [
  { opus: 3, sonnet: 0, haiku: 0 },
  { opus: 2, sonnet: 3, haiku: 3 },
  { opus: 0, sonnet: 0, haiku: 10 },
  { opus: 1, sonnet: 2, haiku: 5 },
].map((counts, i) => ({ label: tr.setup.presets[i], counts }));

function build(counts: Record<Tier, number>, roles: string[]): RosterEntry[] {
  const out: RosterEntry[] = [];
  let r = 0;
  for (const t of TIERS)
    for (let i = 0; i < counts[t]; i++) out.push({ name: randomName(out.map((o) => o.name)), role: roles[r++ % roles.length], tier: t });
  return out;
}

export function ColonySetup({ onClose }: { onClose(): void }) {
  const { actions } = useSim();
  const { roles, roster, info } = useRosterInfo();
  const [rows, setRows] = useState<RosterEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!rows.length && roster.length) setRows(roster.map((r) => ({ ...r })));
  }, [roster, rows.length]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const counts = Object.fromEntries(TIERS.map((t) => [t, rows.filter((r) => r.tier === t).length])) as Record<Tier, number>;
  const update = (i: number, patch: Partial<RosterEntry>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setCount = (t: Tier, n: number) =>
    setRows((rs) => {
      const cur = rs.filter((r) => r.tier === t).length;
      if (n > cur) {
        if (rs.length >= MAX) return rs;
        return [...rs, { name: randomName(rs.map((r) => r.name)), role: roles[rs.length % roles.length], tier: t }];
      }
      if (n < cur) {
        const idx = rs.map((r) => r.tier).lastIndexOf(t);
        return rs.filter((_, j) => j !== idx);
      }
      return rs;
    });

  const names = rows.map((r) => r.name.trim().toLowerCase());
  const dup = new Set(names.filter((n, i) => n && names.indexOf(n) !== i));
  const invalid = rows.length < 1 || rows.length > MAX || dup.size > 0 || names.some((n) => !n);

  const spawn = async () => {
    setBusy(true);
    setErr(null);
    const res = await actions.setRoster(rows.map((r) => ({ ...r, name: r.name.trim(), personality: r.personality?.trim() || undefined, model: r.model?.trim() || undefined })));
    setBusy(false);
    if (res.ok) onClose();
    else setErr(res.error ?? tr.setup.fail);
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={tr.setup.dialog} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{tr.setup.title}</h2>
            <p>{tr.setup.intro}</p>
          </div>
          <button className="chip-btn" onClick={onClose} aria-label={tr.setup.close}>✕</button>
        </header>

        <div className="tier-steppers">
          {TIERS.map((t) => (
            <div key={t} className={`stepper tier-${t}`}>
              <div className="st-name">
                <TierMark tier={t} size={14} /> {TIER_STYLE[t].label}
                <span className="cost" title={tr.setup.relCost}>{TIER_STYLE[t].cost}</span>
              </div>
              <div className="st-ctl">
                <button onClick={() => setCount(t, counts[t] - 1)} disabled={!counts[t]}>−</button>
                <b>{counts[t]}</b>
                <button onClick={() => setCount(t, counts[t] + 1)} disabled={rows.length >= MAX}>+</button>
              </div>
              <span className="st-model mono">{info?.models?.[t] ?? `${t}`}</span>
            </div>
          ))}
        </div>

        <div className="presets">
          {PRESETS.map((p) => (
            <button key={p.label} className="chip-btn" onClick={() => setRows(build(p.counts, roles))}>{p.label}</button>
          ))}
        </div>

        <div className="setup-table-wrap">
          <table className="setup-table">
            <thead>
              <tr><th /><th>{tr.setup.cols.name}</th><th>{tr.setup.cols.role}</th><th>{tr.setup.cols.tier}</th><th>{tr.setup.cols.personality}</th><th>{tr.setup.cols.model}</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={`tier-${r.tier}`}>
                  <td><RoleGlyph role={r.role} /></td>
                  <td className="name-cell">
                    <input value={r.name} onChange={(e) => update(i, { name: e.target.value })} className={dup.has(r.name.trim().toLowerCase()) || !r.name.trim() ? 'bad' : ''} maxLength={24} />
                    <button className="chip-btn" title={tr.setup.randomName} onClick={() => update(i, { name: randomName(rows.map((x) => x.name)) })}>⚄</button>
                  </td>
                  <td>
                    <select value={r.role} onChange={(e) => update(i, { role: e.target.value })}>
                      {roles.map((ro) => <option key={ro} value={ro}>{roleStyle(ro).label}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={r.tier} onChange={(e) => update(i, { tier: e.target.value as Tier })}>
                      {TIERS.map((t) => <option key={t} value={t}>{TIER_STYLE[t].label} {TIER_STYLE[t].cost}</option>)}
                    </select>
                  </td>
                  <td><input value={r.personality ?? ''} placeholder={tr.setup.optional} onChange={(e) => update(i, { personality: e.target.value })} maxLength={120} /></td>
                  <td><input value={r.model ?? ''} placeholder={info?.models?.[r.tier] ?? tr.setup.default} onChange={(e) => update(i, { model: e.target.value })} className="mono" /></td>
                  <td><button className="row-x" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={tr.setup.remove}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <footer className="modal-foot">
          <button className="chip-btn" disabled={rows.length >= MAX} onClick={() => setRows((rs) => [...rs, { name: randomName(rs.map((x) => x.name)), role: roles[rs.length % roles.length], tier: 'sonnet' }])}>{tr.setup.addSoul}</button>
          <span className="grow" />
          <span className={`count ${invalid ? 'bad' : ''}`}>{rows.length}/{MAX}{dup.size ? tr.setup.dup : ''}</span>
          {err && <span className="form-err">{err}</span>}
          <button className="ctl primary big" disabled={invalid || busy} onClick={spawn}>{busy ? tr.setup.spawning : tr.setup.spawn}</button>
        </footer>
      </div>
    </div>
  );
}
