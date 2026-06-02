import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJSON, nextHypothesisId, nextClusterId, freshState,
  saveState, loadState, STATE_PATH, detectProvider,
} from '../utils.js';

// ── extractJSON ──────────────────────────────────────────────────────────────
test('extractJSON: fenced ```json block', () => {
  const v = extractJSON('blah\n```json\n{"a":1}\n```\ntrailing');
  assert.deepEqual(v, { a: 1 });
});

test('extractJSON: bare array', () => {
  assert.deepEqual(extractJSON('here: [1,2,3] done'), [1, 2, 3]);
});

test('extractJSON: bare object', () => {
  assert.deepEqual(extractJSON('x {"k":"v"} y'), { k: 'v' });
});

test('extractJSON: prefers fenced block over surrounding prose braces', () => {
  const v = extractJSON('I think {not json} but ```json\n[{"id":"H-1"}]\n```');
  assert.deepEqual(v, [{ id: 'H-1' }]);
});

test('extractJSON: throws on no JSON', () => {
  assert.throws(() => extractJSON('no json at all here'));
});

// ── ID generators ────────────────────────────────────────────────────────────
test('nextHypothesisId: empty → H-001', () => {
  assert.equal(nextHypothesisId([]), 'H-001');
});

test('nextHypothesisId: increments from max, zero-padded', () => {
  assert.equal(nextHypothesisId([{ id: 'H-001' }, { id: 'H-009' }]), 'H-010');
});

test('nextHypothesisId: ignores malformed ids', () => {
  assert.equal(nextHypothesisId([{ id: 'H-003' }, { id: 'weird' }, {}]), 'H-004');
});

test('nextClusterId: empty → C-001, then increments', () => {
  assert.equal(nextClusterId([]), 'C-001');
  assert.equal(nextClusterId([{ id: 'C-001' }, { id: 'C-002' }]), 'C-003');
});

// ── freshState shape ─────────────────────────────────────────────────────────
test('freshState: has all required top-level keys', () => {
  const s = freshState('run-x');
  for (const k of ['run_id', 'research_goal', 'domain_context', 'config', 'round',
    'phase', 'hypotheses', 'clusters', 'tournament', 'meta_review', 'convergence', 'log']) {
    assert.ok(k in s, `missing key: ${k}`);
  }
  assert.equal(s.run_id, 'run-x');
  assert.equal(s.config.initial_elo, 1200);
  assert.equal(s.config.max_active_pool, 40);
  assert.deepEqual(s.hypotheses, []);
});

// ── State save/load round-trip (writes under temp COSCI_BASE) ─────────────────
test('saveState/loadState round-trip', async () => {
  const s = freshState('run-roundtrip');
  s.round = 2;
  s.hypotheses.push({ id: 'H-001', title: 'persisted' });
  await saveState(s);
  const loaded = await loadState();
  assert.equal(loaded.run_id, 'run-roundtrip');
  assert.equal(loaded.round, 2);
  assert.equal(loaded.hypotheses[0].title, 'persisted');
  assert.ok(STATE_PATH.includes('state.json'));
});

// ── Provider detection ───────────────────────────────────────────────────────
test('detectProvider: GOOGLE_API_KEY → google', () => {
  const g = process.env.GOOGLE_API_KEY, a = process.env.ANTHROPIC_API_KEY;
  process.env.GOOGLE_API_KEY = 'AIzaTest';
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(detectProvider(), 'google');
  if (g === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = g;
  if (a !== undefined) process.env.ANTHROPIC_API_KEY = a;
});

test('detectProvider: anthropic when only that key set', () => {
  const g = process.env.GOOGLE_API_KEY, a = process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  assert.equal(detectProvider(), 'anthropic');
  if (g !== undefined) process.env.GOOGLE_API_KEY = g;
  if (a === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = a;
});

test('detectProvider: throws when no key', () => {
  const g = process.env.GOOGLE_API_KEY, a = process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.throws(() => detectProvider());
  if (g !== undefined) process.env.GOOGLE_API_KEY = g;
  if (a !== undefined) process.env.ANTHROPIC_API_KEY = a;
});
