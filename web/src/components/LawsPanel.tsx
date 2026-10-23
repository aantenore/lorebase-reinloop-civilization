import { useEffect, useMemo, useState } from 'react';
import { categoryLabel, ruleLabel, t } from '../i18n';
import { useSim } from '../state/store';
import { useUi } from '../state/ui';
import { PanelHead, panelClass } from './PanelChrome';
import type { PendingRule } from '../state/reducer';
import type { Rule, RuleMode, Scenario } from '../types';

const FLASH_MS = 7000;
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 1 ? 2 : 1));

function useNow(active: boolean, ms = 500) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

export function LawsPanel() {
  const { state, actions } = useSim();
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenarioBusy, setScenarioBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { prefs } = useUi();

  useEffect(() => {
    actions.scenarios().then(setScenarios);
  }, [actions]);

  const hasFlash = Object.values(state.ruleFlash).some((f) => Date.now() - f.at < FLASH_MS);
  const now = useNow(hasFlash || Object.keys(state.pending).length > 0);

  const groups = useMemo(() => {
    const m = new Map<string, Rule[]>();
    for (const r of state.rules) {
      const k = r.category || 'other';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return [...m.entries()];
  }, [state.rules]);

  return (
    <section className={panelClass('laws', prefs.collapsed.laws)}>
      <PanelHead id="laws" title={t.laws.title}>
        <span className="sub">{t.laws.sub}</span>
      </PanelHead>
      {scenarios.length > 0 && (
        <div className="scenarios">
          <span className="sc-label">{t.laws.decree}</span>
          {scenarios.map((s) => (
            <button
              key={s.name}
              className="scenario"
              disabled={scenarioBusy !== null}
              title={`${s.description}\n${s.changes.map((c) => `${c.key} → ${c.value}`).join('\n')}`}
              onClick={async () => {
                setScenarioBusy(s.name);
                setError(null);
                const res = await actions.applyScenario(s);
                setScenarioBusy(null);
                if (!res.ok) setError(res.error ?? t.laws.scenarioFail);
              }}
            >
              <b>{s.title}</b>
              <span>{s.description}</span>
              {scenarioBusy === s.name && <i className="sc-busy">{t.laws.sending}</i>}
            </button>
          ))}
        </div>
      )}
      {error && <p className="form-err">{error}</p>}
      <div className="law-groups">
        {groups.map(([cat, rules]) => (
          <div className="law-group" key={cat}>
            <h3 className="law-cat">{categoryLabel(cat)}</h3>
            {rules.map((r) => (
              <LawCard key={r.key} rule={r} flash={state.ruleFlash[r.key]} pending={state.pending[r.key]} error={state.ruleErrors[r.key]} now={now} />
            ))}
          </div>
        ))}
        {!state.rules.length && <p className="empty">{t.laws.empty}</p>}
      </div>
    </section>
  );
}

function LawCard({ rule, flash, pending, error, now }: { rule: Rule; flash?: { old: number; new: number; at: number }; pending?: PendingRule; error?: string; now: number }) {
  const { actions } = useSim();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(rule.value));
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<RuleMode>('proposal');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const flashing = flash && now - flash.at < FLASH_MS;
  const up = flash && flash.new > flash.old;

  useEffect(() => {
    if (!editing) setValue(String(rule.value));
  }, [rule.value, editing]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = Number(value);
    if (!Number.isFinite(v)) return setErr(t.laws.notNumber);
    if (v === rule.value) return setErr(t.laws.same);
    setBusy(true);
    setErr(null);
    const res = await actions.writeRule(rule.key, v, mode, message || t.laws.defaultMsg(rule.key, v));
    setBusy(false);
    if (!res.ok) setErr(res.error ?? t.laws.writeFail);
    else {
      setEditing(false);
      setMessage('');
    }
  };

  return (
    <article className={`law ${flashing ? (up ? 'flash up' : 'flash down') : ''} ${pending ? 'pending' : ''}`}>
      <div className="law-top">
        <span className="law-key" title={rule.key}>{ruleLabel(rule.key)}</span>
        <span className="law-value">
          {flashing && <s className="law-old">{fmt(flash!.old)}</s>}
          <b>{fmt(rule.value)}</b>
          <small>{rule.unit}</small>
        </span>
      </div>
      <p className="law-text">{rule.text}</p>
      {pending && (
        <div className="law-pending">
          <span className="spinner" />
          {pending.mode === 'proposal' ? (
            <ProposalSteps pending={pending} now={now} />
          ) : (
            <span>{t.laws.committing} <b>{fmt(pending.value)}</b>…</span>
          )}
        </div>
      )}
      {error && !pending && <p className="form-err">{error}</p>}
      {!pending && !editing && (
        <button className="law-edit" onClick={() => setEditing(true)}>{t.laws.amend}</button>
      )}
      {editing && !pending && (
        <form className="law-form" onSubmit={submit}>
          <div className="row">
            <input className="num" type="number" step="any" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
            <input className="msg" placeholder={t.laws.commitPh} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={140} />
          </div>
          <div className="row">
            <div className="seg small">
              <button type="button" className={`seg-btn ${mode === 'direct' ? 'on' : ''}`} onClick={() => setMode('direct')}>{t.laws.direct}</button>
              <button type="button" className={`seg-btn ${mode === 'proposal' ? 'on' : ''}`} onClick={() => setMode('proposal')}>{t.laws.proposal}</button>
            </div>
            <span className="grow" />
            <button type="button" className="chip-btn" onClick={() => { setEditing(false); setErr(null); }}>{t.laws.cancel}</button>
            <button className="ctl primary" disabled={busy}>{busy ? '…' : t.laws.enact}</button>
          </div>
          {err && <p className="form-err">{err}</p>}
        </form>
      )}
    </article>
  );
}

function ProposalSteps({ pending, now }: { pending: PendingRule; now: number }) {
  const el = (now - pending.since) / 1000;
  const step = pending.proposalId ? (el > 1.2 ? 2 : 1) : 0;
  const steps = t.laws.steps;
  return (
    <span className="steps">
      {steps.map((s, i) => (
        <span key={s} className={`step ${i < step ? 'done' : i === step ? 'cur' : ''}`}>{s}</span>
      ))}
      <span className="pend-val">→ {fmt(pending.value)}</span>
      {pending.proposalId && <code>{pending.proposalId}</code>}
    </span>
  );
}
