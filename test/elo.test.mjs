import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedScore, applyEloUpdate } from '../agents/ranking.js';
import { makeHyp } from './helpers.mjs';

test('expectedScore: equal ratings → 0.5', () => {
  assert.equal(expectedScore(1200, 1200), 0.5);
});

test('expectedScore: 400-point gap → ~0.909 / ~0.091', () => {
  assert.ok(Math.abs(expectedScore(1600, 1200) - 0.909) < 0.001);
  assert.ok(Math.abs(expectedScore(1200, 1600) - 0.091) < 0.001);
});

test('expectedScore is symmetric (sums to 1)', () => {
  assert.ok(Math.abs(expectedScore(1300, 1100) + expectedScore(1100, 1300) - 1) < 1e-9);
});

test('applyEloUpdate: equal ratings, winner gains K/2', () => {
  const a = makeHyp({ id: 'A', elo: 1200 });
  const b = makeHyp({ id: 'B', elo: 1200 });
  applyEloUpdate(a, b, 1, 32); // A wins
  applyEloUpdate(b, a, 0, 32); // B loses (use pre-update opponent in real code; here independent)
  assert.equal(a.elo, 1216); // 1200 + 32*(1-0.5)
  assert.equal(a.wins, 1);
  assert.equal(a.match_count, 1);
  assert.equal(b.losses, 1);
});

test('applyEloUpdate: K=64 (debate) doubles the swing', () => {
  const a = makeHyp({ id: 'A', elo: 1200 });
  const b = makeHyp({ id: 'B', elo: 1200 });
  applyEloUpdate(a, b, 1, 64);
  assert.equal(a.elo, 1232); // 1200 + 64*0.5
});

test('applyEloUpdate: draw nudges toward the mean', () => {
  const a = makeHyp({ id: 'A', elo: 1400 });
  const b = makeHyp({ id: 'B', elo: 1200 });
  applyEloUpdate(a, b, 0.5, 32); // higher-rated draws → loses points
  assert.ok(a.elo < 1400);
});

test('applyEloUpdate records elo_history', () => {
  const a = makeHyp({ id: 'A', elo: 1200 });
  const b = makeHyp({ id: 'B', elo: 1000 });
  applyEloUpdate(a, b, 1, 32);
  assert.equal(a.elo_history.length, 1);
  assert.equal(a.elo_history[0].from, 1200);
  assert.equal(a.elo_history[0].to, a.elo);
});
