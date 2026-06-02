import path from 'path';
import {
  callAgentWithRetry, extractJSON, saveDebug, logEvent, PROMPTS_DIR
} from '../utils.js';

export async function runReflection(state, anthropic, hypothesesToReview, onChunk = chunk => process.stdout.write(chunk)) {
  if (!hypothesesToReview || hypothesesToReview.length === 0) {
    logEvent(state, 'reflection', 'No hypotheses to review');
    return state;
  }

  const hypJson = JSON.stringify(hypothesesToReview.map(h => ({
    id: h.id,
    title: h.title,
    statement: h.statement,
    grounding: h.grounding,
    constructs: h.constructs,
    source_field: h.source_field,
    novelty_signal: h.novelty_signal,
    front: h.front,
    theme: h.theme
  })), null, 2);

  const metaFeedback = state.meta_review.feedback_for_reflection
    ? `\n## Reflection calibration from meta-review\n${state.meta_review.feedback_for_reflection}`
    : '';

  const tournamentContext = state.round > 1
    ? `\n## Tournament context (round ${state.round})\nTop ranked: ${state.tournament.ranking.slice(0, 5).join(', ')}`
    : '';

  const userMessage = `## Research Goal
${state.research_goal}

## Hard constraints
${state.domain_context.hard_constraints.map(c => `- ${c}`).join('\n') || 'none'}
${metaFeedback}
${tournamentContext}

## Hypotheses to review (${hypothesesToReview.length})
${hypJson}

Review each hypothesis. Return a JSON array with one review object per hypothesis.
Default to status "active" — only reject clear failures.`;

  let raw = '';
  try {
    raw = await callAgentWithRetry(
      anthropic,
      path.join(PROMPTS_DIR, 'reflection.md'),
      userMessage,
      onChunk
    );
    onChunk('\n');

    const parsed = extractJSON(raw);
    const reviews = Array.isArray(parsed) ? parsed : [parsed];

    let activeCount = 0;
    let rejectedCount = 0;

    for (const review of reviews) {
      const hyp = state.hypotheses.find(h => h.id === review.hypothesis_id);
      if (!hyp) continue;

      hyp.reviews.push({
        round: state.round,
        status: review.status,
        scores: review.scores,
        reject_reason: review.reject_reason,
        evolution_targets: review.evolution_targets || [],
        review_summary: review.review_summary
      });

      hyp.status = review.status || 'active';
      hyp.reject_reason = review.reject_reason || null;

      if (hyp.status === 'active') activeCount++;
      else rejectedCount++;
    }

    logEvent(state, 'reflection', `Reviewed ${reviews.length}: ${activeCount} active, ${rejectedCount} rejected`);
  } catch (err) {
    await saveDebug(state.run_id, 'reflection', state.round, raw);
    logEvent(state, 'reflection', `ERROR: ${err.message}`);
    console.error(`\n[Reflection] Error: ${err.message} — marking all as active, saved debug file.`);
    for (const h of hypothesesToReview) {
      if (h.status === 'new') h.status = 'active';
    }
  }

  return state;
}
