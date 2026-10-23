import { mountChronicle } from './chronicle';
import { installControls } from './controls';
import { mountDialog } from './dialog';
import { mountGroupPanel } from './groupPanel';
import { mountHud } from './hud';
import { mountInspector } from './inspector';
import { mountJoin } from './join';
import { mountLaws } from './laws';
import { mountMinimap } from './minimap';
import './styles.css';

/** Mounts every DOM overlay component over the canvas. */
export function mountOverlay(): void {
  mountMinimap();
  mountChronicle();
  mountInspector();
  mountGroupPanel();
  mountLaws();
  mountDialog();
  const join = mountJoin();
  mountHud(() => join.show());
  installControls();
}
