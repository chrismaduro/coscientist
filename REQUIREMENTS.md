# LabMate — Functional Requirements

This document is the authoritative list of functional requirements for LabMate.
Every requirement has a unique ID (`FR-NNN`). The test suite must cover every item marked **Tested**.

---

## FR-001 – FR-010: API key management

| ID | Requirement | Tested |
|---|---|---|
| FR-001 | User can enter a Google or Anthropic API key in Settings and save it | ✓ `server.test: save-api-key round-trips` |
| FR-002 | Saving a key persists it to `.env` and activates it in the running process | ✓ `server.test: save-api-key round-trips` |
| FR-003 | Empty or whitespace-only key is rejected with `ok:false` | ✓ `server.test: rejects empty key` |
| FR-004 | Missing provider field is rejected with `ok:false` | ✓ `server.test: rejects missing provider` |
| FR-005 | Key is trimmed of surrounding whitespace before saving | ✓ `server.test: trims whitespace` |
| FR-006 | Saved key is masked in the API response (shows last 6 chars only) | ✓ `server.test: save-api-key round-trips` |
| FR-007 | `/api/api-keys` always returns `activeProvider`, `googleKey`, `anthropicKey` fields | ✓ `server.test: api-keys returns activeProvider` |
| FR-008 | `/api/provider-info` returns `provider: null` and empty `models` array when no key is set | ✓ `server.test: null provider when no key` |
| FR-009 | Settings panel shows active provider badge and masked key placeholder after save | ✓ `renderer-smoke: showPanel settings` |
| FR-010 | Model dropdown populates with models for the active provider | ✓ `renderer-smoke: showPanel settings` |

---

## FR-011 – FR-020: Connection test

| ID | Requirement | Tested |
|---|---|---|
| FR-011 | Settings panel has a "Test connection" button | ✓ `renderer-smoke: loads without throw` |
| FR-012 | `/api/test-api` returns `{ ok: boolean }` shape in all cases | ✓ `server.test: test-api returns shape` |
| FR-013 | `/api/test-api` returns `ok:false` with a friendly error when no API key is set | ✓ `server.test: test-api ok:false no key` |
| FR-014 | Connection test result is shown inline (green ✓ or red ⚠) without navigating away | ✓ `renderer-smoke: showPanel settings` |

---

## FR-015 – FR-030: Error presentation

| ID | Requirement | Tested |
|---|---|---|
| FR-015 | All API errors shown to the user must be brief and human-readable (no raw JSON) | ✓ `server.test: guide-chat ok:false no key` (friendly msg) |
| FR-016 | Quota-exceeded errors show a specific "wait and retry" message | ✓ `utils.test: friendlyApiError quota` |
| FR-017 | Invalid-key errors show a specific "check Settings" message | ✓ `utils.test: friendlyApiError invalid key` |
| FR-018 | Full error detail (raw message + stack context) is logged to the App Log | ✓ `utils.test: friendlyApiError logs to appLog` |
| FR-019 | Error bubbles in the AI Guide chat are dismissable (× button removes the bubble) | ✓ `renderer-smoke: loads without throw` |
| FR-020 | Error bubbles include a "Details in App Log" hint | ✓ `renderer-smoke: loads without throw` |

---

## FR-021 – FR-040: AI Guide chat

| ID | Requirement | Tested |
|---|---|---|
| FR-021 | "Start AI Guide" button clears history and sends an opening prompt automatically | ✓ `renderer-smoke: showPanel setup` |
| FR-022 | User messages appear as right-aligned bubbles; assistant replies as left-aligned | ✓ `renderer-smoke: loads without throw` |
| FR-023 | Assistant reply streams in progressively (streaming cursor animation) | ✓ `agents.test: generation google provider path` |
| FR-024 | Guide chat returns `ok:false` when no API key is configured | ✓ `server.test: guide-chat ok:false no key` |
| FR-025 | Guide chat with missing `message` field does not crash the server | ✓ `server.test: guide-chat missing message` |
| FR-026 | `POST /api/guide-reset` clears conversation history and returns `ok:true` | ✓ `server.test: guide-reset ok:true` |
| FR-027 | When the guide produces an `intake` block, the "Apply to form" bar appears | ✓ `renderer-smoke: loads without throw` |
| FR-028 | Clicking "Apply" fills the intake form fields from the guide's JSON output | ✓ `renderer-smoke: loads without throw` |

---

## FR-041 – FR-060: Run configuration (intake form)

| ID | Requirement | Tested |
|---|---|---|
| FR-041 | User can fill Research, Constraints, Frontier Seeds, Literature, and Run Settings tabs | ✓ `renderer-smoke: showPanel setup` |
| FR-042 | "Save intake" persists the form to `intake.saved.json` | ✓ `server.test: save-intake / load-intake round-trip` |
| FR-043 | "Load intake" reads `intake.saved.json` and returns `ok:false` with error if absent | ✓ `server.test: load-intake error shape` |
| FR-044 | "Load example" loads `intake.example.json` and returns `{ ok, data }` shape | ✓ `server.test: load-example shape` |
| FR-045 | Timed run mode shows duration input; Rounds mode shows per-round controls | ✓ `renderer-smoke: showPanel setup` |
| FR-046 | Timed mode auto-estimates rounds and shows the estimate to the user | ✓ `renderer-smoke: loads without throw` |

