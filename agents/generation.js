import path from 'path';
import {
  callAgentWithRetry, extractJSON, saveDebug, logEvent,
  nextHypothesisId, PROMPTS_DIR
} from '../utils.js';

export async function runGeneration(state, anthropic, onChunk = chunk => process.stdout.write(chunk)) {
  const isFirstRound = state.round === 1;
  const dc = state.domain_context;
  const cfg = state.config;

  const existingIds = state.hypotheses.map(h => h.id).join(', ') || 'none';
  const existingTitles = state.hypotheses.map(h => h.title).join('\n- ') || 'none';

  const metaFeedback = state.meta_review.feedback_for_generation
    ? `\n## Meta-review feedback from previous round\n${state.meta_review.feedback_for_generation}`
    : '';

  const userMessage = `## Research Goal
${state.research_goal}

## Domain Context
Research anchor: ${dc.research_anchor}
Target population: ${dc.target_population}
Context setting: ${dc.context_setting}

Hard constraints:
${dc.hard_constraints.map(c => `- ${c}`).join('\n') || 'none'}

Soft factors:
${dc.soft_factors.map(f => `- ${f}`).join('\n') || 'none'}

## Frontier Seed List
Core fronts: ${dc.frontier_seed_list.core_fronts.join(', ') || 'none'}
Cross-disciplinary targets: ${dc.frontier_seed_list.cross_disciplinary_targets.join(', ') || 'none'}
Frontier phenomena: ${dc.frontier_seed_list.frontier_phenomena.join(', ') || 'none'}

## Literature Hierarchy
Primary: ${dc.literature_hierarchy.primary}
Secondary: ${dc.literature_hierarchy.secondary}
Tertiary: ${dc.literature_hierarchy.tertiary}
Treat with caution: ${dc.literature_hierarchy.treat_with_caution}
${metaFeedback}

## Instructions
Round: ${state.round}
Techniques available: ${isFirstRound ? 'literature, debate, assumptions' : 'literature, debate, assumptions, expansion'}
Generate exactly ${cfg.hypotheses_per_round} hypotheses.
Minimum ${cfg.fronts_min} distinct thematic fronts.

## Existing corpus (do NOT duplicate)
IDs: ${existingIds}
Titles:
- ${existingTitles}

Return a JSON array only.`;

  let raw = '';
  try {
    raw = await callAgentWithRetry(
      anthropic,
      path.join(PROMPTS_DIR, 'generation.md'),
      userMessage,
      onChunk
    );
    onChunk('\n');

    const parsed = extractJSON(raw);
    const newHyps = Array.isArray(parsed) ? parsed : parsed.hypotheses || [];

    for (const h of newHyps) {
      // state.hypotheses already includes everything pushed so far this loop,
      // so nextHypothesisId stays correct without rebuilding arrays each time.
      const id = nextHypothesisId(state.hypotheses);
      state.hypotheses.push({
        id,
        origin: 'generation',
        parent_ids: [],
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
        technique: h.technique || 'literature',
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

    logEvent(state, 'generation', `Generated ${newHyps.length} hypotheses in round ${state.round}`);
  } catch (err) {
    await saveDebug(state.run_id, 'generation', state.round, raw);
    logEvent(state, 'generation', `ERROR: ${err.message}`);
    console.error(`\n[Generation] Error: ${err.message} — saved debug file, continuing.`);
  }

  return state;
}
