import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findPath, nearestWalkable } from './path.ts';
import { advance, type ExecContext, type Mover, normalizeStep, prepareStep } from './plan.ts';
import { tally } from './vote.ts';
import { memberRef, repairSteps } from './groups.ts';

// 5x5 grid with a wall at x=2 except y=4.
const blocked = new Set(['2,0', '2,1', '2,2', '2,3']);
const walk = (x: number, y: number) => !blocked.has(`${x},${y}`);
const opts = { diagonal: true, maxNodes: 1000 };

test('findPath goes around a wall and never cuts corners', () => {
  const path = findPath(5, 5, walk, { x: 0, y: 0 }, { x: 4, y: 0 }, opts)!;
  assert.ok(path);
  assert.deepEqual(path.at(-1), { x: 4, y: 0 });
  assert.ok(path.some((p) => p.x === 2 && p.y === 4), 'passes through the gap');
  for (const p of path) assert.ok(walk(p.x, p.y));
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    if (a.x !== b.x && a.y !== b.y) assert.ok(walk(b.x, a.y) && walk(a.x, b.y), 'no corner cutting');
  }
});

test('findPath: same tile, blocked target, unreachable', () => {
  assert.deepEqual(findPath(5, 5, walk, { x: 1, y: 1 }, { x: 1, y: 1 }, opts), []);
  assert.equal(findPath(5, 5, walk, { x: 0, y: 0 }, { x: 2, y: 1 }, opts), undefined);
  const sealed = (x: number, y: number) => x !== 2;
  assert.equal(findPath(5, 5, sealed, { x: 0, y: 0 }, { x: 4, y: 4 }, opts), undefined);
  assert.deepEqual(nearestWalkable(5, 5, walk, { x: 2, y: 1 }), { x: 1, y: 0 });
});

const ctx: ExecContext = {
  path: (from, to) => findPath(5, 5, walk, from, to, opts),
  locate: (who) => (who === 'Mara' ? { x: 0, y: 4 } : undefined),
  durations: { gather: 4, build: 20, eat: 1, experiment: 15, use: 2 },
  craftMinutes: (code) => (code === 'axe' ? 40 : undefined),
  maxWaitMinutes: 30,
};

test('normalizeStep accepts flat or nested args and rejects junk', () => {
  assert.deepEqual(normalizeStep({ action: 'move_to', x: '3', y: 1.4, label: 'vado' }, 50), { action: 'move_to', args: { x: 3, y: 1 }, label: 'vado' });
  assert.deepEqual(normalizeStep({ action: 'gather', args: { resource: 'wood' } }, 50)?.args, { resource: 'wood' });
  assert.equal(normalizeStep({ action: 'fly' }, 50), undefined);
  assert.equal(normalizeStep({ action: 'give', to: 'Mara', resource: 'Gold bars!', amount: 1 }, 50), undefined);
  assert.deepEqual(normalizeStep({ action: 'dai', to: 'Mara', item: 'axe' }, 50)?.args, { to: 'Mara', item: 'axe', amount: 1 });
  assert.deepEqual(normalizeStep({ action: 'sperimenta', items: ['seeds', 'food', 'seeds'] }, 50), { action: 'experiment', args: { items: ['seeds', 'food'] }, label: 'experiment' });
  assert.equal(normalizeStep({ action: 'crea', recipe: 'axe' }, 50)?.action, 'craft');
  assert.equal(normalizeStep({ action: 'say', to: 'all', text: 'x'.repeat(99) }, 10)?.args.text, 'x'.repeat(10));
  assert.equal(normalizeStep({ action: 'move_to', x: 1, y: 2, who: 'a1' }, 50)?.args.who, 'a1');
});

test('walk activity moves at the given speed and arrives', () => {
  const m: Mover = { x: 0, y: 0, dir: 's', anim: 'idle' };
  const p = prepareStep(normalizeStep({ action: 'move_to', x: 1, y: 0 }, 50)!, m, ctx);
  assert.ok('activity' in p);
  assert.equal(advance(p.activity, m, 0.25, 2, 0, 1, 0.01), false);
  assert.ok(Math.abs(m.x - 0.5) < 1e-9);
  assert.equal(m.dir, 'e');
  assert.equal(m.anim, 'walk');
  assert.equal(advance(p.activity, m, 0.5, 2, 0, 1, 0.01), true);
  assert.deepEqual([m.x, m.y], [1, 0]);
});

test('timed work scales with work speed; failures are reported', () => {
  const m: Mover = { x: 0, y: 0, dir: 's', anim: 'idle' };
  const p = prepareStep({ action: 'gather', args: { resource: 'food' }, label: '' }, m, ctx);
  assert.ok('activity' in p);
  assert.equal(advance(p.activity, m, 1, 1, 1, 2, 0.01), false); // 4 - 2
  assert.equal(m.anim, 'work');
  assert.equal(advance(p.activity, m, 1, 1, 1, 2, 0.01), true);
  assert.deepEqual(prepareStep({ action: 'move_to', args: { x: 2, y: 2 }, label: '' }, m, ctx), { error: 'unreachable' });
  assert.deepEqual(prepareStep({ action: 'approach', args: { to: 'Nobody' }, label: '' }, m, ctx), { error: 'no_such_person' });
  const nap = prepareStep({ action: 'sleep', args: { minutes: 999 }, label: '' }, m, ctx);
  assert.ok('activity' in nap && nap.activity.kind === 'timed' && nap.activity.remaining === 30);
});

test('tally: plurality, majority flag, tie-break, invalid votes', () => {
  assert.deepEqual(tally([1, 1, 0], 2), { winner: 1, counts: [1, 2], valid: 3, majority: true, tie: false });
  const tie = tally([0, 1, 7, null], 2, [1]);
  assert.equal(tie.winner, 1);
  assert.equal(tie.tie, true);
  assert.equal(tie.valid, 2);
  assert.equal(tie.majority, false);
  assert.equal(tally([], 3).winner, 0);
  assert.equal(tally([0], 0).winner, -1);
});

test('joint plan repair: who by id, name or in text; missing who goes to the author; unknown actions mapped or dropped', () => {
  const members = [{ id: 'a5', name: 'Okon' }, { id: 'a6', name: 'Pell' }];
  assert.equal(memberRef('Okon (a5)', members)?.id, 'a5');
  assert.equal(memberRef('pell', members)?.id, 'a6');
  assert.equal(memberRef('Nia', members), undefined);
  const raw = [
    { who: 'a5', action: 'raccogli', resource: 'food', label: 'g' },
    { action: 'mangia', label: 'e' },
    { who: 'Pell', action: 'fly', label: 'x' },
    { who: 'Nia', action: 'wait', minutes: 5, label: 'w' },
  ];
  const fixed = repairSteps(raw, members, 'a6', 100, 10);
  assert.deepEqual(fixed.steps.map((s) => [s.args.who, s.action]), [['a5', 'gather'], ['a6', 'eat'], ['a6', 'wait']]);
  assert.equal(fixed.dropped.length, 1);
  assert.equal(repairSteps(raw.slice(3), members, undefined, 100, 10).steps.length, 0);
});
