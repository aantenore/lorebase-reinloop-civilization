import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelRefs, providerLabel, providerMode } from './providers.ts';

const models = { opus: 'anthropic/claude-opus-5-5', sonnet: 'anthropic/claude-sonnet-5-5', haiku: 'anthropic/claude-haiku-5-5' };

test('a local model runs live without any key', () => {
  const mode = providerMode(modelRefs({ modelOverride: 'ollama/qwen3:4b', models, roster: [] }), false, {});
  assert.deepEqual(mode, { mock: false, providers: ['ollama'] });
  assert.equal(providerLabel(mode), 'ollama');
});

test('a hosted model without its key falls back to the mock and says why', () => {
  const mode = providerMode(modelRefs({ models, roster: [] }), false, {});
  assert.equal(mode.mock, true);
  assert.match(providerLabel(mode), /^mock \(ANTHROPIC_API_KEY not set for /);
});

test('a hosted model with its key runs live; --mock always wins', () => {
  const refs = modelRefs({ models, roster: [] });
  assert.deepEqual(providerMode(refs, false, { ANTHROPIC_API_KEY: 'x' }), { mock: false, providers: ['anthropic'] });
  assert.equal(providerMode(refs, true, { ANTHROPIC_API_KEY: 'x' }).reason, '--mock');
});

test('roster models and allowed models count; one missing key is enough for the mock', () => {
  const refs = modelRefs({ models: { opus: 'ollama/a', sonnet: 'ollama/a', haiku: 'ollama/a' }, allowedModels: ['openai/gpt-5-mini'], roster: [] });
  const mode = providerMode(refs, false, {});
  assert.deepEqual(mode.providers, ['ollama', 'openai']);
  assert.equal(mode.reason, 'OPENAI_API_KEY not set for openai/gpt-5-mini');
});
