import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';

// In a bundled single-file build import.meta.url is empty, so guard it.
let __dirname;
try { __dirname = path.dirname(fileURLToPath(import.meta.url)); } catch { __dirname = process.cwd(); }

// Base directory for assets/data. When packaged as a single-file exe (Node SEA),
// the launcher sets COSCI_BASE to the executable's folder so prompts are read
// and state/output are written next to the .exe. In dev it's the project root.
const BASE = process.env.COSCI_BASE || __dirname;

export const STATE_PATH = path.join(BASE, 'state', 'state.json');
export const OUTPUT_DIR = path.join(BASE, 'output');
export const PROMPTS_DIR = path.join(BASE, 'prompts');

// ── State I/O ──────────────────────────────────────────────────────────────

export async function saveState(state) {
  console.log(`[state] save — round=${state.round} phase=${state.phase} hypotheses=${state.hypotheses?.length ?? 0}`);
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

export async function loadState() {
  const raw = await readFile(STATE_PATH, 'utf-8');
  return JSON.parse(raw);
}

export function freshState(runId) {
  return {
    run_id: runId,
    research_goal: '',
    research_plan: {
      preferences: [],
      attributes: [],
      hard_constraints: [],
      soft_factors: []
    },
    domain_context: {
      research_anchor: '',
      target_population: '',
      context_setting: '',
      hard_constraints: [],
      soft_factors: [],
      frontier_seed_list: {
        core_fronts: [],
        cross_disciplinary_targets: [],
        frontier_phenomena: []
      },
      literature_hierarchy: {
        primary: '',
        secondary: '',
        tertiary: '',
        treat_with_caution: ''
      },
      output_language: 'English',
      output_format_preference: 'top 10 ranked hypotheses grouped by theme, abstract-style summary'
    },
    config: {
      max_rounds: 3,
      initial_elo: 1200,
      k_factor: 32,
      k_factor_debate: 64,
      contender_pool_size: 10,
      hypotheses_per_round: 15,
      n_evolved_per_round: 5,
      min_matches_per_hypothesis: 3,
      tier1_match_budget: 40,
      max_active_pool: 40,
      fronts_min: 5,
      convergence: {
        spearman_converged: 0.9,
        top5_churn_converged: 0.2
      }
    },
    round: 0,
    phase: 'idle',
    hypotheses: [],
    clusters: [],
    tournament: {
      matches: [],
      ranking: []
    },
    meta_review: {
      round: 0,
      recurring_critiques: [],
      feedback_for_generation: '',
      feedback_for_reflection: '',
      research_overview: '',
      research_contacts: []
    },
    convergence: {
      per_round: []
    },
    scientist_inputs: [],
    log: []
  };
}

// ── Hypothesis ID generation ───────────────────────────────────────────────

export function nextHypothesisId(hypotheses) {
  const nums = hypotheses
    .map(h => parseInt(h.id?.replace('H-', '') || '0', 10))
    .filter(n => !isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return `H-${String(max + 1).padStart(3, '0')}`;
}

export function nextClusterId(clusters) {
  const nums = clusters
    .map(c => parseInt(c.id?.replace('C-', '') || '0', 10))
    .filter(n => !isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return `C-${String(max + 1).padStart(3, '0')}`;
}

// ── Provider detection ─────────────────────────────────────────────────────

export function detectProvider() {
  if (process.env.GOOGLE_API_KEY) return 'google';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  throw new Error('No API key found. Set GOOGLE_API_KEY or ANTHROPIC_API_KEY in your .env file.');
}

export function createClient() {
  const provider = detectProvider();
  if (provider === 'google') {
    return { provider: 'google', client: new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY }) };
  }
  return { provider: 'anthropic', client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) };
}

// ── API calling with streaming ─────────────────────────────────────────────

const DEFAULT_GOOGLE_MODEL    = 'gemini-2.0-flash';
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-5';

export async function callAgent(clientObj, systemPromptPath, userMessage, onChunk) {
  const systemPrompt = await readFile(systemPromptPath, 'utf-8');
  const { provider, client } = clientObj;
  // Read model live so mid-run changes via set-model IPC apply immediately
  const model = clientObj.model || (provider === 'google' ? DEFAULT_GOOGLE_MODEL : DEFAULT_ANTHROPIC_MODEL);

  if (provider === 'google') {
    return callAgentGoogle(client, systemPrompt, userMessage, onChunk, model);
  }
  return callAgentAnthropic(client, systemPrompt, userMessage, onChunk, model);
}

async function callAgentAnthropic(client, systemPrompt, userMessage, onChunk, model) {
  const stream = client.messages.stream({
    model,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  });

  let fullText = '';
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      fullText += chunk.delta.text;
      if (onChunk) onChunk(chunk.delta.text);
    }
  }
  return fullText;
}

async function callAgentGoogle(client, systemPrompt, userMessage, onChunk, model) {
  const response = await client.models.generateContentStream({
    model,
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: 8192,
      temperature: 1.0,
    }
  });

  let fullText = '';
  for await (const chunk of response) {
    const text = chunk.text ?? '';
    if (text) {
      fullText += text;
      if (onChunk) onChunk(text);
    }
  }
  return fullText;
}

