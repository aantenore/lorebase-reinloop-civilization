import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheSavingsUsd, NestedUsage, UsageLedger } from './observatory.ts';

test('group usage: each nested model run is booked once (resumed runs by increase), the rest to the group', () => {
  const n = new NestedUsage();
  const end = (runId: string, costUsd: number, inputTokens: number, parentRunId?: string) => ({ type: 'run_end', runId, parentRunId, data: { status: 'completed', usage: { inputTokens, outputTokens: 1 }, costUsd } });
  assert.equal(n.onEvent({ type: 'model_request', runId: 'm1', parentRunId: 'root', data: {} }), undefined);
  n.onEvent({ type: 'model_request', runId: 'm2', parentRunId: 'root', data: {} });
  assert.deepEqual(n.onEvent(end('m1', 0.3, 100, 'root')), { status: 'completed', usage: { inputTokens: 100, outputTokens: 1 }, costUsd: 0.3 });
  assert.equal(n.onEvent(end('team', 0.3, 100, 'root')), undefined);
  assert.equal(n.onEvent(end('m2', 0.1, 50, 'root'))!.costUsd, 0.1);
  assert.equal(Math.round(n.onEvent(end('m1', 0.5, 160, 'root'))!.costUsd * 100) / 100, 0.2);
  const rest = n.remainder({ status: 'completed', usage: { inputTokens: 220, outputTokens: 3 }, costUsd: 0.65 });
  assert.equal(Math.round(rest.costUsd! * 100) / 100, 0.05);
  assert.deepEqual(rest.usage, { inputTokens: 10, outputTokens: 1 });
  const ledger = new UsageLedger();
  ledger.track({ id: 'g/a', name: 'G/A', model: 'haiku-m', tier: 'group:assembly' }, { status: 'completed', costUsd: 0.25 });
  ledger.track({ id: 'g/b', name: 'G/B', model: 'sonnet-m', tier: 'group:assembly' }, { status: 'completed', costUsd: 0.5 });
  assert.deepEqual(Object.keys(ledger.by('model')).sort(), ['haiku-m', 'sonnet-m']);
  assert.equal(ledger.totalUsd(), 0.75);
});

test('prompt cache: nested cache counts are booked by increase, savings priced per model, totals and hit ratio', () => {
  const n = new NestedUsage();
  n.onEvent({ type: 'model_request', runId: 'm1', parentRunId: 'root', data: {} });
  const end = (input: number, read: number, write: number) => ({ type: 'run_end', runId: 'm1', parentRunId: 'root', data: { status: 'completed', usage: { inputTokens: input, outputTokens: 1, cacheReadTokens: read, cacheWriteTokens: write }, costUsd: 0 } });
  assert.deepEqual(n.onEvent(end(3000, 0, 2000))!.usage, { inputTokens: 3000, outputTokens: 1, cacheWriteTokens: 2000 });
  assert.deepEqual(n.onEvent(end(6000, 2000, 2000))!.usage, { inputTokens: 3000, outputTokens: 0, cacheReadTokens: 2000 });
  assert.deepEqual(n.remainder({ status: 'completed', usage: { inputTokens: 6000, outputTokens: 2, cacheReadTokens: 2000, cacheWriteTokens: 2000 } }).usage, { inputTokens: 0, outputTokens: 1 });
  // claude-haiku-5-5: input $0.1/MTok, read $0.01, 5m writes 1.25x: 1M read saves $0.09, 1M written costs $0.025 more.
  assert.equal(Math.round(cacheSavingsUsd('anthropic/claude-haiku-5-5', { cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }) * 1e6) / 1e6, 0.065);
  assert.equal(cacheSavingsUsd('mock/x', { cacheReadTokens: 1000 }), 0);
  const ledger = new UsageLedger();
  ledger.track({ id: 'a', name: 'A', model: 'anthropic/claude-haiku-5-5', tier: 'haiku' }, { status: 'completed', usage: { inputTokens: 4000, outputTokens: 10, cacheReadTokens: 3000 }, costUsd: 0.001 });
  ledger.track({ id: 'b', name: 'B', model: 'anthropic/claude-sonnet-5-5', tier: 'sonnet' }, { status: 'completed', usage: { inputTokens: 4000, outputTokens: 10, cacheWriteTokens: 3000 }, costUsd: 0.01 });
  const c = ledger.cache();
  assert.equal(c.readTokens, 3000);
  assert.equal(c.writeTokens, 3000);
  assert.equal(c.hitRatio, 0.375);
  assert.equal(ledger.cacheBy('tier').haiku!.hitRatio, 0.75);
  assert.ok(ledger.cacheBy('tier').sonnet!.savedUsd < 0);
});
