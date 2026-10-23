import Phaser from 'phaser';
import { t } from './i18n';
import { connect } from './net/connect';
import { session } from './net/session';
import { setPortraitScene } from './render/portrait';
import { BootScene } from './scenes/BootScene';
import { WorldScene } from './scenes/WorldScene';
import { store } from './state/store';
import { mountOverlay } from './ui/overlay';

async function start(): Promise<void> {
  document.title = t('app.title');
  document.documentElement.lang = new URLSearchParams(location.search).get('lang') ?? 'it';
  // pixel fonts must be ready before anything measures text
  await Promise.race([
    Promise.all([document.fonts.load('10px "Press Start 2P"'), document.fonts.load('20px "VT323"')]),
    new Promise((r) => setTimeout(r, 1500)),
  ]).catch(() => undefined);

  mountOverlay();
  await waitForViewport();

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    pixelArt: true,
    roundPixels: true,
    backgroundColor: '#141c2c',
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    input: { keyboard: false },
    scene: [BootScene, WorldScene],
    banner: false,
  });
  game.events.once(Phaser.Core.Events.READY, () => {
    const scene = game.scene.getScene('boot');
    if (scene) setPortraitScene(scene);
  });

  if (new URLSearchParams(location.search).get('debug') === '1') Object.assign(window, { civ: { game, store } });

  const transport = await connect();
  session.transport = transport;
  transport.onStatus((s) => store.setStatus(s));
  transport.onMessage((m) => store.apply(m));
  if (transport.kind === 'ws') store.setStatus('online');
}

/** A zero-sized canvas breaks WebGL framebuffers: wait until the page has been laid out. */
async function waitForViewport(): Promise<void> {
  const host = document.getElementById('game')!;
  for (let i = 0; i < 300 && (host.clientWidth === 0 || host.clientHeight === 0); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

void start();
