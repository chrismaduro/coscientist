import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshState } from '../utils.js';
import { runGeneration } from '../agents/generation.js';
import { runReflection } from '../agents/reflection.js';
import { runRanking } from '../agents/ranking.js';
import { runEvolution } from '../agents/evolution.js';
import { runProximity } from '../agents/proximity.js';
import { runMetaReview } from '../agents/meta-review.js';
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

test('generation: each hypothesis gets round_created from state.round', async () => {
  const s = freshState('r'); s.round = 3; s.research_goal = 'g';
  const client = makeMockClient(() => jsonBlock([
    { title: 'H', statement: 'A→B', front: 'F', technique: 'literature' },
  ]));
  await runGeneration(s, client, noop);
  assert.equal(s.hypotheses[0].round_created, 3);
});

test('generation: malformed JSON does not throw, leaves corpus unchanged', async () => {
  const s = freshState('r'); s.round = 1;
  const client = makeMockClient(() => 'totally not json');
  await runGeneration(s, client, noop);
  assert.equal(s.hypotheses.length, 0);
});

test('generation: increments ids correctly when corpus already has entries', async () => {
  const s = freshState('r'); s.round = 2;
  s.hypotheses = [makeHyp({ id: 'H-001' }), makeHyp({ id: 'H-002' })];
  const client = makeMockClient(() => jsonBlock([
    { title: 'New', statement: 'X→Y', front: 'F', technique: 'expansion' },
  ]));
  await runGeneration(s, client, noop);
  assert.equal(s.hypotheses.length, 3);
  assert.equal(s.hypotheses[2].id, 'H-003');
});

