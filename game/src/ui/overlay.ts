import { mountChronicle } from './chronicle';
import { mountConsciousness } from './consciousness';
import { mountDiscoveryBanner } from './discovery';
import { mountEconomy } from './economy';
import { installControls } from './controls';
import { mountDialog } from './dialog';
import { mountGodMode } from './god/godMode';
import { mountGroupPanel } from './groupPanel';
import { mountHud } from './hud';
import { mountInspector } from './inspector';
import { mountJoin } from './join';
import { mountLaws } from './laws';
import { mountMinimap } from './minimap';
import { mountSociety } from './society';
import './styles.css';

/** Mounts every DOM overlay component over the canvas. */
export function mountOverlay(): void {
  mountMinimap();
  mountChronicle();
  mountInspector();
  mountGroupPanel();
  mountLaws();
  mountConsciousness();
  mountEconomy();
  mountSociety();
  mountDiscoveryBanner();
  mountDialog();
  mountGodMode();
  const join = mountJoin();
  mountHud(() => join.show());
  installControls();
}
