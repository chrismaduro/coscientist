import chalk from 'chalk';
import { saveState, saveRoundSnapshot, logEvent } from '../utils.js';
import { runGeneration } from './generation.js';
import { runProximity } from './proximity.js';
import { runReflection } from './reflection.js';
import { runRanking } from './ranking.js';
import { runEvolution } from './evolution.js';
import { runMetaReview } from './meta-review.js';

// ── Convergence ────────────────────────────────────────────────────────────

export function computeConvergence(state, round) {
  const active = state.hypotheses.filter(h => h.status === 'active');
  const ranking = state.tournament.ranking;
  const prev = state.convergence.per_round[state.convergence.per_round.length - 1];

  let spearman = null;
  let top5Churn = null;

  if (prev && prev.ranking && prev.ranking.length > 0) {
    const top5Now = new Set(ranking.slice(0, 5));
    const top5Prev = new Set(prev.ranking.slice(0, 5));
    const overlap = [...top5Now].filter(id => top5Prev.has(id)).length;
    top5Churn = 1 - overlap / 5;

    const common = ranking.filter(id => prev.ranking.includes(id));
    if (common.length > 1) {
      const n = common.length;
      const dSq = common.reduce((sum, id) => {
        const r1 = ranking.indexOf(id);
        const r2 = prev.ranking.indexOf(id);
        return sum + Math.pow(r1 - r2, 2);
      }, 0);
      spearman = 1 - (6 * dSq) / (n * (n * n - 1));
    }
  }

  const eloValues = active.map(h => h.elo || 1200);
  const bestElo = eloValues.length ? Math.max(...eloValues) : 1200;
  const worstElo = eloValues.length ? Math.min(...eloValues) : 1200;
  const top10Avg = active.length
    ? active.slice(0, 10).reduce((s, h) => s + (h.elo || 1200), 0) / Math.min(10, active.length)
    : 1200;

  // Cluster size distribution
  const clusterSizes = state.clusters.map(c => c.member_ids.length);
  const singletonClusters = clusterSizes.filter(s => s === 1).length;

  state.convergence.per_round.push({
    round,
    spearman_vs_prev: spearman,
    top5_churn: top5Churn,
    best_elo: bestElo,
    worst_elo: worstElo,
    elo_spread: bestElo - worstElo,
    top10_avg_elo: Math.round(top10Avg),
    singleton_clusters: singletonClusters,
    total_clusters: state.clusters.length,
    ranking: [...ranking]
  });

  return state;
}

export function isConverged(state) {
  const cfg = state.config.convergence;
  const last = state.convergence.per_round[state.convergence.per_round.length - 1];
  if (!last) return false;
  if (last.spearman_vs_prev !== null && last.spearman_vs_prev >= cfg.spearman_converged) return true;
  if (last.top5_churn !== null && last.top5_churn <= cfg.top5_churn_converged) return true;
  return false;
}

// ── Active-pool pruning ────────────────────────────────────────────────────
// Retire the lowest-Elo hypotheses once the active pool exceeds the cap, so the
// fixed match budget stays concentrated on viable contenders and prompts don't
// bloat across rounds. Only prunes hypotheses that have actually competed
// (match_count > 0) and were created in a PRIOR round — never the current
// round's fresh output, which hasn't had a fair chance yet.

export function pruneActivePool(state) {
  const cap = state.config.max_active_pool;
  if (!cap) return state;

  const active = state.hypotheses.filter(h => h.status === 'active');
  if (active.length <= cap) return state;

  const prunable = active
    .filter(h => h.match_count > 0 && h.round_created < state.round)
    .sort((a, b) => (a.elo || 1200) - (b.elo || 1200)); // lowest Elo first

  const toRemove = active.length - cap;
  let removed = 0;
  for (const h of prunable) {
    if (removed >= toRemove) break;
    h.status = 'rejected';
    h.reject_reason = `pruned: Elo ${h.elo} below active-pool cap (${cap})`;
    removed++;
  }

  if (removed > 0) {
    console.log(`[supervisor] Pruned ${removed} low-Elo hypotheses (active cap ${cap})`);
    const stillActive = new Set(state.hypotheses.filter(h => h.status === 'active').map(h => h.id));
    state.tournament.ranking = state.tournament.ranking.filter(id => stillActive.has(id));
  }
  return state;
}

