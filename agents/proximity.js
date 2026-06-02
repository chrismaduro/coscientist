import path from 'path';
import {
  callAgentWithRetry, extractJSON, saveDebug, logEvent,
  nextClusterId, PROMPTS_DIR
} from '../utils.js';

export async function runProximity(state, anthropic, onChunk = chunk => process.stdout.write(chunk)) {
  const active = state.hypotheses.filter(h => h.status !== 'rejected');

  if (active.length === 0) {
    logEvent(state, 'proximity', 'No active hypotheses to cluster');
    return state;
  }

  const hypList = active.map(h =>
    `${h.id}: [${h.front}] ${h.title} — ${h.statement}`
  ).join('\n');

  const prevClusters = state.round > 1 && state.clusters.length
    ? `\n## Previous clusters (for incremental update)\n${JSON.stringify(state.clusters, null, 2)}`
    : '';

  const userMessage = `## Hypotheses to cluster (${active.length} total)
${hypList}
${prevClusters}

Cluster by semantic proximity. Return only valid JSON with "clusters" and "hypothesis_cluster_map".`;

  let raw = '';
  try {
    raw = await callAgentWithRetry(
      anthropic,
      path.join(PROMPTS_DIR, 'proximity.md'),
      userMessage,
      onChunk
    );
    onChunk('\n');

    const parsed = extractJSON(raw);
    const clusters = parsed.clusters || [];
    const clusterMap = parsed.hypothesis_cluster_map || {};

    // Normalise cluster IDs to avoid collisions with existing ones
    const existingNums = state.clusters.map(c => parseInt(c.id.replace('C-', ''), 10));
    let nextNum = existingNums.length ? Math.max(...existingNums) + 1 : 1;

    const idMap = {};
    for (const c of clusters) {
      const newId = `C-${String(nextNum++).padStart(3, '0')}`;
      idMap[c.id] = newId;
      c.id = newId;
    }

    // Remap hypothesis_cluster_map
    const remappedMap = {};
    for (const [hId, cId] of Object.entries(clusterMap)) {
      remappedMap[hId] = idMap[cId] || cId;
    }

    // Update hypotheses with cluster_id
    for (const h of state.hypotheses) {
      if (remappedMap[h.id]) {
        h.cluster_id = remappedMap[h.id];
      }
    }

    // Replace clusters list
    state.clusters = clusters;

    logEvent(state, 'proximity', `Created ${clusters.length} clusters for ${active.length} hypotheses`);
  } catch (err) {
    await saveDebug(state.run_id, 'proximity', state.round, raw);
    logEvent(state, 'proximity', `ERROR: ${err.message}`);
    console.error(`\n[Proximity] Error: ${err.message} — saved debug file, continuing.`);
  }

  return state;
}
