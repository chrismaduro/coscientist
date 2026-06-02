// Shared test helpers — mock LLM client, fixtures.

/**
 * Build a mock client object matching the shape utils.callAgent expects.
 * `responder(callIndex, opts)` returns the full text the "LLM" emits for each call.
 * Defaults to the Anthropic streaming path (also exercises callAgentAnthropic).
 */
export function makeMockClient(responder, provider = 'anthropic') {
  let call = 0;
  if (provider === 'anthropic') {
    return {
      provider: 'anthropic',
      client: {
        messages: {
          stream(opts) {
            const text = responder(call++, opts);
            return (async function* () {
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
            })();
          },
        },
      },
    };
  }
  // Google path
  return {
    provider: 'google',
    client: {
      models: {
        async generateContentStream(opts) {
          const text = responder(call++, opts);
          return (async function* () { yield { text }; })();
        },
      },
    },
  };
}

/** A minimal active hypothesis with sane defaults. */
export function makeHyp(overrides = {}) {
  return {
    id: 'H-001', origin: 'generation', parent_ids: [], round_created: 1,
    front: 'F', theme: 'T', title: 'Title', category: 'c', statement: 'A predicts B',
    grounding: 'g', constructs: ['a', 'b'], source_field: 'sf', novelty_signal: 'n',
    technique: 'literature', cluster_id: null, reviews: [], status: 'active',
    reject_reason: null, elo: 1200, elo_history: [], match_count: 0, wins: 0, losses: 0,
    ...overrides,
  };
}

/** Fence a JS object as a ```json block (what agents parse). */
export function jsonBlock(obj) {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}
