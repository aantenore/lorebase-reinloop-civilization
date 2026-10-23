// WebSocket endpoint (`/ws`) on the existing HTTP server, using the `ws` package. Upgrades are
// refused unless the Origin (when present) is allowed. The token, when configured, is read
// from the `token` query parameter (or later from `join.token`, checked by the game).
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { type GuardConfig, hostAllowed, originAllowed, tokenMatches } from './security.ts';

export interface Conn {
  id: number;
  /** True when the connection presented the API token (or none is configured). */
  authorized: boolean;
  send(msg: unknown): void;
  close(code?: number, reason?: string): void;
}

export interface WsHandlers {
  open(conn: Conn): void;
  message(conn: Conn, msg: unknown): void;
  close(conn: Conn): void;
}

export interface WsOptions extends GuardConfig {
  path: string;
  maxPayloadBytes: number;
}

export function attachWebSocket(server: Server, opts: WsOptions, handlers: WsHandlers): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayloadBytes });
  let nextId = 1;
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== opts.path) return void socket.destroy();
    if (!originAllowed(req.headers.origin, opts) || !hostAllowed(req.headers.host, opts)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return void socket.destroy();
    }
    const authorized = tokenMatches(url.searchParams.get('token') ?? undefined, opts.apiToken);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn: Conn = {
        id: nextId++,
        authorized,
        send: (msg) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
        },
        close: (code, reason) => ws.close(code, reason),
      };
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        handlers.message(conn, msg);
      });
      ws.on('close', () => handlers.close(conn));
      ws.on('error', () => ws.close());
      handlers.open(conn);
    });
  });
  return wss;
}
