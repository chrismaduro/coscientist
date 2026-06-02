// Test runner: isolates all file I/O under a throwaway COSCI_BASE so tests never
// touch the real state/, output/, or .env. Copies prompts/ there (agents read
// them via PROMPTS_DIR), then runs `node --test`.
import { mkdtempSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = mkdtempSync(path.join(tmpdir(), 'cosci-test-'));

// Assets/dirs the code expects under COSCI_BASE.
cpSync(path.join(root, 'prompts'), path.join(base, 'prompts'), { recursive: true });
cpSync(path.join(root, 'electron', 'renderer'), path.join(base, 'electron', 'renderer'), { recursive: true });
cpSync(path.join(root, 'intake.example.json'), path.join(base, 'intake.example.json'));
mkdirSync(path.join(base, 'state'), { recursive: true });
mkdirSync(path.join(base, 'output'), { recursive: true });

const res = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=spec', 'test/*.test.mjs'],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      COSCI_BASE: base,
      COSCI_NO_AUTOSTART: '1',
      NO_OPEN: '1',
      // Neutralise real keys so provider tests are deterministic.
      GOOGLE_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    },
  },
);

try { rmSync(base, { recursive: true, force: true }); } catch {}
process.exit(res.status ?? 1);
