// One command for the real-time world: makes sure Herald (Lorebase MCP server, docker) is up,
// starts mnemo (private memory service) and the game server, and stops what it started on exit.
// Lorebase itself (Keeper + Postgres) stays separate: npm run lorebase:up.
// Arguments are passed to the game server (e.g. --mock, --seconds 30).
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadGameConfig } from '../server/src/rt/config.ts';

const ROOT = resolve(import.meta.dirname, '..');
// Secrets stay in the environment; children inherit them.
if (existsSync(resolve(ROOT, '.env'))) process.loadEnvFile(resolve(ROOT, '.env'));
if (process.env.MNEMO_PORT && process.env.MNEMO_URL === undefined) process.env.MNEMO_URL = `http://127.0.0.1:${process.env.MNEMO_PORT}`;
const cfg = loadGameConfig();
const svc = cfg.services;
const children: ChildProcess[] = [];
let heraldStarted = false;

async function heraldUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}', signal: AbortSignal.timeout(3000) });
    return [200, 400, 401, 406].includes(res.status);
  } catch {
    return false;
  }
}

if (svc.herald.autoStart && cfg.brain.mcpUrl) {
  if (await heraldUp(cfg.brain.mcpUrl)) console.log(`[run] Herald already up at ${cfg.brain.mcpUrl}`);
  else {
    console.log('[run] starting Herald');
    const out = spawnSync('bash', [resolve(ROOT, svc.herald.script), 'up'], { stdio: 'inherit', env: process.env });
    if (out.status === 0) heraldStarted = true;
    else console.warn('[run] Herald did not start: agents will have no Lorebase tools until it is up (npm run herald:up)');
  }
}

if (svc.mnemo.autoStart && cfg.memory.enabled && cfg.memory.url) {
  const health = `${cfg.memory.url.replace(/\/+$/, '')}/health`;
  const up = await fetch(health, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  if (up) console.log(`[run] mnemo already up at ${cfg.memory.url}`);
  else {
    const port = new URL(cfg.memory.url).port;
    const child = spawn(process.execPath, [resolve(ROOT, svc.mnemo.entry)], { stdio: 'inherit', env: { ...process.env, ...(port ? { MNEMO_PORT: port } : {}) } });
    children.push(child);
    console.log(`[run] mnemo starting on ${cfg.memory.url} (the first start downloads the embedding model)`);
  }
}

const game = spawn(process.execPath, [resolve(ROOT, 'server/src/game-main.ts'), ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
children.push(game);

let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  if (heraldStarted && svc.herald.stopOnExit) spawnSync('bash', [resolve(ROOT, svc.herald.script), 'down'], { stdio: 'inherit' });
  setTimeout(() => process.exit(code), 1500).unref();
}
game.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