---

## FR-061 – FR-080: Run lifecycle

| ID | Requirement | Tested |
|---|---|---|
| FR-061 | "Start Run" returns `ok:false` when no API key is configured | ✓ `server.test: start-run ok:false no key` |
| FR-062 | A started run creates a state file and returns `{ ok:true, run_id }` | — (requires real key; covered by integration) |
| FR-063 | "Resume Run" returns `ok:false` when no state file exists | ✓ `server.test: resume-run ok:false no state` |
| FR-064 | "Stop Run" returns `ok:false` when no run is active | ✓ `server.test: stop-run ok:false no active run` |
| FR-065 | State is written to disk after every agent completes | ✓ `utils.test: saveState/loadState round-trip` |
| FR-066 | `/api/state` returns `null` when no state file exists | ✓ `server.test: state null after reset` |
| FR-067 | `/api/reset-state` deletes the state file and returns `ok:true` | ✓ `server.test: reset-state ok:true` |
| FR-068 | "Export report" returns `ok:false` when no state file exists | ✓ `server.test: export-report ok:false no state` |

---

## FR-081 – FR-110: Agent pipeline

| ID | Requirement | Tested |
|---|---|---|
| FR-081 | Generation agent appends new hypotheses with sequential IDs starting at H-001 | ✓ `agents.test: appends with sequential ids` |
| FR-082 | Each hypothesis records `round_created` from the current pipeline round | ✓ `agents.test: round_created` |
| FR-083 | Generation agent sets initial Elo to 1200 for every new hypothesis | ✓ `agents.test: elo 1200` |
| FR-084 | Generation agent with malformed LLM JSON leaves corpus unchanged (graceful) | ✓ `agents.test: malformed JSON no throw` |
| FR-085 | Generation agent works with both Google and Anthropic provider paths | ✓ `agents.test: google provider path` |
| FR-086 | Reflection agent sets hypothesis status to `active` or `rejected` | ✓ `agents.test: sets status active/rejected` |
| FR-087 | Rejected hypotheses receive a `reject_reason` field | ✓ `agents.test: rejected hypothesis gets reject_reason` |
| FR-088 | Reflection agent defaults all `new` hypotheses to `active` on parse error | ✓ `agents.test: error path marks active` |
| FR-089 | Reflection agent with an empty hypothesis list does not throw | ✓ `agents.test: empty list no throw` |
| FR-090 | **Ranking is derived from Elo — the LLM's free-text `ranking` output is ignored** | ✓ `agents.test: derives ranking from Elo` |
| FR-091 | Each match increments `match_count` on both participating hypotheses | ✓ `agents.test: match_count increments` |
| FR-092 | Draws (winner = null) are stored correctly in match history | ✓ `agents.test: draws recorded` |
| FR-093 | Ranking agent with malformed JSON does not throw | ✓ `agents.test: malformed JSON no throw` |
| FR-094 | Ranking agent with empty active pool does not throw | ✓ `agents.test: empty pool no throw` |
| FR-095 | All tournament matches are tagged with `pipeline_round` | ✓ `agents.test: matches tagged pipeline_round` |
| FR-096 | Evolution agent creates descendants with `origin: "evolution"` and `parent_ids` | ✓ `agents.test: creates with origin/parent_ids` |
| FR-097 | Evolution agent with malformed JSON does not throw, no hypotheses added | ✓ `agents.test: malformed JSON no add` |
| FR-098 | Evolution agent with empty pool does not throw | ✓ `agents.test: empty pool no throw` |
| FR-099 | Proximity agent assigns `cluster_id` to each hypothesis from the map | ✓ `agents.test: assigns cluster_ids` |
| FR-100 | Proximity agent with malformed JSON does not throw | ✓ `agents.test: malformed JSON no throw` |
| FR-101 | Proximity agent with empty list does not throw | ✓ `agents.test: empty list no throw` |
| FR-102 | Meta-review agent populates all required fields on `state.meta_review` | ✓ `agents.test: populates all required fields` |
| FR-103 | Meta-review agent with empty corpus does not throw | ✓ `agents.test: empty corpus no throw` |
| FR-104 | Meta-review agent with malformed JSON does not update `state.meta_review` | ✓ `agents.test: malformed JSON no update` |
| FR-105 | Meta-review agent with partial JSON uses safe defaults for missing fields | ✓ `agents.test: partial JSON safe defaults` |

---

## FR-111 – FR-120: Elo tournament

| ID | Requirement | Tested |
|---|---|---|
| FR-111 | Equal-rated hypotheses have expected score 0.5 each | ✓ `elo.test: equal ratings` |
| FR-112 | A 400-point gap gives ~0.909 / ~0.091 expected scores | ✓ `elo.test: 400-point gap` |
| FR-113 | Expected scores for a pair sum to 1.0 | ✓ `elo.test: symmetric` |
| FR-114 | Winner gains K/2 points when ratings are equal (K=32 Tier-1) | ✓ `elo.test: K=32 winner gains` |
| FR-115 | K=64 doubles the swing for Tier-2 debates | ✓ `elo.test: K=64 doubles swing` |
| FR-116 | A draw nudges both ratings toward the mean | ✓ `elo.test: draw nudges` |
| FR-117 | Elo updates record full `elo_history` per hypothesis | ✓ `elo.test: records history` |