export async function callAgentWithRetry(clientObj, systemPromptPath, userMessage, onChunk, maxAttempts = 3) {
  const agentName = path.basename(systemPromptPath, '.md');
  const model = clientObj.model || (clientObj.provider === 'google' ? DEFAULT_GOOGLE_MODEL : DEFAULT_ANTHROPIC_MODEL);
  console.log(`[${agentName}] Calling ${clientObj.provider}/${model} (attempt 1/${maxAttempts})`);

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await callAgent(clientObj, systemPromptPath, userMessage, onChunk);
      console.log(`[${agentName}] Response received (${result.length} chars)`);
      return result;
    } catch (err) {
      lastErr = err;
      console.warn(`[${agentName}] Attempt ${attempt} failed: ${err.message}`);
      if (attempt < maxAttempts) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`[${agentName}] Retrying in ${delay}ms…`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  console.error(`[${agentName}] All ${maxAttempts} attempts failed: ${lastErr.message}`);
  throw lastErr;
}


// ── JSON extraction ────────────────────────────────────────────────────────

export function extractJSON(text) {
  // Try fenced JSON block first
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (e) { console.warn(`[extractJSON] fenced block parse failed: ${e.message}`); }
  }
  // Try bare JSON array or object
  const bare = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (bare) {
    try { return JSON.parse(bare[1]); } catch (e) { console.warn(`[extractJSON] bare JSON parse failed: ${e.message}`); }
  }
  console.error('[extractJSON] No valid JSON found in response');
  throw new Error('No valid JSON found in response');
}

// ── Debug dump ────────────────────────────────────────────────────────────

export async function saveDebug(runId, agentName, round, text) {
  const dir = path.join(OUTPUT_DIR, runId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `debug-${agentName}-round${round}.txt`);
  await writeFile(file, text, 'utf-8');
}

// ── Output file helpers ───────────────────────────────────────────────────

export async function ensureRunDir(runId) {
  const dir = path.join(OUTPUT_DIR, runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function saveRoundSnapshot(state) {
  const dir = await ensureRunDir(state.run_id);
  const file = path.join(dir, `round-${state.round}.json`);
  await writeFile(file, JSON.stringify(state, null, 2), 'utf-8');
}

export async function saveFinalCorpus(state) {
  const dir = await ensureRunDir(state.run_id);
  const active = state.hypotheses.filter(h => h.status === 'active');
  active.sort((a, b) => (b.elo || 1200) - (a.elo || 1200));
  await writeFile(
    path.join(dir, 'final-corpus.json'),
    JSON.stringify({ run_id: state.run_id, hypotheses: active }, null, 2),
    'utf-8'
  );
}

export async function saveFinalReport(state) {
  const dir = await ensureRunDir(state.run_id);
  const active = state.hypotheses.filter(h => h.status === 'active');
  active.sort((a, b) => (b.elo || 1200) - (a.elo || 1200));

  const top10 = active.slice(0, 10);

  // Group by theme
  const byTheme = {};
  for (const h of top10) {
    const t = h.theme || 'Uncategorised';
    if (!byTheme[t]) byTheme[t] = [];
    byTheme[t].push(h);
  }

  const convergenceTable = state.convergence.per_round.map(r =>
    `| ${r.round} | ${r.spearman_vs_prev?.toFixed(3) ?? 'N/A'} | ${r.top5_churn?.toFixed(2) ?? 'N/A'} | ${r.best_elo} | ${r.top10_avg_elo?.toFixed(0) ?? 'N/A'} |`
  ).join('\n');

  const themeBlocks = Object.entries(byTheme).map(([theme, hyps]) => {
    const hBlocks = hyps.map(h =>
      `#### ${h.id} — ${h.title}\n\n**Statement:** ${h.statement}\n\n**Grounding:** ${h.grounding}\n\n**Elo:** ${h.elo || 1200}`
    ).join('\n\n');
    return `### ${theme}\n\n${hBlocks}`;
  }).join('\n\n');

  const allActiveBlock = active.map(h =>
    `| ${h.id} | ${h.elo || 1200} | ${h.title} | ${h.status} |`
  ).join('\n');

  const report = `# LabMate Final Report

**Run ID:** ${state.run_id}
**Research Goal:** ${state.research_goal}
**Rounds completed:** ${state.round}
**Total hypotheses:** ${state.hypotheses.length} (${active.length} active)

---

## Run Configuration

- Max rounds: ${state.config.max_rounds}
- Hypotheses per round: ${state.config.hypotheses_per_round}
- Evolved per round: ${state.config.n_evolved_per_round}
- Initial Elo: ${state.config.initial_elo}
- Contender pool size: ${state.config.contender_pool_size}

---

## Convergence Table

| Round | Spearman ρ | Top-5 Churn | Best Elo | Top-10 Avg |
|-------|-----------|------------|---------|-----------|
${convergenceTable}

---

## Top 10 Hypotheses by Theme

${themeBlocks}

---

## Meta-Review Research Overview

${state.meta_review.research_overview || 'N/A'}

---

## Full Active Corpus (sorted by Elo)

| ID | Elo | Title | Status |
|----|-----|-------|--------|
${allActiveBlock}
`;

  await writeFile(path.join(dir, 'final-report.md'), report, 'utf-8');
}

// ── Logging ────────────────────────────────────────────────────────────────

export function logEvent(state, agent, message) {
  state.log.push({
    ts: new Date().toISOString(),
    agent,
    message
  });
}
