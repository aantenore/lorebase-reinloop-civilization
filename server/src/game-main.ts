// Real-time world server: `node server/src/game-main.ts [--mock] [--seconds N]`.
// REST endpoints (rules, scenarios, roster, status, SSE mirror) and the WebSocket `/ws`.
import { loadConfig } from './config.ts';
import { createHttpServer } from './http/server.ts';
import { attachWebSocket } from './http/ws.ts';
import { loadGameConfig } from './rt/config.ts';
import { Game } from './rt/game.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const cfg = loadConfig(argv);
const gameCfg = loadGameConfig();
const seconds = Number(flag('--seconds') ?? 0);

const game = new Game(cfg, gameCfg);
const server = createHttpServer(game);
const wss = attachWebSocket(server, { path: gameCfg.ws.path, maxPayloadBytes: gameCfg.ws.maxPayloadBytes, port: cfg.http.port, corsOrigins: cfg.http.corsOrigins, apiToken: cfg.apiToken, allowedHosts: cfg.http.allowedHosts }, {
  open: (c) => game.onOpen(c),
  message: (c, m) => game.onMessage(c, m),
  close: (c) => game.onClose(c),
});

server.listen(cfg.http.port, cfg.http.host, () => {
  console.log(`real-time world on http://${cfg.http.host}:${cfg.http.port} (ws ${gameCfg.ws.path}, provider ${game.mock ? 'mock (offline fallback)' : 'anthropic'}${cfg.modelOverride ? `, all agents on ${cfg.modelOverride}` : ''}${cfg.apiToken ? ', token required' : ''})`);
});

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await game.shutdown();
  for (const c of wss.clients) c.terminate();
  server.closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

await game.init();
if (seconds > 0) setTimeout(() => void stop(), seconds * 1000);