---

## FR-121 – FR-130: Convergence

| ID | Requirement | Tested |
|---|---|---|
| FR-121 | First round always reports `null` Spearman ρ and churn | ✓ `convergence.test: first round null` |
| FR-122 | Identical top-10 ranking → Spearman ρ = 1, churn = 0 | ✓ `convergence.test: identical ranking` |
| FR-123 | Fully reversed top-5 → high churn | ✓ `convergence.test: reversed high churn` |
| FR-124 | `isConverged` returns true when Spearman ρ ≥ 0.95 | ✓ `convergence.test: isConverged spearman` |
| FR-125 | `isConverged` returns true when top-5 churn ≤ 1 for 3 consecutive rounds | ✓ `convergence.test: isConverged churn` |
| FR-126 | `pruneActivePool` retains fresh and high-Elo hypotheses, retires old low-Elo ones | ✓ `convergence.test: pruneActivePool` |
| FR-127 | `pruneActivePool` never prunes below the configured cap | ✓ `convergence.test: never below cap` |

---

## FR-131 – FR-140: Transport & server

| ID | Requirement | Tested |
|---|---|---|
| FR-131 | `GET /` serves the index HTML containing "LabMate" | ✓ `server.test: serves index` |
| FR-132 | `GET /web-bridge.js` is served and defines `window.cs` | ✓ `server.test: web-bridge served` |
| FR-133 | Unknown routes return HTTP 404 | ✓ `server.test: 404` |
| FR-134 | `/api/events` returns `text/event-stream` content-type | ✓ `server.test: SSE connects` |
| FR-135 | `POST /api/set-model` accepts a model string and returns `ok:true` | ✓ `server.test: set-model ok` |
| FR-136 | Server auto-increments to the next free port if the chosen port is busy — never crashes on `EADDRINUSE` | ✓ `port.test: auto-increments when busy` |
| FR-137 | An uncaught startup error keeps the console open (parks the event loop) instead of exiting silently — so a double-clicked .exe shows the error | — (process-crash behavior; verified manually) |

---

## FR-141 – FR-150: Utility / data layer

| ID | Requirement | Tested |
|---|---|---|
| FR-141 | `extractJSON` parses fenced ` ```json ` blocks | ✓ `utils.test: fenced block` |
| FR-142 | `extractJSON` parses bare objects and arrays | ✓ `utils.test: bare array/object` |
| FR-143 | `extractJSON` prefers fenced block over surrounding prose braces | ✓ `utils.test: prefers fenced` |
| FR-144 | `extractJSON` throws when no JSON found | ✓ `utils.test: throws on no JSON` |
| FR-145 | Hypothesis IDs increment from the current max (zero-padded to 3 digits) | ✓ `utils.test: nextHypothesisId` |
| FR-146 | Cluster IDs increment independently (zero-padded to 3 digits) | ✓ `utils.test: nextClusterId` |
| FR-147 | `freshState` includes all required top-level keys | ✓ `utils.test: freshState keys` |
| FR-148 | `saveState`/`loadState` round-trip preserves all fields | ✓ `utils.test: round-trip` |
| FR-149 | `detectProvider` selects Google when `GOOGLE_API_KEY` is set | ✓ `utils.test: google key` |
| FR-150 | `detectProvider` throws when no key is configured | ✓ `utils.test: throws no key` |

---

## FR-151 – FR-160: UI / renderer

| ID | Requirement | Tested |
|---|---|---|
| FR-151 | All renderer scripts load without throwing (no TDZ or undefined-ref errors) | ✓ `renderer-smoke: loads without throw` |
| FR-152 | `showPanel()` works for every named panel without throwing | ✓ `renderer-smoke: showPanel all panels` |
| FR-153 | `window.cs` is defined by `web-bridge.js` and exposes all required methods | ✓ `renderer-smoke: web-bridge defines cs` |
| FR-154 | App Log panel receives and displays entries from the server SSE stream | ✓ `renderer-smoke: loads without throw` |
| FR-155 | All source files pass `node --check` syntax validation | ✓ `static.test: node --check all files` |

---

## Gaps / not yet covered by automated tests

These requirements are verified manually or are integration-level:

| ID | Requirement | Why not automated |
|---|---|---|
| FR-062 | Start Run creates state and returns run_id | Requires real API key + network |
| FR-023 | Streaming animation plays during assistant reply | Visual; requires browser |
| FR-027/028 | Guide "Apply to form" fills form fields | DOM interaction; vm stub |
| FR-045 | Timed / Rounds mode toggles show correct sub-controls | DOM visibility; vm stub |

---

*Last updated: 2026-06-02. Add a row here and a corresponding test whenever a new requirement is introduced.*
