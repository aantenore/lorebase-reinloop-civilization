// HTTP API: SSE event stream, simulation controls, roster, rules (written to Lorebase) and scenarios.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { ROOT, type RosterEntry } from '../config.ts';
import { loadScenarios } from '../lorebase/scenarios.ts';
import { writeRules } from '../lorebase/writer.ts';
import type { Simulation } from '../sim/sim.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};
const MAX_BODY = 256 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

export function createHttpServer(sim: Simulation): Server {
  const cfg = sim.cfg;
  const staticRoot = resolve(ROOT, cfg.http.staticDir);
  const writerCfg = cfg.lorebase;

  const cors = (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && cfg.http.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
  };
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const serveStatic = (path: string, res: ServerResponse): boolean => {
    if (!existsSync(staticRoot)) return false;
    let file = normalize(join(staticRoot, decodeURIComponent(path)));
    if (!file.startsWith(staticRoot)) return false;
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(staticRoot, 'index.html');
    if (!existsSync(file)) return false;
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
    return true;
  };

  const stream = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const write = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    write(sim.snapshot());
    const unsubscribe = sim.subscribe(write);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  };

  return createServer(async (req, res) => {
    cors(req, res);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    try {
      if (method === 'OPTIONS') return void res.writeHead(204).end();
      if (method === 'GET' && path === '/api/stream') return stream(req, res);
      if (method === 'GET' && path === '/api/status') return send(res, 200, sim.status());
      if (method === 'POST' && path === '/api/sim/start') return (sim.start(), send(res, 200, { ok: true, status: sim.status() }));
      if (method === 'POST' && path === '/api/sim/pause') return (sim.pause(), send(res, 200, { ok: true, status: sim.status() }));
      if (method === 'POST' && path === '/api/sim/reset') {
        const body = (await readJson(req)) as { seed?: unknown };
        const seed = body.seed === undefined || body.seed === null ? undefined : Number(body.seed);
        if (seed !== undefined && !Number.isInteger(seed)) return send(res, 400, { ok: false, error: 'seed must be an integer' });
        await sim.reset(seed);
        return send(res, 200, { ok: true, status: sim.status() });
      }
      if (method === 'POST' && path === '/api/sim/speed') {
        const { tickMs } = (await readJson(req)) as { tickMs?: unknown };
        const n = Number(tickMs);
        if (!Number.isFinite(n) || n < 0) return send(res, 400, { ok: false, error: 'tickMs must be a non-negative number' });
        sim.setSpeed(n);
        return send(res, 200, { ok: true, status: sim.status() });
      }
      if (method === 'GET' && path === '/api/roster') return send(res, 200, sim.rosterView());
      if (method === 'PUT' && path === '/api/roster') {
        const { agents } = (await readJson(req)) as { agents?: RosterEntry[] };
        const error = await sim.setRoster(agents as RosterEntry[]);
        return send(res, error ? 400 : 200, error ? { ok: false, error } : { ok: true });
      }
      if (method === 'POST' && path === '/api/agents') {
        const out = sim.addAgent((await readJson(req)) as RosterEntry);
        return send(res, out.error ? 400 : 201, out.error ? { ok: false, error: out.error } : { ok: true, agent: out.agent });
      }
      const del = /^\/api\/agents\/([^/]+)$/.exec(path);
      if (method === 'DELETE' && del) {
        const ok = sim.removeAgent(decodeURIComponent(del[1]!));
        return send(res, ok ? 200 : 404, ok ? { ok } : { ok, error: 'no living agent with that id' });
      }
      if (method === 'GET' && path === '/api/rules') return send(res, 200, { revision: sim.status().lorebase.revision, rules: sim.rules() });
      if (method === 'POST' && path === '/api/rules') {
        const body = (await readJson(req)) as { key?: string; value?: unknown; mode?: string; message?: string };
        if (!body.key || !sim.rules().some((r) => r.key === body.key)) return send(res, 400, { ok: false, error: `unknown rule "${body.key}"` });
        const mode = body.mode === 'proposal' ? 'proposal' : 'direct';
        const message = body.message?.trim() || `Set ${body.key} to ${body.value}`;
        const out = await writeRules(sim.client, writerCfg, [{ key: body.key, value: Number(body.value) }], mode, message);
        return send(res, out.ok ? 200 : 502, out);
      }
      if (method === 'GET' && path === '/api/scenarios') return send(res, 200, { scenarios: loadScenarios() });
      const sc = /^\/api\/scenarios\/([^/]+)\/apply$/.exec(path);
      if (method === 'POST' && sc) {
        const scenario = loadScenarios().find((s) => s.name === decodeURIComponent(sc[1]!));
        if (!scenario) return send(res, 404, { ok: false, error: 'unknown scenario' });
        const out = await writeRules(sim.client, writerCfg, scenario.changes, 'proposal', `Scenario: ${scenario.title}`, scenario.title);
        return send(res, out.ok ? 200 : 502, out);
      }
      if (path.startsWith('/api/')) return send(res, 404, { ok: false, error: 'not found' });
      if (method === 'GET' && serveStatic(path, res)) return;
      send(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) send(res, err instanceof SyntaxError ? 400 : 500, { ok: false, error: message });
    }
  });
}
