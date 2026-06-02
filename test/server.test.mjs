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

test('GET /api/provider-info responds with a models array', async () => {
  const info = await get('/api/provider-info');
  assert.ok('provider' in info);
  assert.ok(Array.isArray(info.models));
});

test('GET /api/api-keys returns activeProvider field', async () => {
  const keys = await get('/api/api-keys');
  assert.ok('activeProvider' in keys);
});

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

test('POST /api/set-model echoes ok', async () => {
  const r = await post('/api/set-model', { model: 'gemini-2.0-flash' });
  assert.equal(r.ok, true);
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
});

test('unknown route returns 404', async () => {
  const res = await fetch(base + '/api/does-not-exist');
  assert.equal(res.status, 404);
});

test('SSE /api/events connects and streams', async () => {
  const res = await fetch(base + '/api/events');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  res.body?.cancel?.(); // close the stream
});
