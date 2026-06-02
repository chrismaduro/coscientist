import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeConvergence, isConverged, pruneActivePool } from '../agents/supervisor.js';
import { freshState } from '../utils.js';
import { makeHyp } from './helpers.mjs';

function stateWith(hyps, ranking, prevRound = null) {
  const s = freshState('run-test');
  s.hypotheses = hyps;
  s.tournament.ranking = ranking;
  if (prevRound) s.convergence.per_round.push(prevRound);
  return s;
}

test('computeConvergence: first round has null spearman/churn', () => {
  const hyps = [makeHyp({ id: 'H-1', elo: 1300 }), makeHyp({ id: 'H-2', elo: 1100 })];
  const s = stateWith(hyps, ['H-1', 'H-2']);
  computeConvergence(s, 1);
  const r = s.convergence.per_round.at(-1);
  assert.equal(r.spearman_vs_prev, null);
  assert.equal(r.top5_churn, null);
  assert.equal(r.best_elo, 1300);
  assert.equal(r.elo_spread, 200);
});

test('computeConvergence: identical ranking → spearman 1, churn 0', () => {
  const hyps = ['H-1', 'H-2', 'H-3', 'H-4', 'H-5'].map((id, i) => makeHyp({ id, elo: 1300 - i }));
  const ranking = ['H-1', 'H-2', 'H-3', 'H-4', 'H-5'];
  const s = stateWith(hyps, ranking, { round: 1, ranking: [...ranking] });
  computeConvergence(s, 2);
  const r = s.convergence.per_round.at(-1);
  assert.equal(r.spearman_vs_prev, 1);
  assert.equal(r.top5_churn, 0);
});

test('computeConvergence: fully reversed top-5 → high churn', () => {
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const hyps = ids.map(id => makeHyp({ id }));
  const prev = ['A', 'B', 'C', 'D', 'E'];
  const now = ['F', 'G', 'H', 'I', 'J']; // completely different top-5
  hyps.push(...['F', 'G', 'H', 'I', 'J'].map(id => makeHyp({ id })));
  const s = stateWith(hyps, now, { round: 1, ranking: prev });
  computeConvergence(s, 2);
  assert.equal(s.convergence.per_round.at(-1).top5_churn, 1);
});

test('isConverged: true when spearman ≥ threshold', () => {
  const s = freshState('r');
  s.convergence.per_round.push({ spearman_vs_prev: 0.95, top5_churn: 0.6 });
  assert.equal(isConverged(s), true);
});

test('isConverged: true when churn ≤ threshold', () => {
  const s = freshState('r');
  s.convergence.per_round.push({ spearman_vs_prev: 0.3, top5_churn: 0.1 });
  assert.equal(isConverged(s), true);
});

test('isConverged: false otherwise', () => {
  const s = freshState('r');
  s.convergence.per_round.push({ spearman_vs_prev: 0.4, top5_churn: 0.8 });
  assert.equal(isConverged(s), false);
});

test('pruneActivePool: keeps fresh + high-Elo, retires low-Elo old ones', () => {
  const s = freshState('r');
  s.round = 2;
  s.config.max_active_pool = 3;
  s.hypotheses = [
    makeHyp({ id: 'old-hi', elo: 1400, match_count: 5, round_created: 1 }),
    makeHyp({ id: 'old-mid', elo: 1200, match_count: 5, round_created: 1 }),
    makeHyp({ id: 'old-lo', elo: 1000, match_count: 5, round_created: 1 }),
    makeHyp({ id: 'fresh', elo: 1200, match_count: 0, round_created: 2 }),
  ];
  s.tournament.ranking = ['old-hi', 'old-mid', 'fresh', 'old-lo'];
  pruneActivePool(s);
  const active = s.hypotheses.filter(h => h.status === 'active').map(h => h.id);
  assert.ok(active.includes('fresh'), 'fresh hypothesis must survive');
  assert.ok(active.includes('old-hi'), 'top Elo must survive');
  assert.ok(!active.includes('old-lo'), 'lowest old Elo should be pruned');
  // pruned id removed from ranking
  assert.ok(!s.tournament.ranking.includes('old-lo'));
});

test('pruneActivePool: never prunes below cap', () => {
  const s = freshState('r');
  s.round = 2;
  s.config.max_active_pool = 10;
  s.hypotheses = [makeHyp({ id: 'a', match_count: 5, round_created: 1 })];
  pruneActivePool(s);
  assert.equal(s.hypotheses.filter(h => h.status === 'active').length, 1);
});