// ── Round summary ─────────────────────────────────────────────────────────

function printRoundSummary(state, log) {
  const active = state.hypotheses.filter(h => h.status === 'active');
  const rejected = state.hypotheses.filter(h => h.status === 'rejected');
  const evolved = state.hypotheses.filter(h => h.origin === 'evolution');
  const last = state.convergence.per_round[state.convergence.per_round.length - 1];
  const topId = state.tournament.ranking[0];
  const topHyp = state.hypotheses.find(h => h.id === topId);

  const lines = [
    '══════════════════════════════════════════',
    `Round ${state.round} / ${state.config.max_rounds} complete`,
    `  Active: ${active.length}  │  Rejected: ${rejected.length}  │  Evolved: ${evolved.length}`,
  ];
  if (last) {
    lines.push(`  Spearman ρ: ${last.spearman_vs_prev?.toFixed(3) ?? 'N/A'}  │  Top-5 churn: ${last.top5_churn?.toFixed(2) ?? 'N/A'}`);
    lines.push(`  Elo spread: ${last.elo_spread}  │  Singletons: ${last.singleton_clusters}/${last.total_clusters} clusters`);
    lines.push(`  Best Elo: ${last.best_elo}  │  Top-10 avg: ${last.top10_avg_elo}`);
  }
  if (topHyp) {
    lines.push(`  Top: ${topHyp.id} "${topHyp.title}" (${topHyp.elo})`);
  }
  lines.push('══════════════════════════════════════════');

  for (const line of lines) log(line);
}

// ── Core round loop ────────────────────────────────────────────────────────

/**
 * @param {object} state
 * @param {object} anthropic
 * @param {object} opts
 * @param {(agentName: string, chunk: string) => void} [opts.onChunk]
 * @param {(agentName: string, summary: string) => void} [opts.onAgentDone]
 * @param {number|null} [opts.stopAt] - Date.now() timestamp; null = no time limit
 */
export async function runRound(state, anthropic, opts = {}) {
  const {
    onChunk = (agent, chunk) => process.stdout.write(chunk),
    onAgentDone = (agent, summary) => console.log(chalk.gray(`[${agent}] ${summary}`)),
    stopAt = null
  } = opts;

  const round = state.round;
  const chunk = (agent, text) => onChunk(agent, text);

  console.log(`[supervisor] ── Round ${round} started ──`);

  // Phase 1: Generate + Cluster
  state.phase = 'generate';
  console.log(`[supervisor] Phase: generate`);
  await saveState(state);

  onChunk('generation', `\n[Generation] Round ${round} — generating hypotheses...\n`);
  state = await runGeneration(state, anthropic, c => chunk('generation', c));
  await saveState(state);
  const newCount = state.hypotheses.filter(h => h.status === 'new').length;
  onAgentDone('Generation', `${newCount} new hypotheses`);

  onChunk('proximity', '\n[Proximity] Clustering hypotheses...\n');
  state = await runProximity(state, anthropic, c => chunk('proximity', c));
  await saveState(state);
  onAgentDone('Proximity', `${state.clusters.length} clusters`);

  // Phase 2: Review + Rank
  state.phase = 'debate';
  console.log(`[supervisor] Phase: debate`);
  await saveState(state);

  const newHyps = state.hypotheses.filter(h => h.status === 'new');
  onChunk('reflection', `\n[Reflection] Reviewing ${newHyps.length} new hypotheses...\n`);
  state = await runReflection(state, anthropic, newHyps, c => chunk('reflection', c));
  await saveState(state);
  const activeAfter = state.hypotheses.filter(h => h.status === 'active').length;
  const rejectedCount = state.hypotheses.filter(h => h.status === 'rejected').length;
  onAgentDone('Reflection', `${activeAfter} active, ${rejectedCount} rejected`);

  onChunk('ranking', '\n[Ranking] Running tournament...\n');
  state = await runRanking(state, anthropic, c => chunk('ranking', c));
  await saveState(state);
  onAgentDone('Ranking', `${state.tournament.matches.length} total matches`);

  // Phase 3: Evolve
  state.phase = 'evolve';
  console.log(`[supervisor] Phase: evolve`);
  await saveState(state);

  onChunk('evolution', '\n[Evolution] Evolving top hypotheses...\n');
  state = await runEvolution(state, anthropic, c => chunk('evolution', c));
  await saveState(state);

  const evolved = state.hypotheses.filter(h => h.origin === 'evolution' && h.status === 'new');
  if (evolved.length > 0) {
    onChunk('reflection', `\n[Reflection] Reviewing ${evolved.length} evolved hypotheses...\n`);
    state = await runReflection(state, anthropic, evolved, c => chunk('reflection', c));
    await saveState(state);
  }
  onAgentDone('Evolution', `${evolved.length} evolved hypotheses`);

  onChunk('meta-review', '\n[Meta-review] Synthesising patterns...\n');
  state = await runMetaReview(state, anthropic, c => chunk('meta-review', c));
  await saveState(state);
  onAgentDone('Meta-review', 'Done');

  // Prune the active pool before measuring convergence so metrics reflect the
  // surviving contenders.
  state = pruneActivePool(state);
  await saveState(state);

  // Convergence
  state = computeConvergence(state, round);
  await saveState(state);

  await saveRoundSnapshot(state);

  logEvent(state, 'supervisor', `Round ${round} complete`);

  printRoundSummary(state, line => onChunk('supervisor', line + '\n'));

  return state;
}

