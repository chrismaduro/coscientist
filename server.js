// LabMate local server — serves the UI and exposes the backend over plain
// HTTP + Server-Sent Events. No Electron, no preload, no IPC. This is the
// reliable, fully-testable transport: the same renderer talks to it via fetch.
import http from 'http';
import { readFile, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { config as dotenvConfig } from 'dotenv';

import {
  createClient, saveState, loadState, freshState, STATE_PATH,
  saveFinalCorpus, saveFinalReport, logEvent,
} from './utils.js';
import { runLoop } from './agents/supervisor.js';

// In a bundled single-file build import.meta.url is empty, so guard it.
let __dirname;
try { __dirname = path.dirname(fileURLToPath(import.meta.url)); } catch { __dirname = process.cwd(); }
// Base dir: exe folder when packaged (COSCI_BASE set by the SEA launcher), else project root.
const BASE = process.env.COSCI_BASE || __dirname;
const RENDERER_DIR = path.join(BASE, 'electron', 'renderer');
const ENV_PATH = path.join(BASE, '.env');
const PORT = process.env.PORT || 4173;

// Load .env (authoritative over stale shell vars)
try { dotenvConfig({ path: ENV_PATH, override: true }); } catch {}

// ── State ──────────────────────────────────────────────────────────────────
let runAbortController = null;
let guideHistory = [];
let currentModel = null;

const PROVIDER_MODELS = {
  google: [
    { id: 'gemini-2.0-flash',               label: 'Gemini 2.0 Flash — free tier default' },
    { id: 'gemini-2.0-flash-lite',          label: 'Gemini 2.0 Flash Lite — fastest' },
    { id: 'gemini-2.5-flash-preview-05-20', label: 'Gemini 2.5 Flash Preview — fast + smart' },
    { id: 'gemini-2.5-pro-preview-06-05',   label: 'Gemini 2.5 Pro Preview — best quality' },
    { id: 'gemini-1.5-pro',                 label: 'Gemini 1.5 Pro — stable' },
  ],
  anthropic: [
    { id: 'claude-opus-4-5',   label: 'Claude Opus 4.5 — best quality' },
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 — balanced' },
    { id: 'claude-haiku-3-5',  label: 'Claude Haiku 3.5 — fastest' },
  ],
};

// ── SSE broadcast ────────────────────────────────────────────────────────────
let sseClients = [];
function broadcast(type, data) {
  const payload = `data: ${JSON.stringify({ type, data })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

// ── Error helpers ─────────────────────────────────────────────────────────────
/**
 * Convert a raw API error (which may contain multi-line JSON) into a short
 * human-readable message for the UI, while logging the full detail to appLog.
 * Returns { friendly: string, detail: string }.
 */
function friendlyApiError(err, context = 'API') {
  const raw = err?.message || String(err);
  let friendly;

  if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('429') || raw.includes('quota')) {
    friendly = 'Quota exceeded — free-tier limit reached. Wait a moment and try again.';
  } else if (raw.includes('UNAUTHENTICATED') || raw.includes('API_KEY_INVALID') || raw.includes('invalid_api_key')) {
    friendly = 'Invalid API key — go to Settings and re-enter your key.';
  } else if (raw.includes('No API key') || raw.includes('GOOGLE_API_KEY') || raw.includes('ANTHROPIC_API_KEY')) {
    friendly = 'No API key configured — go to Settings → API Key and save your key.';
  } else if (raw.includes('PERMISSION_DENIED') || raw.includes('403')) {
    friendly = 'Permission denied — your key may not have access to this model.';
  } else if (raw.includes('UNAVAILABLE') || raw.includes('503') || raw.includes('overloaded')) {
    friendly = 'The AI service is temporarily unavailable. Please try again shortly.';
  } else if (raw.includes('network') || raw.includes('ECONNREFUSED') || raw.includes('fetch')) {
    friendly = 'Network error — check your internet connection and try again.';
  } else {
    // Generic: first sentence only, capped at 120 chars
    const first = raw.split(/[\n{]/)[0].trim();
    friendly = first.length > 120 ? first.slice(0, 117) + '…' : first || 'An unexpected error occurred.';
  }

  appLog('error', `[${context}] ${friendly}\nDetail: ${raw}`, context.toLowerCase());
  return { friendly, detail: raw };
}

// Buffer log entries so they survive until a client connects
const _logBuffer = [];
function appLog(level, message, agent = 'app') {
  const entry = { level, message, agent, ts: new Date().toISOString() };
  if (sseClients.length === 0) _logBuffer.push(entry);
  else broadcast('app-log', entry);
}

// Intercept console output into the app log
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);
const parseAgent = (m) => { const x = m.match(/^\[([^\]]+)\]/); return x ? x[1] : 'app'; };
console.log   = (...a) => { const m = a.map(String).join(' '); _origLog(m);   appLog('debug', m, parseAgent(m)); };
console.warn  = (...a) => { const m = a.map(String).join(' '); _origWarn(m);  appLog('warn',  m, parseAgent(m)); };
console.error = (...a) => { const m = a.map(String).join(' '); _origError(m); appLog('error', m, parseAgent(m)); };

// ── Run execution ────────────────────────────────────────────────────────────
async function executeRun(state, anthropic, stopAt, model = null) {
  runAbortController = { stopped: false };
  const ctrl = runAbortController;
  try {
    Object.defineProperty(anthropic, 'model', {
      get: () => currentModel || model || null,
      set: (v) => { currentModel = v; },
      configurable: true,
    });
    appLog('info', `Run ${state.run_id} started (model: ${currentModel || model || 'default'})`);
    state = await runLoop(state, anthropic, {
      onChunk: (agent, chunk) => broadcast('agent-chunk', { agent, chunk }),
      onAgentDone: (agent, summary) => {
        broadcast('agent-done', { agent, summary });
        broadcast('state-update', state);
        appLog('info', summary, agent);
      },
      onRoundComplete: (s) => {
        state = s;
        broadcast('state-update', state);
        appLog('info', `Round ${s.round} complete — ${s.hypotheses.filter(h => h.status === 'active').length} active hypotheses`);
      },
      stopAt: stopAt || null,
      shouldStop: () => ctrl.stopped,
    });
    state.phase = 'complete';
    await saveState(state);
    await saveFinalCorpus(state);
    await saveFinalReport(state);
    appLog('info', `Run complete — output saved to output/${state.run_id}/`);
    broadcast('run-complete', state);
  } catch (err) {
    appLog('error', `Run failed: ${err.message}`);
    broadcast('run-error', { message: err.message, stack: err.stack });
  } finally {
    runAbortController = null;
  }
}

function makeRunId() {
  const n = new Date();
  return `run-${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, '0')}${String(n.getDate()).padStart(2, '0')}-${String(n.getHours()).padStart(2, '0')}${String(n.getMinutes()).padStart(2, '0')}`;
}

const GUIDE_SYSTEM_PROMPT = `You are a research design advisor helping a scientist articulate a clear, focused research goal and fill in a structured intake form for an AI hypothesis generation system.

Your job is to interview them conversationally — ask one or two questions at a time, build up a picture of their domain, target population, constraints, and what they already know. Be specific, encouraging, and Socratic. Push back gently when goals are vague. Help them distinguish hard constraints (genuine blockers) from soft preferences.

After 4–8 exchanges, when you have enough to work with, synthesise everything into a complete intake JSON. Output it in this exact format at the end of your message:

\`\`\`intake
{
  "research_goal": "...",
  "domain_context": {
    "research_anchor": "...",
    "target_population": "...",
    "context_setting": "...",
    "hard_constraints": ["...", "..."],
    "soft_factors": ["...", "..."],
    "frontier_seed_list": {
      "core_fronts": ["...", "..."],
      "cross_disciplinary_targets": ["...", "..."],
      "frontier_phenomena": ["...", "..."]
    },
    "literature_hierarchy": { "primary": "...", "secondary": "...", "tertiary": "...", "treat_with_caution": "..." }
  }
}
\`\`\`

Before outputting the JSON, write 2–3 sentences summarising what you've synthesised. Only output the JSON once you're confident.`;

// ── API handlers ─────────────────────────────────────────────────────────────
const api = {
  'GET /api/state': async () => {
    if (!existsSync(STATE_PATH)) return null;
    try { return await loadState(); } catch { return null; }
  },

  'GET /api/provider-info': async () => {
    const provider = process.env.GOOGLE_API_KEY ? 'google'
                   : process.env.ANTHROPIC_API_KEY ? 'anthropic' : null;
    if (!provider) return { provider: null, models: [], error: 'No API key found' };
    return { provider, models: PROVIDER_MODELS[provider] ?? [], currentModel };
  },

  'GET /api/api-keys': async () => ({
    googleKey:    process.env.GOOGLE_API_KEY    ? '••••' + process.env.GOOGLE_API_KEY.slice(-6)    : '',
    anthropicKey: process.env.ANTHROPIC_API_KEY ? '••••' + process.env.ANTHROPIC_API_KEY.slice(-6) : '',
    activeProvider: process.env.GOOGLE_API_KEY ? 'google' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : null,
  }),

  'GET /api/load-example': async () => {
    try {
      const raw = await readFile(path.join(BASE, 'intake.example.json'), 'utf-8');
      return { ok: true, data: JSON.parse(raw) };
    } catch (err) { return { ok: false, error: err.message }; }
  },

  'POST /api/save-api-key': async (body) => {
    try {
      let { provider, key } = body;
      if (!provider || !key || !key.trim()) return { ok: false, error: 'No key provided' };
      key = key.trim();
      const envKey   = provider === 'google' ? 'GOOGLE_API_KEY' : 'ANTHROPIC_API_KEY';
      const otherKey = provider === 'google' ? 'ANTHROPIC_API_KEY' : 'GOOGLE_API_KEY';
      const content = [
        `# LabMate API keys — active provider: ${provider}`,
        `${envKey}=${key}`,
        `# ${otherKey}=`, '',
      ].join('\n');
      await writeFile(ENV_PATH, content, 'utf-8');
      process.env[envKey] = key;
      delete process.env[otherKey];
      appLog('info', `API key saved and activated for ${provider} (${'••••' + key.slice(-6)})`);
      return { ok: true, provider };
    } catch (err) {
      appLog('error', `Failed to save API key: ${err.message}`);
      return { ok: false, error: err.message };
    }
  },

  'POST /api/set-model': async (body) => {
    currentModel = body?.model || null;
    appLog('info', `Model set to: ${currentModel || 'default'}`);
    return { ok: true };
  },

  'POST /api/start-run': async (config) => {
    try {
      const anthropic = createClient();
      const runId = makeRunId();
      let state = freshState(runId);
      if (config.research_goal) state.research_goal = config.research_goal;
      if (config.domain_context) Object.assign(state.domain_context, config.domain_context);
      if (config.config) Object.assign(state.config, config.config);
      await saveState(state);
      logEvent(state, 'supervisor', `Run started via UI: ${runId}`);
      const stopAt = config.runMode === 'timed' && config.durationMs ? Date.now() + config.durationMs : null;
      appLog('info', `Starting new run ${runId}`);
      executeRun(state, anthropic, stopAt, config.model || null);
      return { ok: true, run_id: runId };
    } catch (err) {
      const { friendly } = friendlyApiError(err, 'Start run');
      return { ok: false, error: friendly };
    }
  },

  'POST /api/resume-run': async (opts) => {
    try {
      if (!existsSync(STATE_PATH)) return { ok: false, error: 'No state file found' };
      const anthropic = createClient();
      let state = await loadState();
      const stopAt = opts?.runMode === 'timed' && opts?.durationMs ? Date.now() + opts.durationMs : null;
      executeRun(state, anthropic, stopAt, opts?.model || null);
      return { ok: true, run_id: state.run_id };
    } catch (err) {
      const { friendly } = friendlyApiError(err, 'Resume run');
      return { ok: false, error: friendly };
    }
  },

  'POST /api/stop-run': async () => {
    if (runAbortController) { runAbortController.stopped = true; return { ok: true }; }
    return { ok: false, error: 'No run in progress' };
  },

  'POST /api/export-report': async () => {
    try {
      const state = await loadState();
      await saveFinalCorpus(state);
      await saveFinalReport(state);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  },

  'POST /api/reset-state': async () => {
    try { if (existsSync(STATE_PATH)) await rm(STATE_PATH); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  },

  'POST /api/guide-chat': async (body) => {
    try {
      const { provider, client } = createClient();
      guideHistory.push({ role: 'user', content: body.message });
      let fullText = '';
      if (provider === 'google') {
        const history = guideHistory.slice(0, -1).map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }],
        }));
        const response = await client.models.generateContentStream({
          model: currentModel || 'gemini-2.0-flash',
          contents: [...history, { role: 'user', parts: [{ text: body.message }] }],
          config: { systemInstruction: GUIDE_SYSTEM_PROMPT, maxOutputTokens: 2048, temperature: 1.0 },
        });
        for await (const chunk of response) {
          const t = chunk.text ?? '';
          if (t) { fullText += t; broadcast('guide-chunk', t); }
        }
      } else {
        const stream = client.messages.stream({
          model: currentModel || 'claude-opus-4-5', max_tokens: 2048,
          system: GUIDE_SYSTEM_PROMPT, messages: guideHistory,
        });
        for await (const chunk of stream) {
          if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
            fullText += chunk.delta.text; broadcast('guide-chunk', chunk.delta.text);
          }
        }
      }
      guideHistory.push({ role: 'assistant', content: fullText });
      const m = fullText.match(/```intake\s*([\s\S]*?)\s*```/);
      if (m) { try { broadcast('guide-intake-ready', JSON.parse(m[1])); } catch {} }
      return { ok: true };
    } catch (err) {
      const { friendly } = friendlyApiError(err, 'Guide');
      return { ok: false, error: friendly };
    }
  },

  'POST /api/guide-reset': async () => { guideHistory = []; return { ok: true }; },

  'POST /api/test-api': async () => {
    try {
      const { provider, client } = createClient();
      let reply = '';
      if (provider === 'google') {
        const res = await client.models.generateContent({
          model: 'gemini-2.0-flash',
          contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
          config: { maxOutputTokens: 10 },
        });
        reply = res.text ?? '';
      } else {
        const res = await client.messages.create({
          model: 'claude-haiku-4-5', max_tokens: 10,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        });
        reply = res.content?.[0]?.text ?? '';
      }
      return { ok: true, provider, reply: reply.trim() };
    } catch (err) {
      const { friendly } = friendlyApiError(err, 'Connection test');
      return { ok: false, error: friendly };
    }
  },

  'POST /api/save-intake': async (body) => {
    try {
      const p = path.join(BASE, 'intake.saved.json');
      await writeFile(p, JSON.stringify(body, null, 2), 'utf-8');
      return { ok: true, filePath: p };
    } catch (err) { return { ok: false, error: err.message }; }
  },

  'POST /api/load-intake': async () => {
    try {
      const p = path.join(BASE, 'intake.saved.json');
      if (!existsSync(p)) return { ok: false, error: 'No saved intake found (intake.saved.json)' };
      const raw = await readFile(p, 'utf-8');
      return { ok: true, data: JSON.parse(raw) };
    } catch (err) { return { ok: false, error: err.message }; }
  },
};

