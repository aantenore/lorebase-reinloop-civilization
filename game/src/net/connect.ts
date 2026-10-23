import { config } from '../config';
import { WsTransport, waitForOpen } from './wsClient';
import type { Transport } from './transport';

/** Real socket unless `?mock=1`, or the socket fails and fallback is enabled. */
export async function connect(): Promise<Transport> {
  if (config.forceMock) return createMock();
  const ws = new WsTransport();
  const ok = await waitForOpen(ws, config.connectTimeoutMs);
  if (ok || !config.mockFallback) return ws;
  ws.close();
  console.info('[net] socket unavailable, starting the offline mock world');
  return createMock();
}

async function createMock(): Promise<Transport> {
  const { MockServer } = await import('../mock/mockServer');
  return new MockServer();
}
