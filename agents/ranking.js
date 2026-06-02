import path from 'path';
import {
  callAgentWithRetry, extractJSON, saveDebug, logEvent, PROMPTS_DIR
} from '../utils.js';

// Expected score for A given the two Elo ratings (logistic curve).
export function expectedScore(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

export function applyEloUpdate(hyp, opponent, score, kFactor) {
  const eloA = hyp.elo || 1200;
  const eloB = opponent.elo || 1200;
  const expected = expectedScore(eloA, eloB);
  const newElo = Math.round(eloA + kFactor * (score - expected));
  hyp.elo_history.push({ from: eloA, to: newElo, round: hyp.match_count });
  hyp.elo = newElo;
  hyp.match_count++;
  if (score === 1) hyp.wins++;
  else if (score === 0) hyp.losses++;
}

export async function runRanking(state, anthropic, onChunk = chunk => process.stdout.write(chunk)) {
  const active = state.hypotheses.filter(h => h.status === 'active');

  if (active.length < 2) {
    logEvent(state, 'ranking', 'Not enough active hypotheses for tournament');
    return state;
  }

  const hypSummaries = active.map(h => ({
    id: h.id,
    title: h.title,
    statement: h.statement,
    cluster_id: h.cluster_id,
    elo: h.elo || 1200,
    scores: h.reviews.length ? h.reviews[h.reviews.length - 1].scores : null
  }));

  const userMessage = `## Research Goal
${state.research_goal}

## Active hypotheses (${active.length})
${JSON.stringify(hypSummaries, null, 2)}

## Clusters
${JSON.stringify(state.clusters, null, 2)}

## Config
- Tier 1 match budget: ${state.config.tier1_match_budget}
- Min matches per hypothesis: ${state.config.min_matches_per_hypothesis}
- Contender pool size: ${state.config.contender_pool_size}
- K-factor (Tier 1): ${state.config.k_factor}
- K-factor (Tier 2 debates): ${state.config.k_factor_debate}

## Previous matches this run
${state.tournament.matches.length} matches so far.

Run Tier 1 matches then Tier 2 debates for top ${state.config.contender_pool_size}.
Return JSON with "matches", "elo_updates", and "ranking" (ordered list of hypothesis IDs).`;

  let raw = '';
  try {
    raw = await callAgentWithRetry(
      anthropic,
      path.join(PROMPTS_DIR, 'ranking.md'),
      userMessage,
      onChunk
    );
    onChunk('\n');

    const parsed = extractJSON(raw);
    const matches = parsed.matches || [];

    // Apply matches to hypotheses using our own Elo math (agent only provides verdicts).
    // We deliberately ignore the agent's free-text `elo_updates` and `ranking` fields:
    // the canonical ranking is DERIVED from the Elo scores we compute here, so the
    // tournament order can never contradict the aggregated match outcomes.
    const hypMap = Object.fromEntries(state.hypotheses.map(h => [h.id, h]));

    let appliedMatches = 0;
    for (const match of matches) {
      const hypA = hypMap[match.a];
      const hypB = hypMap[match.b];
      if (!hypA || !hypB) continue;

      const kFactor = match.type === 'debate'
        ? state.config.k_factor_debate
        : state.config.k_factor;

      let scoreA, scoreB;
      if (match.winner === match.a) { scoreA = 1; scoreB = 0; }
      else if (match.winner === match.b) { scoreA = 0; scoreB = 1; }
      else { scoreA = 0.5; scoreB = 0.5; }

      applyEloUpdate(hypA, hypB, scoreA, kFactor);
      applyEloUpdate(hypB, hypA, scoreB, kFactor);
      appliedMatches++;
    }

    // Append matches to tournament history, tagged with the pipeline round
    state.tournament.matches.push(...matches.map(m => ({ ...m, pipeline_round: state.round })));

    // Canonical ranking: strictly the Elo order of all active hypotheses.
    const activeSorted = state.hypotheses
      .filter(h => h.status === 'active')
      .sort((a, b) => (b.elo || 1200) - (a.elo || 1200));
    state.tournament.ranking = activeSorted.map(h => h.id);

    // Warn if coverage was thin (cold-start risk for newly created hypotheses)
    const underMatched = activeSorted.filter(h => h.match_count < state.config.min_matches_per_hypothesis).length;
    if (underMatched > 0) {
      console.warn(`[ranking] ${underMatched} active hypotheses below ${state.config.min_matches_per_hypothesis} matches — Elo may be unreliable for them`);
    }

    logEvent(state, 'ranking', `${appliedMatches} matches applied, ranking derived from Elo`);
  } catch (err) {
    await saveDebug(state.run_id, 'ranking', state.round, raw);
    logEvent(state, 'ranking', `ERROR: ${err.message}`);
    console.error(`\n[Ranking] Error: ${err.message} — skipping ranking update, saved debug file.`);
  }

  return state;
}
