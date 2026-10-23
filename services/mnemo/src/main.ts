// mnemo HTTP entry point: JSON-only API over node:http, bound to the configured host (loopback by
// default). Wires config, store, embedder (with automatic fallback) and rewriter, starts the
// compaction timer and closes the database on SIGINT/SIGTERM.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig, loadEnvFile } from './config.ts';
import { createEmbedder } from './embed.ts';
import { AnthropicClient, AnthropicRewriter, HeuristicRewriter, type LlmStats, type Rewriter } from './llm.ts';
import { MnemoService } from './service.ts';
import { Store } from './store.ts';

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const EVENTS_DEFAULT_LIMIT = 500;
const EVENTS_MAX_LIMIT = 5000;

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'content-type must be application/json');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > max) throw new HttpError(413, 'body too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v === '') throw new HttpError(400, `${name} must be a non-empty string`);
  return v;
};
const optNum = (v: unknown, name: string): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, `${name} must be a number`);
  return v;
};

async function main(): Promise<void> {
  loadEnvFile();
  const cfg = loadConfig();
  const key = process.env.ANTHROPIC_API_KEY;
  const client = cfg.llm.provider === 'anthropic' && key ? new AnthropicClient(key, process.env.ANTHROPIC_WORKSPACE_ID || undefined, cfg.llm.timeoutMs) : undefined;
  const rewriter: Rewriter = client ? new AnthropicRewriter(client, cfg) : new HeuristicRewriter(cfg.llm.heuristicMergeChars);
  const llmStats = (): LlmStats => client?.stats ?? { provider: 'heuristic', calls: 0, inputTokens: 0, outputTokens: 0 };

  const store = new Store(cfg);
  const choice = await createEmbedder(cfg, client);
  const svc = new MnemoService({ cfg, store, embedder: choice.embedder, rewriter, textModel: client });
  const reembedded = await svc.reembedStale();
  if (reembedded > 0) console.log(`mnemo: re-embedded ${reembedded} memories with ${choice.embedder.name}`);
  const maxBody = cfg.http.maxBodyBytes;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? 'GET';
    const q = url.searchParams;
    const ns = q.get('ns') ?? undefined;
    const checkNs = (n: string | undefined): string | undefined => {
      if (n !== undefined && !svc.isKnownNs(n)) throw new HttpError(400, `unknown namespace: ${n}`);
      return n;
    };

    if (method === 'GET' && url.pathname === '/health') {
      return send(res, 200, {
        ok: true,
        embedder: { ...svc.embedderInfo, fallback: choice.fallback },
        llm: llmStats(),
        memories: store.count(),
        dbBytes: store.dbBytes(),
      });
    }
    if (method === 'POST' && url.pathname === '/memories') {
      const b = await readBody(req, maxBody);
      if (!isObj(b)) throw new HttpError(400, 'body must be an object');
      const at = b.at;
      if (at !== undefined && !(isObj(at) && Number.isFinite(at.day) && Number.isFinite(at.minute))) throw new HttpError(400, 'at must be {day, minute}');
      if (b.kind !== undefined && b.kind !== 'episodic' && b.kind !== 'gist') throw new HttpError(400, 'kind must be episodic|gist');
      return send(res, 200, await svc.add({
        agent: str(b.agent, 'agent'),
        text: str(b.text, 'text'),
        ns: checkNs(b.ns),
        kind: b.kind,
        importance: optNum(b.importance, 'importance'),
        emotion: optNum(b.emotion, 'emotion'),
        at,
        source: typeof b.source === 'string' ? b.source : undefined,
        meta: b.meta,
      }));
    }
    if (method === 'POST' && url.pathname === '/recall') {
      const b = await readBody(req, maxBody);
      if (!isObj(b)) throw new HttpError(400, 'body must be an object');
      const nsv = checkNs(b.ns);
      const agent = typeof b.agent === 'string' && b.agent !== '' ? b.agent : undefined;
      if (agent === undefined && (nsv === undefined || svc.isFading(nsv))) throw new HttpError(400, 'agent is required for this namespace');
      return send(res, 200, { memories: await svc.recall({ agent, query: str(b.query, 'query'), ns: nsv, limit: optNum(b.limit, 'limit') }) });
    }
    if (method === 'GET' && parts[0] === 'agents' && parts[2] === 'memories' && parts.length === 3) {
      return send(res, 200, svc.list(parts[1]!, checkNs(ns)));
    }
    if (method === 'POST' && url.pathname === '/compact') {
      const b = await readBody(req, maxBody);
      const agents = isObj(b) ? b.agents : undefined;
      if (agents !== undefined && !(Array.isArray(agents) && agents.every((a) => typeof a === 'string'))) throw new HttpError(400, 'agents must be string[]');
      return send(res, 200, { events: await svc.compact(agents) });
    }
    if (method === 'GET' && url.pathname === '/events') {
      const since = Number(q.get('since') ?? 0);
      const limit = Math.min(EVENTS_MAX_LIMIT, Number(q.get('limit') ?? EVENTS_DEFAULT_LIMIT));
      if (!Number.isFinite(since) || !Number.isFinite(limit) || limit < 1) throw new HttpError(400, 'invalid since/limit');
      const rows = store.eventsSince(since, limit);
      const events = rows.map((r) => ({ seq: r.seq, agentId: r.agent, action: r.action, memory: r.memory }));
      return send(res, 200, { events, last: rows.length ? rows[rows.length - 1]!.seq : since });
    }
    if (method === 'POST' && url.pathname === '/runs/events') {
      const b = await readBody(req, maxBody);
      if (!isObj(b) || !Array.isArray(b.events) || !b.events.every((e) => isObj(e) && typeof e.runId === 'string' && e.runId !== '')) throw new HttpError(400, 'events must be an array of objects with runId');
      store.appendRunEvents(b.events, Date.now());
      return send(res, 200, { ok: true, count: b.events.length });
    }
    if (method === 'GET' && parts[0] === 'runs' && parts[2] === 'events' && parts.length === 3) {
      return send(res, 200, store.loadRun(parts[1]!));
    }
    if (method === 'GET' && url.pathname === '/runs') return send(res, 200, store.listRuns());
    if (method === 'POST' && url.pathname === '/conversations') {
      const b = await readBody(req, maxBody);
      const ok = (l: unknown) => isObj(l) && typeof l.from === 'string' && typeof l.to === 'string' && typeof l.text === 'string'
        && ['speech', 'thought', 'deliberation'].includes(String(l.kind)) && isObj(l.at) && Number.isFinite(l.at.day) && Number.isFinite(l.at.minute);
      if (!isObj(b) || !Array.isArray(b.lines) || !b.lines.every(ok)) throw new HttpError(400, 'lines must be [{from, to, text, kind, at:{day,minute}, groupId?}]');
      store.appendConversations(b.lines as never, Date.now(), cfg.conversations.maxKept);
      return send(res, 200, { ok: true, count: b.lines.length });
    }
    if (method === 'GET' && url.pathname === '/conversations') {
      const n = Math.floor(Number(q.get('limit')));
      const since = q.get('since');
      return send(res, 200, store.conversations({
        agent: q.get('agent') ?? undefined, with: q.get('with') ?? undefined, group: q.get('group') ?? undefined,
        since: since !== null && Number.isFinite(Number(since)) ? Number(since) : undefined,
        limit: Math.max(1, Math.min(cfg.conversations.maxLimit, Number.isFinite(n) && n > 0 ? n : cfg.conversations.maxLimit)),
      }));
    }
    throw new HttpError(404, 'not found');
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error('mnemo: request failed:', err);
      send(res, 500, { error: 'internal error' });
    });
  });
  server.listen(cfg.http.port, cfg.http.host, () => {
    console.log(`mnemo: listening on ${cfg.http.host}:${cfg.http.port}, embedder ${choice.embedder.name}${choice.fallback ? ' (fallback)' : ''}, db ${cfg.db.path}`);
    svc.startTimer();
  });

  const shutdown = () => {
    svc.stopTimer();
    server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('mnemo: failed to start:', err);
  process.exit(1);
});
