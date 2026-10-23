import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkModel } from '../config.ts';
import { peerCheck } from '../rt/insights.ts';
import { checkMutation, originAllowed, tokenMatches } from './security.ts';

const guard = { port: 4400, corsOrigins: ['http://localhost:5174'] };
const json = { 'content-type': 'application/json; charset=utf-8' };

test('origin allowlist: configured, own port, none; foreign refused', () => {
  assert.equal(originAllowed('http://localhost:5174', guard), true);
  assert.equal(originAllowed('http://127.0.0.1:4400', guard), true);
  assert.equal(originAllowed(undefined, guard), true);
  assert.equal(originAllowed('https://evil.example', guard), false);
});

test('mutations need an allowed origin, a JSON body and the token when set', () => {
  assert.equal(checkMutation({ headers: json }, guard), undefined);
  assert.equal(checkMutation({ headers: { ...json, origin: 'https://evil.example' } }, guard)?.status, 403);
  assert.equal(checkMutation({ headers: { 'content-type': 'text/plain' } }, guard)?.status, 415);
  assert.equal(checkMutation({ headers: {} }, guard)?.status, 415);
  const withToken = { ...guard, apiToken: 's3cret' };
  assert.equal(checkMutation({ headers: json }, withToken)?.status, 401);
  assert.equal(checkMutation({ headers: { ...json, authorization: 'Bearer wrong' } }, withToken)?.status, 401);
  assert.equal(checkMutation({ headers: { ...json, authorization: 'Bearer s3cret' } }, withToken), undefined);
  assert.equal(tokenMatches(undefined, undefined), true);
  assert.equal(tokenMatches('a', 'ab'), false);
});

test('per-agent model must be in the allowlist', () => {
  const cfg = { models: { opus: 'anthropic/o', sonnet: 'anthropic/s', haiku: 'anthropic/h' }, allowedModels: ['openai/x'] } as const;
  assert.equal(checkModel(cfg as never, undefined), undefined);
  assert.equal(checkModel(cfg as never, 'anthropic/s'), undefined);
  assert.equal(checkModel(cfg as never, 'openai/x'), undefined);
  assert.match(checkModel(cfg as never, 'evil/model') ?? '', /must be one of/);
  assert.match(checkModel(cfg as never, 42) ?? '', /must be one of/);
});

test('insight peer check: same role, not the author', () => {
  const insight = { role: 'healer', author: 'Mara' };
  assert.equal(peerCheck(insight, { name: 'Ilse', role: 'healer' }), 'ok');
  assert.equal(peerCheck(insight, { name: 'Mara', role: 'healer' }), 'own');
  assert.equal(peerCheck(insight, { name: 'Tomas', role: 'builder' }), 'not_peer');
});
