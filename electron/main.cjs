// CommonJS Electron main process. This is the standard, most-compatible setup.
// The agent/util code lives at the project root as ESM (package.json
// "type":"module"), so we load it via dynamic import() from this CJS file.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { existsSync } = require('fs');
const { rm, readFile, writeFile } = require('fs/promises');
const { pathToFileURL } = require('url');

// ── Quiet Chromium's GPU/disk-cache noise & isolate the cache dir ──────────
app.setName('LabMate');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'LabMate'));
} catch { /* ignore */ }

// ── .env (authoritative over stale shell vars) ─────────────────────────────
const ENV_PATH = path.join(__dirname, '..', '.env');
try { require('dotenv').config({ path: ENV_PATH, override: true }); } catch {}

// ── ESM backend, loaded dynamically ────────────────────────────────────────
let U = null;        // utils.js exports
let runLoop = null;  // supervisor.runLoop
let backendError = null;

async function loadBackend() {
  try {
    U = await import(pathToFileURL(path.join(__dirname, '..', 'utils.js')).href);
    const sup = await import(pathToFileURL(path.join(__dirname, '..', 'agents', 'supervisor.js')).href);
    runLoop = sup.runLoop;
  } catch (err) {
    backendError = err;
    _origError(`[startup] Backend failed to load: ${err.stack || err.message}`);
  }
}

let mainWindow = null;
let runAbortController = null;
let guideHistory = [];
let currentModel = null;

// ── Logging (buffer until window ready, intercept console) ─────────────────
const _logBuffer = [];
function appLog(level, message, agent = 'app') {
  const entry = { level, message, agent, ts: new Date().toISOString() };
  _logBuffer.push(entry);
  if (mainWindow && !mainWindow.isDestroyed()) {
    while (_logBuffer.length) mainWindow.webContents.send('app-log', _logBuffer.shift());
  }
}

const _origLog   = console.log.bind(console);
const _origWarn  = console.warn.bind(console);
const _origError = console.error.bind(console);
function parseAgent(msg) { const m = msg.match(/^\[([^\]]+)\]/); return m ? m[1] : 'app'; }
console.log   = (...a) => { const m = a.map(String).join(' '); _origLog(m);   appLog('debug', m, parseAgent(m)); };
console.warn  = (...a) => { const m = a.map(String).join(' '); _origWarn(m);  appLog('warn',  m, parseAgent(m)); };
console.error = (...a) => { const m = a.map(String).join(' '); _origError(m); appLog('error', m, parseAgent(m)); };

// ── Window ─────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0d0d0d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });

  mainWindow.maximize();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.once('did-finish-load', () => {
    while (_logBuffer.length) mainWindow.webContents.send('app-log', _logBuffer.shift());
    if (backendError) {
      appLog('error', `Backend failed to load: ${backendError.message}`);
    }
    const provider = process.env.GOOGLE_API_KEY ? 'Google AI'
                   : process.env.ANTHROPIC_API_KEY ? 'Anthropic' : null;
    appLog('info', 'LabMate started');
    appLog('info', `Provider: ${provider || 'none — add an API key in Settings'}`);
    if (!provider) appLog('warn', 'No API key found. Open Settings to add one.');
  });
}

