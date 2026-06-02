# CoScientist

A production-quality Node.js CLI implementing the CoScientist multi-agent hypothesis generation
system (Gottweis et al., 2025 — arXiv:2502.18864v1).

Six specialized AI agents (Generation, Proximity, Reflection, Ranking, Evolution, Meta-review)
are orchestrated by a Supervisor in a non-linear pipeline to generate, debate, evolve, and rank
research hypotheses. State is persisted to disk between sessions.

## Testing

```bash
npm test          # runs the full suite (≈3.5s, zero extra deps)
```

The suite uses Node's built-in `node:test`. A runner (`test/run.mjs`) isolates all
file I/O under a throwaway `COSCI_BASE`, so tests never touch your real `state/`,
`output/`, or `.env`. Layers:

| File | Covers |
|---|---|
| `test/elo.test.mjs` | Elo formula + rating updates (K-factors, draws, history) |
| `test/convergence.test.mjs` | Spearman ρ, top-5 churn, `isConverged`, `pruneActivePool` |
| `test/utils.test.mjs` | `extractJSON`, ID generators, `freshState`, state round-trip, provider detection |
| `test/agents.test.mjs` | All 6 agents driven by a **mock LLM client** + error/fallback paths |
| `test/server.test.mjs` | HTTP endpoints, SSE, save-key round-trip (server booted in-process) |
| `test/renderer-smoke.test.mjs` | Loads each UI script in a stubbed-DOM `vm` — fails on any load-time throw (TDZ, undefined refs, handler-scope bugs) |
| `test/static.test.mjs` | `node --check` syntax pass on every source file |

CI (`.github/workflows/ci.yml`) runs the suite on every push/PR across Node 20 & 22,
then builds the Windows `.exe` and smoke-tests that it boots and serves the API.

## Setup

```bash
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY (or GOOGLE_API_KEY)
npm install
```

## Usage

```bash
# Interactive run — launches intake wizard
node main.js run

# Skip wizard, use a saved intake config
node main.js run --config intake.example.json

# Resume from a crashed/stopped run
node main.js resume

# Print current run status
node main.js status

# Export final report from current state
node main.js export

# Clear state and start fresh
node main.js reset
```

## How it works

Each run proceeds through N rounds (default 3). Each round:

1. **Generation** — produces N new hypotheses using literature, debate, assumptions, and expansion techniques
2. **Proximity** — clusters hypotheses by semantic similarity
3. **Reflection** — reviews each new hypothesis on 5 criteria (alignment, plausibility, novelty, testability, safety) and gates them active/rejected
4. **Ranking** — runs a two-tier Elo tournament (Tier 1: pairwise comparisons, Tier 2: structured debates for top contenders)
5. **Evolution** — refines and combines top-ranked hypotheses to produce stronger descendants
6. **Meta-review** — synthesises patterns across all reviews and produces actionable feedback for the next round

State is written to `state/state.json` after every agent completes. Round snapshots and the
final report are saved to `output/[run-id]/`.

## Output

- `output/[run-id]/round-N.json` — full state snapshot per round
- `output/[run-id]/final-corpus.json` — all active hypotheses sorted by Elo
- `output/[run-id]/final-report.md` — human-readable report with top 10 hypotheses, convergence table, and meta-review

## Reference

Gottweis et al. (2025). "Towards an AI co-scientist." arXiv:2502.18864v1
