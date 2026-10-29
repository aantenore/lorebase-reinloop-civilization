import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../../config.ts';
import { KnowledgeError } from '../../../ports/knowledge.ts';
import { LorebaseError } from './client.ts';
import { pinnedSchema } from './herald.ts';
import { planArchiveToTags } from './archive.ts';
import { LorebaseKnowledge } from './index.ts';

type Call = { op: string; params: Record<string, unknown>; branch: string };

function stubbed(): { k: LorebaseKnowledge; calls: Call[]; log: string[] } {
  const cfg = loadConfig([], {});
  const k = new LorebaseKnowledge(cfg.knowledge.lorebase, { root: '.', pollMs: 1000 });
  const calls: Call[] = [];
  const log: string[] = [];
  const c = k.client as unknown as Record<string, unknown>;
  c.execute = async (op: string, params: Record<string, unknown>, opts: { branch: string }) => {
    calls.push({ op, params, branch: opts.branch });
    return { status: 'ok', revision: `r${calls.length}`, head: `r${calls.length}`, edit_count: 1 };
  };
  c.getBranch = async (name: string) => {
    if (name.startsWith('law/')) throw new LorebaseError(404, {}, 'GET branch');
    return { name, head: 'h', protected: false };
  };
  c.createBranch = async (name: string, source: string) => (log.push(`branch ${name} from ${source}`), { name, head: 'h' });
  c.createTag = async (name: string, target: { source?: string; revision?: string }) => (log.push(`tag ${name} from ${target.source ?? target.revision}`), { name, revision: 'h' });
  c.deleteBranch = async (name: string) => log.push(`delete ${name}`);
  c.createProposal = async (source: string, target: string, title: string) => (log.push(`proposal ${source} -> ${target}: ${title}`), { id: 'P1', status: 'open' });
  c.getProposal = async (id: string) => ({ id, title: 't', source_ref: 'law/x', target_ref: 'main', status: 'open', created_at: '' });
  c.merge = async (id: string) => (log.push(`merge ${id}`), { result: 'merged', revision: 'm1' });
  return { k, calls, log };
}

test('lorebase knowledge: law changes on the live branch use the configured Operations', async () => {
  const { k, calls } = stubbed();
  await k.write([{ action: 'update', kind: 'Rule', key: 'max_hp', values: { value: 12 } }], { message: 'm' });
  await k.write([{ action: 'update', kind: 'Rule', key: 'max_hp', values: { text: 't', category: 'survival' } }], { message: 'm' });
  await k.write([{ action: 'create', kind: 'Rule', key: 'x', values: { code: 'x', value: 1 } }], { message: 'm' });
  await k.write([{ action: 'delete', kind: 'Rule', key: 'x' }], { message: 'm' });
  assert.deepEqual(calls.map((c) => [c.op, c.params, c.branch]), [
    ['set_rule', { rule: 'max_hp', value: 12 }, 'main'],
    ['amend_rule', { rule: 'max_hp', text: 't', category: 'survival' }, 'main'],
    ['enact_rule', { code: 'x', value: 1 }, 'main'],
    ['repeal_rule', { rule: 'x' }, 'main'],
  ]);
});

test('lorebase knowledge: drafts use the built-ins (and per-kind overrides), upserts are batched imports', async () => {
  const { k, calls } = stubbed();
  await k.write([
    { action: 'update', kind: 'Rule', key: 'max_hp', values: { value: 12 } },
    { action: 'delete', kind: 'Rule', key: 'y' },
    { action: 'create', kind: 'Insight', key: 'i1', values: { code: 'i1', role: 'healer', text: 't' } },
    { action: 'update', kind: 'Insight', key: 'i1', values: { status: 'accepted' } },
  ], { message: 'm', scope: 'role/healer/x' });
  await k.write([
    { action: 'upsert', kind: 'Chronicle', key: 'c1', values: { code: 'c1' } },
    { action: 'upsert', kind: 'Chronicle', key: 'c2', values: { code: 'c2' } },
  ], { message: 'm' });
  await k.write([
    { action: 'upsert', kind: 'Technology', key: 't', values: { code: 't' }, links: { requires: ['a'] } },
    { action: 'upsert', kind: 'Recipe', key: 'r', values: { code: 'r' } },
  ], { message: 'm', scope: 'tech/t' });
  assert.deepEqual(calls.map((c) => [c.op, c.params]), [
    ['update_rule', { key: 'max_hp', value: 12 }],
    ['delete_rule', { key: 'y' }],
    ['share_insight', { code: 'i1', role: 'healer', text: 't', role_code: 'healer' }],
    ['update_insight', { key: 'i1', status: 'accepted' }],
    ['import_records', { kind: 'Chronicle', rows: [{ code: 'c1' }, { code: 'c2' }] }],
    ['import_batch', { records: [{ kind: 'Technology', code: 't', links: { requires: ['a'] } }, { kind: 'Recipe', code: 'r' }] }],
  ]);
});

