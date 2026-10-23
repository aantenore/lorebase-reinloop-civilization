// HTTP API: SSE event stream, simulation controls, roster, rules (written to Lorebase) and scenarios.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { ROOT, type RosterEntry, type SimConfig } from '../config.ts';
import type { LorebaseClient } from '../lorebase/client.ts';
import type { Rule } from '../lorebase/rules.ts';
import { loadScenarios } from '../lorebase/scenarios.ts';
import { amendRule, createRule, repealRule, writeRules } from '../lorebase/writer.ts';
import { allowedOrigins, bearer, checkMutation, hostAllowed, isMutation, tokenMatches } from './security.ts';

/** What the HTTP API needs from a world: the tick simulation (v1) or the real-time game (v2). */
export interface HttpHost {
  readonly cfg: SimConfig;
  readonly client: LorebaseClient;
  status(): { lorebase: { revision: string } };
  rules(): Rule[];
  snapshot(): unknown;
  subscribe(fn: (ev: unknown) => void): () => void;
  rosterView(): unknown;
  setRoster(entries: RosterEntry[]): Promise<string | undefined>;
  addAgent(entry: RosterEntry): { agent?: unknown; error?: string };
  removeAgent(id: string): boolean;
  start?(): void;
  pause?(): void;
  reset?(seed?: number): Promise<void>;
  setSpeed?(tickMs: number): void;
  insightList?(role?: string): Promise<unknown>;
  consciousness?(): Promise<unknown>;
  economyView?(): unknown;
  memories?(id: string): Promise<unknown[] | undefined>;
  observatory?(path: string, q: URLSearchParams): Promise<{ status: number; body: unknown } | undefined>;
  conversations?(q: URLSearchParams): Promise<unknown[]>;
  mind?(id: string): Promise<unknown | undefined>;
  /** Society: people, families, opinions (only for privileged callers). */
  societyView?(privileged: boolean): unknown;
  /** Laws proposed by agents and the human decision on them. */
  lawProposals?(): unknown[];
  decideLawProposal?(id: string, verdict: 'approve' | 'reject', note: string): Promise<unknown>;
  /** Law keys the engine needs: they can be changed but not repealed. */
  engineKeys?(): readonly string[];
}

const CATEGORIES = ['survival', 'economy', 'climate', 'society', 'time'];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};
class BodyTooLarge extends Error {}