app.whenReady().then(async () => {
  await loadBackend();
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── Helpers ────────────────────────────────────────────────────────────────
function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

const PROVIDER_MODELS = {
  google: [
    { id: 'gemini-2.5-pro-preview-06-05',   label: 'Gemini 2.5 Pro Preview — best quality' },
    { id: 'gemini-2.5-flash-preview-05-20', label: 'Gemini 2.5 Flash Preview — fast + smart' },
    { id: 'gemini-2.0-flash',               label: 'Gemini 2.0 Flash — free tier default' },
    { id: 'gemini-2.0-flash-lite',          label: 'Gemini 2.0 Flash Lite — fastest' },
    { id: 'gemini-1.5-pro',                 label: 'Gemini 1.5 Pro — stable' },
  ],
  anthropic: [
    { id: 'claude-opus-4-5',   label: 'Claude Opus 4.5 — best quality' },
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 — balanced' },
    { id: 'claude-haiku-3-5',  label: 'Claude Haiku 3.5 — fastest' },
  ],
};

function buildClient() {
  if (!U) throw new Error('Backend not loaded yet');
  return U.createClient();
}

function makeRunId() {
  const n = new Date();
  return `run-${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, '0')}${String(n.getDate()).padStart(2, '0')}-${String(n.getHours()).padStart(2, '0')}${String(n.getMinutes()).padStart(2, '0')}`;
}

function buildStateSummary(state) { return state; }

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
      onChunk: (agent, chunk) => send('agent-chunk', { agent, chunk }),
      onAgentDone: (agent, summary) => {
        send('agent-done', { agent, summary });
        send('state-update', buildStateSummary(state));
        appLog('info', summary, agent);
      },
      onRoundComplete: (s) => {
        state = s;
        send('state-update', buildStateSummary(state));
        appLog('info', `Round ${s.round} complete — ${s.hypotheses.filter(h => h.status === 'active').length} active hypotheses`);
      },
      stopAt: stopAt || null,
      shouldStop: () => ctrl.stopped,
    });
    state.phase = 'complete';
    await U.saveState(state);
    await U.saveFinalCorpus(state);
    await U.saveFinalReport(state);
    appLog('info', `Run complete — output saved to output/${state.run_id}/`);
    send('run-complete', buildStateSummary(state));
  } catch (err) {
    appLog('error', `Run failed: ${err.message}`);
    send('run-error', { message: err.message, stack: err.stack });
  } finally {
    runAbortController = null;
  }
}

