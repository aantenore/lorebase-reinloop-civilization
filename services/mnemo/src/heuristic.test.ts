import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heuristicBlur, heuristicMerge } from './heuristic.ts';

test('blur rounds numbers', () => {
  assert.equal(heuristicBlur('Pesa 7.3 chili'), 'Pesa circa 7 chili');
  assert.equal(heuristicBlur('Eravamo in 13 al fuoco'), 'Eravamo in una decina al fuoco');
  assert.equal(heuristicBlur('Ho contato 247 pietre'), 'Ho contato circa 200 pietre');
});

test('blur replaces coordinates and trims the trailing clause', () => {
  assert.equal(heuristicBlur('Ho visto il pozzo (12,7), era quasi asciutto.'), 'Ho visto il pozzo lì vicino.');
});

test('blur is deterministic and does not stack "circa"', () => {
  const once = heuristicBlur('Pesa 7.3 chili');
  assert.equal(heuristicBlur(once), once);
  assert.equal(heuristicBlur('Ho raccolto selce'), 'Ho raccolto selce');
});

test('merge builds a capped gist of the shortest blurred texts', () => {
  const g = heuristicMerge(['Ho trovato 13 bacche rosse vicino al fiume.', 'Ho trovato bacche.'], 200);
  assert.equal(g, 'Ricordo vagamente che: Ho trovato bacche; Ho trovato una decina bacche rosse vicino al fiume.');
  const short = heuristicMerge(['aaaa bbbb cccc', 'dddd eeee ffff'], 40);
  assert.ok(short.length <= 41);
});