test('lorebase knowledge: propose creates the draft from the live branch; accept merges and discards it', async () => {
  const { k, calls, log } = stubbed();
  const p = await k.propose({ draft: 'law/x', title: 'T', message: 'm', changes: [{ action: 'update', kind: 'Rule', key: 'a', values: { value: 1 } }] });
  assert.equal(p.id, 'P1');
  assert.equal(calls[0]!.branch, 'law/x');
  assert.equal(await k.accept(p.id, 'ok'), 'm1');
  assert.deepEqual(log, ['branch law/x from main', 'proposal law/x -> main: T', 'merge P1', 'delete law/x']);
});

test('lorebase errors become knowledge errors: permanent 4xx, retry delay on 429', () => {
  const e = new LorebaseError(422, { code: 'invalid' }, 'POST x');
  assert.ok(e instanceof KnowledgeError);
  assert.equal(e.permanent, true);
  const busy = new LorebaseError(429, { retry_after_s: 3 }, 'POST x');
  assert.equal(busy.permanent, false);
  assert.equal(busy.retryAfterMs, 3000);
  assert.equal(new LorebaseError(503, {}, 'POST x').permanent, false);
});

test('pinnedSchema drops branch arguments and backend names from descriptions', () => {
  const out = pinnedSchema({
    type: 'object', description: 'Lorebase search',
    properties: { query: { type: 'string', description: 'words to search in Lorebase' }, kinds: { type: 'array', description: 'record kinds' }, branch: { type: 'string' } },
    required: ['query', 'branch'],
  }, ['branch']);
  assert.deepEqual(out, { type: 'object', properties: { query: { type: 'string' }, kinds: { type: 'array', description: 'record kinds' } }, required: ['query'] });
});

test('lorebase knowledge: archive is a tag of the live head, never a branch; snapshot stays a branch', async () => {
  const { k, log } = stubbed();
  await k.archive('archive/20260101');
  await k.snapshot('reset/20260101');
  assert.deepEqual(log, ['tag archive/20260101 from main', 'delete reset/20260101', 'branch reset/20260101 from main']);
  await assert.rejects(k.archive('main'));
});

test('archive to tags: plans one tag per archive branch, skips tagged or protected ones, nothing once migrated', () => {
  const branches = [
    { name: 'main', head: 'm', protected: true },
    { name: 'archive/b', head: 'hb' },
    { name: 'archive/a', head: 'ha' },
    { name: 'archive/c', head: 'hc' },
    { name: 'archive/p', head: 'hp', protected: true },
    { name: 'reset/x', head: 'hx' },
  ];
  assert.deepEqual(planArchiveToTags(branches, [{ name: 'archive/c', revision: 'hc' }], 'archive/'), [
    { action: 'tag', name: 'archive/a', head: 'ha' },
    { action: 'tag', name: 'archive/b', head: 'hb' },
    { action: 'skip', name: 'archive/c', reason: 'a tag with this name exists' },
    { action: 'skip', name: 'archive/p', reason: 'protected branch' },
  ]);
  assert.deepEqual(planArchiveToTags([{ name: 'main', head: 'm' }], [{ name: 'archive/a', revision: 'ha' }], 'archive/'), []);
});
