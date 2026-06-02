import path from 'path';
import {
  callAgentWithRetry, extractJSON, saveDebug, logEvent,
  nextHypothesisId, PROMPTS_DIR
} from '../utils.js';

export async function runEvolution(state, anthropic, onChunk = chunk => process.stdout.write(chunk)) {
  const active = state.hypotheses.filter(h => h.status === 'active');
  if (active.length === 0) {
    logEvent(state, 'evolution', 'No active hypotheses to evolve');
    return state;
  }

  // Source pool: top-ranked by Elo
  const poolSize = Math.min(state.config.n_evolved_per_round * 3, active.length, 15);
  const sortedActive = [...active].sort((a, b) => (b.elo || 1200) - (a.elo || 1200));
  const sourcePool = sortedActive.slice(0, poolSize);

  // Gather evolution targets from latest reviews
  const evolutionTargets = {};
  for (const h of sourcePool) {
    const latest = h.reviews[h.reviews.length - 1];
    if (latest?.evolution_targets?.length) {
      evolutionTargets[h.id] = latest.evolution_targets;
    }
  }

  const poolJson = JSON.stringify(sourcePool.map(h => ({
    id: h.id,
    title: h.title,
    statement: h.statement,
    grounding: h.grounding,
    constructs: h.constructs,
    elo: h.elo || 1200,
    evolution_targets: evolutionTargets[h.id] || []
  })), null, 2);

  const userMessage = `## Research Goal
${state.research_goal}

## Top-ranked source pool for evolution (${sourcePool.length} hypotheses)
${poolJson}

## Constraints
- Produce exactly ${state.config.n_evolved_per_round} new hypotheses
- Hard constraints: ${state.domain_context.hard_constraints.join('; ') || 'none'}
- Apply all relevant evolution strategies
- Genuine improvement required — not mere wording changes

Return a JSON array of evolved hypotheses with parent_ids and strategy fields.`;

  let raw = '';
  try {
    raw = await callAgentWithRetry(
      anthropic,
      path.join(PROMPTS_DIR, 'evolution.md'),
      userMessage,
      onChunk
    );
    onChunk('\n');

    const parsed = extractJSON(raw);
    const evolved = Array.isArray(parsed) ? parsed : [];

    for (const h of evolved) {
      const id = nextHypothesisId(state.hypotheses);
      state.hypotheses.push({
        id,
        origin: 'evolution',
        parent_ids: h.parent_ids || [],
        round_created: state.round,
        front: h.front || '',
        theme: h.theme || '',
        title: h.title || '',
        category: h.category || '',
        statement: h.statement || '',
        grounding: h.grounding || '',
        constructs: h.constructs || [],
        source_field: h.source_field || '',
        novelty_signal: h.novelty_signal || '',
        technique: h.technique || h.strategy || 'evolution',
        cluster_id: null,
        reviews: [],
        status: 'new',
        reject_reason: null,
        elo: state.config.initial_elo,
        elo_history: [],
        match_count: 0,
        wins: 0,
        losses: 0
      });
    }

    logEvent(state, 'evolution', `Created ${evolved.length} evolved hypotheses`);
  } catch (err) {
    await saveDebug(state.run_id, 'evolution', state.round, raw);
    logEvent(state, 'evolution', `ERROR: ${err.message}`);
    console.error(`\n[Evolution] Error: ${err.message} — saved debug file, continuing.`);
  }

  return state;
}