// ── Static file serving ──────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};
async function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(RENDERER_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(RENDERER_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

// ── Server ───────────────────────────────────────────────────────────────────
export const server = http.createServer(async (req, res) => {
  // SSE event stream
  if (req.url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.push(res);
    // Flush buffered logs
    while (_logBuffer.length) {
      res.write(`data: ${JSON.stringify({ type: 'app-log', data: _logBuffer.shift() })}\n\n`);
    }
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
    return;
  }

  const routeKey = `${req.method} ${req.url.split('?')[0]}`;
  const handler = api[routeKey];
  if (handler) {
    const body = req.method === 'POST' ? await readBody(req) : null;
    try {
      const result = await handler(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(404); res.end('Not found');
});

export function startServer(port = PORT, { openBrowser = !process.env.NO_OPEN, maxAttempts = 20 } = {}) {
  const startPort = Number(port);
  let attempt = 0;

  // If the chosen port is busy, step to the next one instead of crashing.
  // This is what was killing the double-clicked .exe: with the dev server
  // already on 4173, an unhandled EADDRINUSE exited the process instantly.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
      const busy = startPort + attempt;
      attempt++;
      _origLog(`  Port ${busy} is in use, trying ${startPort + attempt}…`);
      setTimeout(() => server.listen(startPort + attempt), 80);
    } else {
      _origError(`\n  ✗ LabMate could not start: ${err.message}`);
      _origError('  Close any other copy of LabMate, then run it again.');
      _origError('  (This window stays open so you can read the message.)\n');
      // Park the event loop so a double-clicked window doesn't vanish.
      setInterval(() => {}, 1 << 30);
    }
  });

  server.on('listening', () => {
    const addr = server.address();
    const actualPort = addr && typeof addr === 'object' ? addr.port : startPort;
    const url = `http://localhost:${actualPort}`;
    _origLog(`\n  LabMate running at ${url}\n`);
    appLog('info', `LabMate server started on port ${actualPort}`);
    const provider = process.env.GOOGLE_API_KEY ? 'Google AI' : process.env.ANTHROPIC_API_KEY ? 'Anthropic' : null;
    appLog('info', `Provider: ${provider || 'none — add an API key in Settings'}`);
    if (!provider) appLog('warn', 'No API key found. Open Settings to add one.');

    if (openBrowser) {
      const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch {}
    }
  });

  server.listen(startPort);
  return server;
}

// Auto-start unless a test harness wants to control startup itself.
if (!process.env.COSCI_NO_AUTOSTART) {
  // A double-clicked .exe has no console to inspect after it exits, so make any
  // unexpected crash readable instead of flashing the window shut.
  process.on('uncaughtException', (err) => {
    _origError(`\n  ✗ LabMate hit an unexpected error: ${err.message}`);
    _origError('  Please report this. This window stays open so you can read it.\n');
    _origError(String(err.stack || err));
    setInterval(() => {}, 1 << 30);
  });
  process.on('unhandledRejection', (reason) => {
    _origError(`\n  ✗ LabMate background error: ${reason}`);
  });
  startServer();
}