test('generation: uses google provider path without throwing', async () => {
  const s = freshState('r'); s.round = 1; s.research_goal = 'g';
  const client = makeMockClient(() => jsonBlock([
    { title: 'G', statement: 'A→B', front: 'F', technique: 'literature' },
  ]), 'google');
  await runGeneration(s, client, noop);
  assert.equal(s.hypotheses.length, 1);
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

test('reflection: rejected hypothesis gets reject_reason', async () => {
  const s = freshState('r'); s.round = 1;
  const h = makeHyp({ id: 'H-001', status: 'new' });
  s.hypotheses = [h];
  const client = makeMockClient(() => jsonBlock([
    { hypothesis_id: 'H-001', status: 'rejected',
      scores: { alignment: 1, plausibility: 1, novelty: 1, testability: 1, safety: 'pass' },
      reject_reason: 'Not novel', evolution_targets: [], review_summary: 'weak' },
  ]));
  await runReflection(s, client, [h], noop);
  assert.equal(h.status, 'rejected');
  assert.equal(h.reject_reason, 'Not novel');
});

test('reflection: error path marks new hypotheses active (default-to-active)', async () => {
  const s = freshState('r'); s.round = 1;
  const h = makeHyp({ id: 'H-001', status: 'new' });
  s.hypotheses = [h];
  const client = makeMockClient(() => 'broken');
  await runReflection(s, client, [h], noop);
  assert.equal(h.status, 'active');
});

test('reflection: empty hypotheses list does not throw', async () => {
  const s = freshState('r'); s.round = 1;
  const client = makeMockClient(() => jsonBlock([]));
  await assert.doesNotReject(() => runReflection(s, client, [], noop));
});

// ── Ranking ───────────────────────────────────────────────────────────────────

test('ranking: applies match verdicts and derives ranking from Elo', async () => {
  const s = freshState('r'); s.round = 1;
  s.hypotheses = [
    makeHyp({ id: 'H-1', elo: 1200 }),
    makeHyp({ id: 'H-2', elo: 1200 }),
  ];
  // LLM returns a bogus ranking — must be ignored; ranking derived from Elo.
  const client = makeMockClient(() => jsonBlock({
    matches: [{ round: 1, a: 'H-1', b: 'H-2', type: 'single', winner: 'H-1', rationale: 'x' }],
    elo_updates: { 'H-1': 9999, 'H-2': 1 },
    ranking: ['H-2', 'H-1'],
  }));
  await runRanking(s, client, noop);
  const h1 = s.hypotheses.find(h => h.id === 'H-1');
  const h2 = s.hypotheses.find(h => h.id === 'H-2');
  assert.ok(h1.elo > 1200, 'winner gains Elo');
  assert.ok(h2.elo < 1200, 'loser loses Elo');
  assert.deepEqual(s.tournament.ranking, ['H-1', 'H-2']);
  assert.equal(s.tournament.matches[0].pipeline_round, 1);
});

test('ranking: match_count increments for each matched hypothesis', async () => {
  const s = freshState('r'); s.round = 1;
  s.hypotheses = [
    makeHyp({ id: 'H-1', elo: 1200, match_count: 0 }),
    makeHyp({ id: 'H-2', elo: 1200, match_count: 0 }),
  ];
  const client = makeMockClient(() => jsonBlock({
    matches: [{ round: 1, a: 'H-1', b: 'H-2', type: 'single', winner: 'H-1', rationale: 'x' }],
    elo_updates: {},
    ranking: ['H-1', 'H-2'],
  }));
  await runRanking(s, client, noop);
  const h1 = s.hypotheses.find(h => h.id === 'H-1');
  const h2 = s.hypotheses.find(h => h.id === 'H-2');
  assert.equal(h1.match_count, 1);
  assert.equal(h2.match_count, 1);
});

test('ranking: draws are recorded correctly (winner=null)', async () => {
  const s = freshState('r'); s.round = 1;
  s.hypotheses = [makeHyp({ id: 'H-1' }), makeHyp({ id: 'H-2' })];
  const client = makeMockClient(() => jsonBlock({
    matches: [{ round: 1, a: 'H-1', b: 'H-2', type: 'single', winner: null, rationale: 'tie' }],
    elo_updates: {},
    ranking: ['H-1', 'H-2'],
  }));
  await runRanking(s, client, noop);
  assert.equal(s.tournament.matches[0].winner, null);
});

test('ranking: malformed LLM response does not throw', async () => {
  const s = freshState('r'); s.round = 1;
  s.hypotheses = [makeHyp({ id: 'H-1' }), makeHyp({ id: 'H-2' })];
  const client = makeMockClient(() => 'not json at all');
  await assert.doesNotReject(() => runRanking(s, client, noop));
});

test('ranking: empty active pool does not throw', async () => {
  const s = freshState('r'); s.round = 1;
  s.hypotheses = [];
  const client = makeMockClient(() => jsonBlock({ matches: [], elo_updates: {}, ranking: [] }));
  await assert.doesNotReject(() => runRanking(s, client, noop));
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

test('evolution: malformed JSON does not throw, no new hypotheses added', async () => {
  const s = freshState('r'); s.round = 1;
  s.hypotheses = [makeHyp({ id: 'H-1', elo: 1400 })];
  const before = s.hypotheses.length;
  const client = makeMockClient(() => 'garbage');
  await runEvolution(s, client, noop);
  assert.equal(s.hypotheses.length, before);
});

test('evolution: empty active pool does not throw', async () => {
  const s = freshState('r'); s.round = 1;
  s.hypotheses = [];
  const client = makeMockClient(() => jsonBlock([]));
  await assert.doesNotReject(() => runEvolution(s, client, noop));
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

test('proximity: malformed JSON does not throw', async () => {
  const s = freshState('r'); s.round = 1;
  s.hypotheses = [makeHyp({ id: 'H-1' })];
  const client = makeMockClient(() => 'garbage');
  await assert.doesNotReject(() => runProximity(s, client, noop));
});

test('proximity: empty hypothesis list does not throw', async () => {
  const s = freshState('r'); s.round = 1;
  s.hypotheses = [];
  const client = makeMockClient(() => jsonBlock({ clusters: [], hypothesis_cluster_map: {} }));
  await assert.doesNotReject(() => runProximity(s, client, noop));
});

// ── Meta-review ───────────────────────────────────────────────────────────────

test('meta-review: populates state.meta_review with all required fields', async () => {
  const s = freshState('r'); s.round = 2; s.research_goal = 'Test goal';
  s.hypotheses = [
    makeHyp({ id: 'H-1', status: 'active', elo: 1300,
      reviews: [{ scores: { novelty: 4 }, review_summary: 'good', evolution_targets: [] }] }),
    makeHyp({ id: 'H-2', status: 'rejected', elo: 1100, reject_reason: 'Not novel', reviews: [] }),
  ];
  const client = makeMockClient(() => jsonBlock({
    recurring_critiques: [{ theme: 'Weak testability', occurrences: 3 }],
    feedback_for_generation: 'Push harder on mechanism specificity',
    feedback_for_reflection: 'Be stricter on novelty',
    research_overview: 'Strong themes around X. Gap in Y.',
    research_contacts: [{ name: 'Lab A', relevance: 'Relevant dataset' }],
  }));
  await runMetaReview(s, client, noop);
  assert.ok(s.meta_review, 'meta_review should be set on state');
  assert.equal(s.meta_review.round, 2);
  assert.ok(Array.isArray(s.meta_review.recurring_critiques));
  assert.equal(s.meta_review.recurring_critiques[0].theme, 'Weak testability');
  assert.equal(typeof s.meta_review.feedback_for_generation, 'string');
  assert.equal(typeof s.meta_review.feedback_for_reflection, 'string');
  assert.equal(typeof s.meta_review.research_overview, 'string');
  assert.ok(Array.isArray(s.meta_review.research_contacts));
});

test('meta-review: malformed JSON does not throw, meta_review not updated', async () => {
  const s = freshState('r'); s.round = 1; s.research_goal = 'g';
  s.hypotheses = [makeHyp({ id: 'H-1', status: 'active' })];
  const client = makeMockClient(() => 'not json');
  await assert.doesNotReject(() => runMetaReview(s, client, noop));
  // meta_review starts as freshState default (round:0). On parse failure it must
  // NOT be updated — round stays 0, research_overview stays empty.
  assert.equal(s.meta_review.round, 0, 'meta_review.round must stay at default on parse failure');
  assert.equal(s.meta_review.research_overview, '', 'research_overview must stay empty on parse failure');
});

test('meta-review: works with empty corpus (no hypotheses)', async () => {
  const s = freshState('r'); s.round = 1; s.research_goal = 'g';
  s.hypotheses = [];
  const client = makeMockClient(() => jsonBlock({
    recurring_critiques: [],
    feedback_for_generation: 'Start fresh',
    feedback_for_reflection: 'N/A',
    research_overview: 'No hypotheses yet.',
    research_contacts: [],
  }));
  await assert.doesNotReject(() => runMetaReview(s, client, noop));
  assert.ok(s.meta_review);
  assert.deepEqual(s.meta_review.recurring_critiques, []);
});

test('meta-review: partial JSON (missing optional fields) uses safe defaults', async () => {
  const s = freshState('r'); s.round = 1; s.research_goal = 'g';
  s.hypotheses = [makeHyp({ id: 'H-1', status: 'active' })];
  // Return JSON with only some fields
  const client = makeMockClient(() => jsonBlock({
    feedback_for_generation: 'More variety',
  }));
  await runMetaReview(s, client, noop);
  assert.ok(s.meta_review);
  assert.deepEqual(s.meta_review.recurring_critiques, []);
  assert.deepEqual(s.meta_review.research_contacts, []);
  assert.equal(s.meta_review.feedback_for_generation, 'More variety');
});
