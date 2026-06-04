import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function occupy(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, () => resolve(s));
  });
}

async function waitForServer(port, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/api-keys`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// FR-136: when the chosen port is busy, the server must step to the next free
// port instead of crashing on EADDRINUSE. This is the bug that killed the
// double-clicked .exe when a dev server already held the default port.
test('server auto-increments to the next port when the chosen one is busy', async () => {
  const busyPort = 4731;
  const blocker = await occupy(busyPort);
  let child;
  try {
    child = spawn(process.execPath, [path.join(root, 'server.js')], {
      env: {
        ...process.env,
        PORT: String(busyPort),
        NO_OPEN: '1',
        COSCI_NO_AUTOSTART: '', // allow auto-start in the subprocess
      },
      stdio: 'ignore',
    });

    // Must NOT crash on the busy port; must come up on busyPort + 1.
    const up = await waitForServer(busyPort + 1);
    assert.ok(up, `server should have started on ${busyPort + 1} after ${busyPort} was busy`);
  } finally {
    if (child) child.kill();
    await new Promise((r) => blocker.close(r));
  }
});
