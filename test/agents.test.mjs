import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshState } from '../utils.js';
import { runGeneration } from '../agents/generation.js';
import { runReflection } from '../agents/reflection.js';
import { runRanking } from '../agents/ranking.js';
import { runEvolution } from '../agents/evolution.js';
import { runProximity } from '../agents/proximity.js';
import { makeMockClient, makeHyp, jsonBlock } from './helpers.mjs';

const noop = () => {};

// ── Generation ───────────────────────────────────────────────────────────────
test('generation: appends new hypotheses with sequential ids and status "new"', async () => {
  const s = freshState('r'); s.round = 1; s.research_goal = 'g';
  const client = makeMockClient(() => jsonBlock([
    { title: 'H one', statement: 'A→B', front: 'F1', technique: 'literature' },
    { title: 'H two', statement: 'C→D', front: 'F2', technique: 'debate' },
  ]));
  await runGeneration(s, client, noop);
  assert.equal(s.hypotheses.length, 2);
  assert.deepEqual(s.hypotheses.map(h => h.id), ['H-001', 'H-002']);
  assert.ok(s.hypotheses.every(h => h.status === 'new' && h.origin === 'generation'));
  assert.equal(s.hypotheses[0].elo, 1200);
});

test('generation: malformed JSON does not throw, leaves corpus unchanged', async () => {
  const s = freshState('r'); s.round = 1;
  const client = makeMockClient(() => 'totally not json');
  await runGeneration(s, client, noop);
  assert.equal(s.hypotheses.length, 0); // graceful
});

// ── Reflection ───────────────────────────────────────────────────────────────
test('reflection: sets status active/rejected and attaches review', async () => {
  const s = freshState('r'); s.round = 1;
  const h = makeHyp({ id: 'H-001', status: 'new' });
  s.hypotheses = [h];
  const client = makeMockClient(() => jsonBlock([
    { hypothesis_id: 'H-001', status: 'active',
      scores: { alignment: 4, plausibility: 4, novelty: 5, testability: 3, safety: 'pass' },
      reject_reason: null, evolution_targets: ['tighten DV'], review_summary: 'solid' },
  ]));
  await runReflection(s, client, [h], noop);
  assert.equal(h.status, 'active');
  assert.equal(h.reviews.length, 1);
  assert.equal(h.reviews[0].scores.novelty, 5);
  assert.deepEqual(h.reviews[0].evolution_targets, ['tighten DV']);
});

test('reflection: error path marks new hypotheses active (default-to-active)', async () => {
  const s = freshState('r'); s.round = 1;
  const h = makeHyp({ id: 'H-001', status: 'new' });
  s.hypotheses = [h];
  const client = makeMockClient(() => 'broken');
  await runReflection(s, client, [h], noop);
  assert.equal(h.status, 'active');
});

// ── Ranking (the bug we fixed: ranking derived from Elo, not LLM text) ─────────
test('ranking: applies match verdicts and derives ranking from Elo', async () => {
  const s = freshState('r'); s.round = 1;
  s.hypotheses = [
    makeHyp({ id: 'H-1', elo: 1200 }),
    makeHyp({ id: 'H-2', elo: 1200 }),
  ];
  // LLM returns a match H-1 beats H-2, but a *bogus* ranking putting H-2 first.
  const client = makeMockClient(() => jsonBlock({
    matches: [{ round: 1, a: 'H-1', b: 'H-2', type: 'single', winner: 'H-1', rationale: 'x' }],
    elo_updates: { 'H-1': 9999, 'H-2': 1 },
    ranking: ['H-2', 'H-1'], // deliberately wrong — must be ignored
  }));
  await runRanking(s, client, noop);
  const h1 = s.hypotheses.find(h => h.id === 'H-1');
  const h2 = s.hypotheses.find(h => h.id === 'H-2');
  assert.ok(h1.elo > 1200, 'winner gains Elo');
  assert.ok(h2.elo < 1200, 'loser loses Elo');
  // Canonical ranking is Elo order, NOT the LLM-provided order.
  assert.deepEqual(s.tournament.ranking, ['H-1', 'H-2']);
  // matches tagged with pipeline round
  assert.equal(s.tournament.matches[0].pipeline_round, 1);
});

// ── Evolution ────────────────────────────────────────────────────────────────
test('evolution: creates evolved hypotheses with origin/parent_ids', async () => {
  const s = freshState('r'); s.round = 1; s.config.n_evolved_per_round = 2;
  s.hypotheses = [makeHyp({ id: 'H-1', elo: 1400 }), makeHyp({ id: 'H-2', elo: 1300 })];
  const client = makeMockClient(() => jsonBlock([
    { parent_ids: ['H-1', 'H-2'], strategy: 'combination', title: 'Evolved', statement: 'X→Y', front: 'F' },
  ]));
  await runEvolution(s, client, noop);
  const evolved = s.hypotheses.filter(h => h.origin === 'evolution');
  assert.equal(evolved.length, 1);
  assert.equal(evolved[0].status, 'new');
  assert.deepEqual(evolved[0].parent_ids, ['H-1', 'H-2']);
  assert.equal(evolved[0].id, 'H-003');
});

// ── Proximity ────────────────────────────────────────────────────────────────
test('proximity: assigns cluster_ids from the map', async () => {
  const s = freshState('r'); s.round = 1;
  s.hypotheses = [makeHyp({ id: 'H-1' }), makeHyp({ id: 'H-2' })];
  const client = makeMockClient(() => jsonBlock({
    clusters: [{ id: 'C-001', label: 'grp', member_ids: ['H-1', 'H-2'], representative_id: 'H-1' }],
    hypothesis_cluster_map: { 'H-1': 'C-001', 'H-2': 'C-001' },
  }));
  await runProximity(s, client, noop);
  assert.equal(s.clusters.length, 1);
  assert.equal(s.hypotheses[0].cluster_id, 'C-001');
  assert.equal(s.hypotheses[1].cluster_id, 'C-001');
});
