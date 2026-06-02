import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const files = [
  'server.js', 'utils.js', 'main.js', 'build-exe.mjs',
  'electron/main.cjs', 'electron/preload.cjs',
  'electron/renderer/app.js', 'electron/renderer/web-bridge.js',
  ...readdirSync(path.join(root, 'agents')).map(f => `agents/${f}`),
];

for (const f of files) {
  test(`node --check passes: ${f}`, () => {
    assert.doesNotThrow(() =>
      execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' }),
    );
  });
}
