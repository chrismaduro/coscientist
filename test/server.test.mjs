import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Prevent the module from auto-listening; we control startup here.
process.env.COSCI_NO_AUTOSTART = '1';
process.env.NO_OPEN = '1';

const { server, startServer } = await import('../server.js');

const PORT = 4399;
const base = `http://localhost:${PORT}`;

before(() => new Promise((resolve) => {
  startServer(PORT, { openBrowser: false });
  server.once('listening', resolve);
  if (server.listening) resolve();
}));

after(() => new Promise((resolve) => server.close(resolve)));

async function get(p) { return (await fetch(base + p)).json(); }
async function post(p, body) {
  return (await fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })).json();
}

// ── Static assets ─────────────────────────────────────────────────────────────

test('GET / serves the index HTML', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /LabMate/);
});

test('GET /web-bridge.js is served', async () => {
  const res = await fetch(base + '/web-bridge.js');
  assert.equal(res.status, 200);
  const js = await res.text();
  assert.match(js, /window\.cs/);
});

test('unknown route returns 404', async () => {
  const res = await fetch(base + '/api/does-not-exist');
  assert.equal(res.status, 404);
});

// ── Provider / model info ─────────────────────────────────────────────────────

test('GET /api/provider-info responds with a models array', async () => {
  const info = await get('/api/provider-info');
  assert.ok('provider' in info);
  assert.ok(Array.isArray(info.models));
});

test('GET /api/provider-info returns null provider when no key is set', async () => {
  const saved = { g: process.env.GOOGLE_API_KEY, a: process.env.ANTHROPIC_API_KEY };
  delete process.env.GOOGLE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const info = await get('/api/provider-info');
    assert.equal(info.provider, null);
    assert.ok(Array.isArray(info.models));
    assert.equal(info.models.length, 0);
  } finally {
    if (saved.g) process.env.GOOGLE_API_KEY = saved.g;
    if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a;
  }
});

test('POST /api/set-model echoes ok', async () => {
  const r = await post('/api/set-model', { model: 'gemini-2.0-flash' });
  assert.equal(r.ok, true);
});

// ── API key management ────────────────────────────────────────────────────────

test('GET /api/api-keys returns activeProvider field', async () => {
  const keys = await get('/api/api-keys');
  assert.ok('activeProvider' in keys);
});

test('POST /api/save-api-key round-trips (then restored)', async () => {
  const original = process.env.GOOGLE_API_KEY;
  try {
    const r = await post('/api/save-api-key', { provider: 'google', key: 'AIzaServerTest123456' });
    assert.equal(r.ok, true);
    const keys = await get('/api/api-keys');
    assert.equal(keys.activeProvider, 'google');
    assert.equal(keys.googleKey, '••••123456');
  } finally {
    if (original) await post('/api/save-api-key', { provider: 'google', key: original });
  }
});

test('save-api-key rejects empty key', async () => {
  const r = await post('/api/save-api-key', { provider: 'google', key: '' });
  assert.equal(r.ok, false);
  assert.ok(r.error, 'should include an error message');
});

test('save-api-key rejects missing provider', async () => {
  const r = await post('/api/save-api-key', { key: 'AIzaFoo' });
  assert.equal(r.ok, false);
});

test('save-api-key trims whitespace from key', async () => {
  const original = process.env.GOOGLE_API_KEY;
  const testKey = '  AIzaTrimTest999  ';
  const trimmed = testKey.trim(); // 'AIzaTrimTest999' — 15 chars
  const expectedMask = '••••' + trimmed.slice(-6); // last 6 chars: 'st999' → '••••st999' wait, slice(-6) of 'AIzaTrimTest999' = 'est999'
  try {
    const r = await post('/api/save-api-key', { provider: 'google', key: testKey });
    assert.equal(r.ok, true);
    const keys = await get('/api/api-keys');
    assert.equal(keys.googleKey, '••••' + trimmed.slice(-6));
  } finally {
    if (original) await post('/api/save-api-key', { provider: 'google', key: original });
    else { delete process.env.GOOGLE_API_KEY; delete process.env.ANTHROPIC_API_KEY; }
  }
});

// ── Connection test ───────────────────────────────────────────────────────────

test('POST /api/test-api returns { ok } shape', async () => {
  const r = await post('/api/test-api');
  assert.equal(typeof r.ok, 'boolean', 'ok must be boolean');
});

test('POST /api/test-api returns ok:false with no API key', async () => {
  const saved = { g: process.env.GOOGLE_API_KEY, a: process.env.ANTHROPIC_API_KEY };
  delete process.env.GOOGLE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await post('/api/test-api');
    assert.equal(r.ok, false);
    assert.ok(r.error, 'should include error message when no key set');
  } finally {
    if (saved.g) process.env.GOOGLE_API_KEY = saved.g;
    if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a;
  }
});

// ── SSE stream ────────────────────────────────────────────────────────────────

test('SSE /api/events connects and streams', async () => {
  const res = await fetch(base + '/api/events');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  res.body?.cancel?.();
});

// ── State endpoints ───────────────────────────────────────────────────────────

test('GET /api/state returns null or a state object', async () => {
  const r = await get('/api/state');
  assert.ok(r === null || typeof r === 'object');
  if (r !== null) assert.ok('run_id' in r);
});

test('POST /api/reset-state returns ok:true', async () => {
  const r = await post('/api/reset-state');
  assert.equal(r.ok, true);
});

test('GET /api/state is null after reset', async () => {
  await post('/api/reset-state');
  const r = await get('/api/state');
  assert.equal(r, null);
});

// ── Run lifecycle ─────────────────────────────────────────────────────────────

