import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { lang, t } from './i18n';
import { SimProvider, useSim } from './state/store';
import { UiProvider, useUi } from './state/ui';
import { LorebasePill, PlayButton, SeasonClock, TopBar } from './components/TopBar';
import { WorldMap } from './components/WorldMap';
import { Roster } from './components/Roster';
import { AgentDrawer } from './components/AgentDrawer';
import { LawsPanel } from './components/LawsPanel';
import { EventFeed } from './components/EventFeed';
import { StatsChart, TierChart } from './components/Charts';
import { RuleBanner } from './components/RuleBanner';
import { ColonySetup } from './components/ColonySetup';
import { ResizeHandle } from './components/PanelChrome';

function FocusHud() {
  const { setFocus } = useUi();
  return (
    <>
      <div className="focus-hud left">
        <SeasonClock compact />
        <PlayButton />
      </div>
      <div className="focus-hud right">
        <LorebasePill />
        <button className="ctl" onClick={() => setFocus(false)}>{t.layout.exitFocus}</button>
      </div>
    </>
  );
}

function Shell() {
  const { state } = useSim();
  const { prefs, setSize } = useUi();
  const [setup, setSetup] = useState(false);
  const shownOnce = useRef(false);
  const { collapsed, focus } = prefs;

  useEffect(() => {
    document.title = t.app.docTitle;
    document.documentElement.lang = lang;
  }, []);

  // first load: open colony setup if the sim is idle
  useEffect(() => {
    if (shownOnce.current || !state.ready || !state.status) return;
    shownOnce.current = true;
    if (!state.status.running && state.tick === 0) setSetup(true);
  }, [state.ready, state.status, state.tick]);

  const lowerAllCollapsed = collapsed.feed && collapsed.vitals && collapsed.tiers;
  const vars = {
    '--laws-w': `${prefs.lawsW}px`,
    '--roster-w': `${prefs.rosterW}px`,
    '--lower-h': `${prefs.lowerH}px`,
  } as CSSProperties;

  return (
    <div className={`app season-${state.season} ${focus ? 'focus' : ''}`}>
      {!focus && <TopBar onOpenSetup={() => setSetup(true)} />}
      <main className={`layout ${collapsed.laws ? 'laws-collapsed' : ''} ${collapsed.roster ? 'roster-collapsed' : ''}`} style={vars}>
        <div className={`col-laws ${collapsed.laws ? 'is-collapsed' : ''}`}>
          <LawsPanel />
          {!collapsed.laws && <ResizeHandle axis="x" className="edge-right" onDelta={(d) => setSize('lawsW', prefs.lawsW + d)} />}
        </div>
        <div className="col-center">
          <div className="stage">
            <WorldMap />
            <RuleBanner />
            {focus && <FocusHud />}
          </div>
          <div className={`lower ${lowerAllCollapsed ? 'all-collapsed' : ''}`}>
            {!lowerAllCollapsed && <ResizeHandle axis="y" className="edge-top" onDelta={(d) => setSize('lowerH', prefs.lowerH - d)} />}
            <EventFeed />
            <StatsChart />
            <TierChart />
          </div>
        </div>
        <div className={`col-roster ${collapsed.roster ? 'is-collapsed' : ''}`}>
          {!collapsed.roster && <ResizeHandle axis="x" className="edge-left" onDelta={(d) => setSize('rosterW', prefs.rosterW - d)} />}
          <Roster />
          <AgentDrawer />
        </div>
      </main>
      {setup && <ColonySetup onClose={() => setSetup(false)} />}
    </div>
  );
}

export default function App() {
  return (
    <UiProvider>
      <SimProvider>
        <Shell />
      </SimProvider>
    </UiProvider>
  );
}