// ── IPC handlers ───────────────────────────────────────────────────────────
ipcMain.handle('start-run', async (_, config) => {
  try {
    if (!U) return { ok: false, error: 'Backend not loaded' };
    const anthropic = buildClient();
    const runId = makeRunId();
    let state = U.freshState(runId);
    if (config.research_goal) state.research_goal = config.research_goal;
    if (config.domain_context) Object.assign(state.domain_context, config.domain_context);
    if (config.config) Object.assign(state.config, config.config);
    await U.saveState(state);
    U.logEvent(state, 'supervisor', `Run started via UI: ${runId}`);
    const stopAt = config.runMode === 'timed' && config.durationMs ? Date.now() + config.durationMs : null;
    appLog('info', `Starting new run ${runId}`);
    executeRun(state, anthropic, stopAt, config.model || null);
    return { ok: true, run_id: runId };
  } catch (err) {
    appLog('error', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('resume-run', async (_, opts) => {
  try {
    if (!U) return { ok: false, error: 'Backend not loaded' };
    if (!existsSync(U.STATE_PATH)) return { ok: false, error: 'No state file found' };
    const anthropic = buildClient();
    let state = await U.loadState();
    const stopAt = opts?.runMode === 'timed' && opts?.durationMs ? Date.now() + opts.durationMs : null;
    executeRun(state, anthropic, stopAt, opts?.model || null);
    return { ok: true, run_id: state.run_id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('stop-run', async () => {
  if (runAbortController) { runAbortController.stopped = true; return { ok: true }; }
  return { ok: false, error: 'No run in progress' };
});

ipcMain.handle('get-state', async () => {
  if (!U || !existsSync(U.STATE_PATH)) return null;
  try { return await U.loadState(); } catch { return null; }
});

ipcMain.handle('export-report', async () => {
  try {
    const state = await U.loadState();
    await U.saveFinalCorpus(state);
    await U.saveFinalReport(state);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('reset-state', async () => {
  try {
    if (U && existsSync(U.STATE_PATH)) await rm(U.STATE_PATH);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

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
    "literature_hierarchy": {
      "primary": "...",
      "secondary": "...",
      "tertiary": "...",
      "treat_with_caution": "..."
    }
  }
}
\`\`\`

Before outputting the JSON, write 2–3 sentences summarising what you've synthesised and why the goal is well-formed. Only output the JSON once you're confident — don't rush it. If you need more information, keep asking.`;

ipcMain.handle('guide-chat', async (_, userMessage) => {
  try {
    if (!U) return { ok: false, error: 'Backend not loaded' };
    const { provider, client } = buildClient();
    guideHistory.push({ role: 'user', content: userMessage });
    let fullText = '';

    if (provider === 'google') {
      const history = guideHistory.slice(0, -1).map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
      const response = await client.models.generateContentStream({
        model: currentModel || 'gemini-2.0-flash',
        contents: [...history, { role: 'user', parts: [{ text: userMessage }] }],
        config: { systemInstruction: GUIDE_SYSTEM_PROMPT, maxOutputTokens: 2048, temperature: 1.0 },
      });
      for await (const chunk of response) {
        const text = chunk.text ?? '';
        if (text) { fullText += text; send('guide-chunk', text); }
      }
    } else {
      const stream = client.messages.stream({
        model: currentModel || 'claude-opus-4-5',
        max_tokens: 2048,
        system: GUIDE_SYSTEM_PROMPT,
        messages: guideHistory,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
          fullText += chunk.delta.text;
          send('guide-chunk', chunk.delta.text);
        }
      }
    }

    guideHistory.push({ role: 'assistant', content: fullText });
    const intakeMatch = fullText.match(/```intake\s*([\s\S]*?)\s*```/);
    if (intakeMatch) {
      try { send('guide-intake-ready', JSON.parse(intakeMatch[1])); } catch {}
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('guide-reset', async () => { guideHistory = []; return { ok: true }; });

ipcMain.handle('get-provider-info', () => {
  try {
    const provider = process.env.GOOGLE_API_KEY ? 'google'
                   : process.env.ANTHROPIC_API_KEY ? 'anthropic' : null;
    if (!provider) return { provider: null, models: [], error: 'No API key found' };
    return { provider, models: PROVIDER_MODELS[provider] ?? [], currentModel };
  } catch (err) {
    return { provider: null, models: [], error: err.message };
  }
});

ipcMain.handle('get-api-keys', () => ({
  googleKey:    process.env.GOOGLE_API_KEY    ? '••••' + process.env.GOOGLE_API_KEY.slice(-6)    : '',
  anthropicKey: process.env.ANTHROPIC_API_KEY ? '••••' + process.env.ANTHROPIC_API_KEY.slice(-6) : '',
  activeProvider: process.env.GOOGLE_API_KEY ? 'google' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : null,
}));

ipcMain.handle('save-api-key', async (_, { provider, key }) => {
  try {
    if (!provider || !key || !key.trim()) return { ok: false, error: 'No key provided' };
    key = key.trim();
    const envKey   = provider === 'google' ? 'GOOGLE_API_KEY' : 'ANTHROPIC_API_KEY';
    const otherKey = provider === 'google' ? 'ANTHROPIC_API_KEY' : 'GOOGLE_API_KEY';
    const newContent = [
      `# LabMate API keys — active provider: ${provider}`,
      `${envKey}=${key}`,
      `# ${otherKey}=`,
      '',
    ].join('\n');
    await writeFile(ENV_PATH, newContent, 'utf-8');
    process.env[envKey] = key;
    delete process.env[otherKey];
    appLog('info', `API key saved and activated for ${provider} (${'••••' + key.slice(-6)})`);
    return { ok: true, provider };
  } catch (err) {
    appLog('error', `Failed to save API key: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('set-model', (_, model) => {
  currentModel = model || null;
  appLog('info', `Model set to: ${currentModel || 'default'}`);
  return { ok: true };
});

ipcMain.handle('load-example', async () => {
  try {
    const raw = await readFile(path.join(__dirname, '..', 'intake.example.json'), 'utf-8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('save-intake', async (_, intakeData) => {
  try {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Intake',
      defaultPath: path.join(__dirname, '..', 'intake.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!filePath) return { ok: false, cancelled: true };
    await writeFile(filePath, JSON.stringify(intakeData, null, 2), 'utf-8');
    return { ok: true, filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('load-intake', async () => {
  try {
    const { filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Load Intake',
      defaultPath: path.join(__dirname, '..'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (!filePaths || filePaths.length === 0) return { ok: false, cancelled: true };
    const raw = await readFile(filePaths[0], 'utf-8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) { return { ok: false, error: err.message }; }
});
