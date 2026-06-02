import path from 'path';
import {
  callAgentWithRetry, extractJSON, saveDebug, logEvent, PROMPTS_DIR
} from '../utils.js';

export async function runMetaReview(state, anthropic, onChunk = chunk => process.stdout.write(chunk)) {
  const active = state.hypotheses.filter(h => h.status === 'active');
  const rejected = state.hypotheses.filter(h => h.status === 'rejected');
  const top10 = [...active]
    .sort((a, b) => (b.elo || 1200) - (a.elo || 1200))
    .slice(0, 10);

  // Collect all reviews
  const allReviews = state.hypotheses.flatMap(h =>
    h.reviews.map(r => ({ hypothesis_id: h.id, title: h.title, ...r }))
  );

  const userMessage = `## Research Goal
${state.research_goal}

## Round ${state.round} summary
Total hypotheses: ${state.hypotheses.length}
Active: ${active.length}
Rejected: ${rejected.length}

## Top 10 ranked hypotheses
${JSON.stringify(top10.map(h => ({
  id: h.id,
  title: h.title,
  elo: h.elo,
  statement: h.statement,
  grounding: h.grounding
})), null, 2)}

## All reviews this round
${JSON.stringify(allReviews.slice(-50), null, 2)}

## Rejected hypotheses
${JSON.stringify(rejected.map(h => ({
  id: h.id,
  title: h.title,
  reject_reason: h.reject_reason
})), null, 2)}

## Tournament matches
${JSON.stringify(state.tournament.matches.slice(-20), null, 2)}

Synthesise patterns. Return only valid JSON with the required fields.`;

  let raw = '';
  try {
    raw = await callAgentWithRetry(
      anthropic,
      path.join(PROMPTS_DIR, 'meta-review.md'),
      userMessage,
      onChunk
    );
    onChunk('\n');

    const parsed = extractJSON(raw);

    state.meta_review = {
      round: state.round,
      recurring_critiques: parsed.recurring_critiques || [],
      feedback_for_generation: parsed.feedback_for_generation || '',
      feedback_for_reflection: parsed.feedback_for_reflection || '',
      research_overview: parsed.research_overview || '',
      research_contacts: parsed.research_contacts || []
    };

    logEvent(state, 'meta-review', `Synthesised ${allReviews.length} reviews, ${parsed.recurring_critiques?.length || 0} recurring critiques`);
  } catch (err) {
    await saveDebug(state.run_id, 'meta-review', state.round, raw);
    logEvent(state, 'meta-review', `ERROR: ${err.message}`);
    console.error(`\n[Meta-review] Error: ${err.message} — saved debug file, continuing.`);
  }

  return state;
}
