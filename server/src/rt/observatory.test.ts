import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NestedUsage, UsageLedger } from './observatory.ts';

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