async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new BodyTooLarge('body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

export function createHttpServer(sim: HttpHost): Server {
  const cfg = sim.cfg;
  const staticRoot = resolve(ROOT, cfg.http.staticDir);
  const writerCfg = cfg.lorebase;
  const guard = { port: cfg.http.port, corsOrigins: cfg.http.corsOrigins, apiToken: cfg.apiToken, allowedHosts: cfg.http.allowedHosts };
  const origins = allowedOrigins(guard);
  const readBody = (req: IncomingMessage) => readJson(req, cfg.http.maxBodyBytes);

  const cors = (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
      if (!hostAllowed(req.headers.host, guard)) return send(res, 403, { ok: false, error: 'host not allowed' });
      if (method === 'OPTIONS') return void res.writeHead(204).end();
      if (path.startsWith('/api/') && isMutation(method)) {
        const refused = checkMutation(req, guard);
        if (refused) return send(res, refused.status, { ok: false, error: refused.error });
      }
      // God mode reads (minds, memories, conversations, observatory) need the token too when one is set.
      if (method === 'GET' && guard.apiToken && /^\/api\/(stream$|conversations|observatory\/|agents\/[^/]+\/(mind|memories))/.test(path) && !tokenMatches(bearer(req), guard.apiToken)) {
        return send(res, 401, { ok: false, error: 'missing or invalid token' });
      }
      if (method === 'GET' && path === '/api/conversations') return sim.conversations ? send(res, 200, await sim.conversations(url.searchParams)) : unsupported();
      const mind = method === 'GET' ? /^\/api\/agents\/([^/]+)\/mind$/.exec(path) : null;
      if (mind) {
        if (!sim.mind) return unsupported();
        const out = await sim.mind(decodeURIComponent(mind[1]!));
        return out ? send(res, 200, out) : send(res, 404, { ok: false, error: 'no such agent' });
      }
      const ruleKey = /^\/api\/rules\/([a-z][a-z0-9_]*)$/.exec(path);
      if (ruleKey && (method === 'DELETE' || method === 'PATCH')) {
        const key = ruleKey[1]!;
        const rule = sim.rules().find((r) => r.key === key);
        if (!rule) return send(res, 404, { ok: false, error: `unknown rule "${key}"` });
        if (method === 'DELETE') {
          if (sim.engineKeys?.().includes(key)) return send(res, 409, { ok: false, error: `"${key}" is a law the world's physics needs: change its value instead` });
          const mode = url.searchParams.get('mode') === 'proposal' ? 'proposal' : 'direct';
          const out = await repealRule(sim.client, writerCfg, key, mode, url.searchParams.get('message')?.slice(0, 200) || `Repeal ${key}`);
          return send(res, out.ok ? 200 : 502, out);
        }
        const body = (await readBody(req)) as { text?: string; category?: string; unit?: string; mode?: string; message?: string };
        const category = body.category ?? rule.category;
        if (!CATEGORIES.includes(String(category))) return send(res, 400, { ok: false, error: `category must be one of ${CATEGORIES.join(', ')}` });
        const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim().slice(0, 1000) : rule.text;
        const unit = typeof body.unit === 'string' ? body.unit.slice(0, 40) : rule.unit || undefined;
        const out = await amendRule(sim.client, writerCfg, { key, text, category: String(category), unit }, body.mode === 'proposal' ? 'proposal' : 'direct', body.message?.trim() || `Amend ${key}`);
        return send(res, out.ok ? 200 : 502, out);
      }
      const unsupported = () => send(res, 404, { ok: false, error: 'not supported in this mode' });
      if (method === 'GET' && path === '/api/stream') return stream(req, res);
      if (method === 'GET' && path === '/api/status') return send(res, 200, sim.status());
      if (method === 'POST' && path === '/api/sim/start') return sim.start ? (sim.start(), send(res, 200, { ok: true, status: sim.status() })) : unsupported();
      if (method === 'POST' && path === '/api/sim/pause') return sim.pause ? (sim.pause(), send(res, 200, { ok: true, status: sim.status() })) : unsupported();
      if (method === 'POST' && path === '/api/sim/reset') {
        if (!sim.reset) return unsupported();
        const body = (await readBody(req)) as { seed?: unknown };
        const seed = body.seed === undefined || body.seed === null ? undefined : Number(body.seed);
        if (seed !== undefined && !Number.isInteger(seed)) return send(res, 400, { ok: false, error: 'seed must be an integer' });
        await sim.reset(seed);
        return send(res, 200, { ok: true, status: sim.status() });
      }
      if (method === 'POST' && path === '/api/sim/speed') {
        if (!sim.setSpeed) return unsupported();
        const { tickMs } = (await readBody(req)) as { tickMs?: unknown };
        const n = Number(tickMs);
        if (!Number.isFinite(n) || n < 0) return send(res, 400, { ok: false, error: 'tickMs must be a non-negative number' });
        sim.setSpeed(n);
        return send(res, 200, { ok: true, status: sim.status() });
      }
      if (method === 'GET' && path === '/api/roster') return send(res, 200, sim.rosterView());
      if (method === 'PUT' && path === '/api/roster') {
        const { agents } = (await readBody(req)) as { agents?: RosterEntry[] };
        const error = await sim.setRoster(agents as RosterEntry[]);
        return send(res, error ? 400 : 200, error ? { ok: false, error } : { ok: true });
      }
      if (method === 'POST' && path === '/api/agents') {
        const out = sim.addAgent((await readBody(req)) as RosterEntry);
        return send(res, out.error ? 400 : 201, out.error ? { ok: false, error: out.error } : { ok: true, agent: out.agent });
      }
      const del = /^\/api\/agents\/([^/]+)$/.exec(path);
      if (method === 'DELETE' && del) {
        const ok = sim.removeAgent(decodeURIComponent(del[1]!));
        return send(res, ok ? 200 : 404, ok ? { ok } : { ok, error: 'no living agent with that id' });
      }
      if (method === 'GET' && path === '/api/rules') return send(res, 200, { revision: sim.status().lorebase.revision, rules: sim.rules() });
      if (method === 'GET' && path === '/api/insights') return sim.insightList ? send(res, 200, await sim.insightList(url.searchParams.get('role') ?? undefined)) : unsupported();
      if (method === 'GET' && path.startsWith('/api/observatory/')) {
        const out = sim.observatory ? await sim.observatory(path, url.searchParams) : undefined;
        return out ? send(res, out.status, out.body) : unsupported();
      }
      if (method === 'GET' && path === '/api/society') {
        if (!sim.societyView) return unsupported();
        return send(res, 200, sim.societyView(!guard.apiToken || tokenMatches(bearer(req), guard.apiToken)));
      }
      if (method === 'GET' && path === '/api/law-proposals') return sim.lawProposals ? send(res, 200, sim.lawProposals()) : unsupported();
      const lawDecision = method === 'POST' ? /^\/api\/law-proposals\/([^/]+)\/(approve|reject)$/.exec(path) : null;
      if (lawDecision) {
        if (!sim.decideLawProposal) return unsupported();
        const body = (await readBody(req)) as { message?: string };
        const note = typeof body.message === 'string' && body.message.trim() ? body.message.trim().slice(0, 200) : `${lawDecision[2]} from god mode`;
        const out = await sim.decideLawProposal(decodeURIComponent(lawDecision[1]!), lawDecision[2] as 'approve' | 'reject', note);
        return typeof out === 'string' ? send(res, out === 'unknown' ? 404 : 502, { ok: false, error: out }) : send(res, 200, { ok: true, proposal: out });
      }
      if (method === 'GET' && path === '/api/economy') return sim.economyView ? send(res, 200, sim.economyView()) : unsupported();
      const mem = method === 'GET' ? /^\/api\/agents\/([^/]+)\/memories$/.exec(path) : null;
      if (mem) {
        if (!sim.memories) return unsupported();
        const list = await sim.memories(decodeURIComponent(mem[1]!));
        return list ? send(res, 200, list) : send(res, 404, { ok: false, error: 'no such agent' });
      }
      if (method === 'GET' && path === '/api/consciousness') return sim.consciousness ? send(res, 200, await sim.consciousness()) : unsupported();
      if (method === 'POST' && path === '/api/rules') {
        const body = (await readBody(req)) as { key?: string; value?: unknown; mode?: string; message?: string; text?: string; category?: string; unit?: string };
        const mode = body.mode === 'proposal' ? 'proposal' : 'direct';
        if (body.key && !sim.rules().some((r) => r.key === body.key) && typeof body.text === 'string') {
          // A brand-new law: engine keys get physics, any other key is a law people read and may follow.
          if (!CATEGORIES.includes(String(body.category))) return send(res, 400, { ok: false, error: `category must be one of ${CATEGORIES.join(', ')}` });
          const value = body.value === undefined || body.value === null || body.value === '' ? 1 : Number(body.value);
          const message = body.message?.trim() || `New law ${body.key}`;
          const out = await createRule(sim.client, writerCfg, { key: body.key, value, text: body.text.slice(0, 1000), category: String(body.category), unit: typeof body.unit === 'string' ? body.unit.slice(0, 40) : undefined }, mode, message);
          return send(res, out.ok ? 201 : 502, out);
        }
        if (!body.key || !sim.rules().some((r) => r.key === body.key)) return send(res, 400, { ok: false, error: `unknown rule "${body.key}" (to create a law, send text and category)` });
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
      if (!res.headersSent) send(res, err instanceof BodyTooLarge ? 413 : err instanceof SyntaxError ? 400 : 500, { ok: false, error: message });
    }
  });
}