test('POST /api/start-run returns ok:false with no API key', async () => {
  const saved = { g: process.env.GOOGLE_API_KEY, a: process.env.ANTHROPIC_API_KEY };
  delete process.env.GOOGLE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await post('/api/start-run', { research_goal: 'test goal' });
    assert.equal(r.ok, false);
    assert.ok(r.error, 'should surface error message');
  } finally {
    if (saved.g) process.env.GOOGLE_API_KEY = saved.g;
    if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a;
  }
});

test('POST /api/resume-run returns ok:false when no state file exists', async () => {
  await post('/api/reset-state');
  const r = await post('/api/resume-run', {});
  assert.equal(r.ok, false);
  assert.ok(r.error, 'should explain why resume failed');
});

test('POST /api/stop-run returns ok:false when no run is active', async () => {
  const r = await post('/api/stop-run');
  assert.equal(r.ok, false);
  assert.match(r.error, /No run in progress/);
});

test('POST /api/export-report returns ok:false when no state file', async () => {
  await post('/api/reset-state');
  const r = await post('/api/export-report');
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

// ── Guide chat ────────────────────────────────────────────────────────────────

test('POST /api/guide-reset returns ok:true', async () => {
  const r = await post('/api/guide-reset');
  assert.equal(r.ok, true);
});

test('POST /api/guide-chat returns ok:false with no API key', async () => {
  const saved = { g: process.env.GOOGLE_API_KEY, a: process.env.ANTHROPIC_API_KEY };
  delete process.env.GOOGLE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await post('/api/guide-chat', { message: 'hello' });
    assert.equal(r.ok, false);
    assert.ok(r.error, 'should include error message');
  } finally {
    if (saved.g) process.env.GOOGLE_API_KEY = saved.g;
    if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a;
  }
});

test('POST /api/guide-chat with missing message does not crash server', async () => {
  const saved = { g: process.env.GOOGLE_API_KEY, a: process.env.ANTHROPIC_API_KEY };
  delete process.env.GOOGLE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await post('/api/guide-chat', {});
    assert.equal(typeof r.ok, 'boolean', 'must return { ok } not crash');
  } finally {
    if (saved.g) process.env.GOOGLE_API_KEY = saved.g;
    if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a;
  }
});

// ── Intake save / load ────────────────────────────────────────────────────────

test('POST /api/save-intake and /api/load-intake round-trip', async () => {
  const payload = { research_goal: 'Test goal round-trip', domain_context: { field: 'CS' } };
  const saved = await post('/api/save-intake', payload);
  assert.equal(saved.ok, true);

  const loaded = await post('/api/load-intake');
  assert.equal(loaded.ok, true);
  assert.equal(loaded.data.research_goal, 'Test goal round-trip');
  assert.equal(loaded.data.domain_context.field, 'CS');
});

test('POST /api/load-intake error shape is correct when file absent', async () => {
  // Cannot delete the file from here, so just verify the shape contract:
  // if ok:false there must be an error string, if ok:true there must be data.
  const r = await post('/api/load-intake');
  assert.equal(typeof r.ok, 'boolean');
  if (r.ok) assert.ok(r.data, 'ok:true must include data');
  else assert.ok(r.error, 'ok:false must include error message');
});

// ── Example intake ────────────────────────────────────────────────────────────

test('GET /api/load-example returns correct shape', async () => {
  const r = await get('/api/load-example');
  assert.equal(typeof r.ok, 'boolean');
  if (r.ok) assert.equal(typeof r.data, 'object');
  else assert.ok(r.error, 'failure must include error message');
});

// ── Friendly error contract (FR-015 – FR-018) ─────────────────────────────────
// When an API call fails, the returned error must be brief plain text —
// never raw JSON, never a multi-line stack trace.

test('FR-015: guide-chat error is brief plain text (no raw JSON curly braces)', async () => {
  const saved = { g: process.env.GOOGLE_API_KEY, a: process.env.ANTHROPIC_API_KEY };
  delete process.env.GOOGLE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await post('/api/guide-chat', { message: 'hello' });
    assert.equal(r.ok, false);
    // Friendly message must not contain raw JSON-like content
    assert.ok(!r.error.includes('{'), 'error must not contain raw JSON braces');
    assert.ok(!r.error.includes('\n'), 'error must not be multi-line');
    assert.ok(r.error.length < 200, 'error must be brief (< 200 chars)');
  } finally {
    if (saved.g) process.env.GOOGLE_API_KEY = saved.g;
    if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a;
  }
});

test('FR-015: test-api error is brief plain text (no raw JSON)', async () => {
  const saved = { g: process.env.GOOGLE_API_KEY, a: process.env.ANTHROPIC_API_KEY };
  delete process.env.GOOGLE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await post('/api/test-api');
    assert.equal(r.ok, false);
    assert.ok(!r.error.includes('{'), 'error must not contain raw JSON braces');
    assert.ok(!r.error.includes('\n'), 'error must not be multi-line');
    assert.ok(r.error.length < 200, 'error must be brief (< 200 chars)');
  } finally {
    if (saved.g) process.env.GOOGLE_API_KEY = saved.g;
    if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a;
  }
});

test('FR-015: start-run error is brief plain text (no raw JSON)', async () => {
  const saved = { g: process.env.GOOGLE_API_KEY, a: process.env.ANTHROPIC_API_KEY };
  delete process.env.GOOGLE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await post('/api/start-run', { research_goal: 'test' });
    assert.equal(r.ok, false);
    assert.ok(!r.error.includes('{'), 'error must not contain raw JSON braces');
    assert.ok(!r.error.includes('\n'), 'error must not be multi-line');
    assert.ok(r.error.length < 200, 'error must be brief (< 200 chars)');
  } finally {
    if (saved.g) process.env.GOOGLE_API_KEY = saved.g;
    if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a;
  }
});