// ── Main run loop (called by both CLI and Electron) ────────────────────────

/**
 * @param {object} state - initial state (already saved to disk before calling)
 * @param {object} anthropic
 * @param {object} opts
 * @param {(agentName, chunk) => void} [opts.onChunk]
 * @param {(agentName, summary) => void} [opts.onAgentDone]
 * @param {(state) => void} [opts.onRoundComplete]
 * @param {number|null} [opts.stopAt] - timestamp ms; null = unlimited rounds
 * @param {() => boolean} [opts.shouldStop] - checked before each round; return true to halt
 */
export async function runLoop(state, anthropic, opts = {}) {
  const {
    onChunk = (agent, chunk) => process.stdout.write(chunk),
    onAgentDone = (agent, summary) => {},
    onRoundComplete = (state) => {},
    stopAt = null,
    shouldStop = () => false
  } = opts;

  const startRound = state.round || 1;

  for (let round = startRound; round <= 9999; round++) {
    // Time-based stop: don't start a new round if time is up
    if (stopAt && Date.now() >= stopAt) {
      onChunk('supervisor', '\n[Supervisor] Time limit reached — stopping after this round.\n');
      break;
    }
    if (shouldStop()) break;

    state.round = round;
    await saveState(state);

    state = await runRound(state, anthropic, { onChunk, onAgentDone, stopAt });

    onRoundComplete(state);

    if (isConverged(state)) {
      onChunk('supervisor', '\n[Supervisor] Convergence detected — stopping early.\n');
      break;
    }

    // Check time again before committing to another round
    if (stopAt && Date.now() >= stopAt) {
      onChunk('supervisor', '\n[Supervisor] Time limit reached.\n');
      break;
    }

    // In manual mode (no stopAt), check max_rounds
    if (!stopAt && round >= state.config.max_rounds) break;

    if (shouldStop()) break;
  }

  // Final ranking pass: the last round's Evolution creates hypotheses that are
  // reviewed but never ranked (ranking runs before evolution within a round).
  // Without this they'd land in the report frozen at the initial Elo, never
  // having competed. Rank them now so the final corpus is fully ordered.
  const unranked = state.hypotheses.filter(h => h.status === 'active' && h.match_count === 0);
  if (unranked.length > 0) {
    onChunk('supervisor', `\n[Supervisor] Final ranking pass for ${unranked.length} unranked hypotheses...\n`);
    state = await runRanking(state, anthropic, c => onChunk('ranking', c));
    await saveState(state);
  }

  return state;
}
