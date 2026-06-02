// Build LabMate into a single-file Windows executable using Node SEA.
// Run: node build-exe.mjs
import { build } from 'esbuild';
import { execFileSync } from 'child_process';
import { copyFileSync, mkdirSync, cpSync, existsSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const isWin = process.platform === 'win32';
const exeName = isWin ? 'LabMate.exe' : 'LabMate';
const exePath = path.join(dist, exeName);

function step(msg) { console.log(`\n▸ ${msg}`); }

(async () => {
  mkdirSync(dist, { recursive: true });

  // 1. Bundle server.js + all deps into one CommonJS file.
  step('Bundling app with esbuild…');
  await build({
    entryPoints: [path.join(root, 'server.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(dist, 'labmate.cjs'),
    banner: {
      js: "try{var __p=require('path');var __s=require('node:sea');if(__s.isSea())process.env.COSCI_BASE=__p.dirname(process.execPath);}catch(e){}",
    },
    logLevel: 'error',
  });

  // 2. Generate the SEA preparation blob.
  step('Generating SEA blob…');
  execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: root, stdio: 'inherit' });

  // 3. Copy the Node runtime to the target exe.
  step(`Copying Node runtime → ${exeName}…`);
  copyFileSync(process.execPath, exePath);

  // 4. Inject the blob (postject). On macOS the binary must be re-signed; on
  //    Windows the original signature is invalidated (harmless for local use).
  step('Injecting app blob (postject)…');
  const postjectArgs = [
    'postject', exePath, 'NODE_SEA_BLOB', path.join(dist, 'labmate.blob'),
    '--sentinel-fuse', FUSE,
  ];
  if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  execFileSync('npx', postjectArgs, { cwd: root, stdio: 'inherit', shell: true });

  // 5. Copy runtime assets next to the exe (read at runtime relative to it).
  step('Copying assets next to the executable…');
  cpSync(path.join(root, 'prompts'), path.join(dist, 'prompts'), { recursive: true });
  cpSync(path.join(root, 'electron', 'renderer'), path.join(dist, 'electron', 'renderer'), { recursive: true });
  copyFileSync(path.join(root, 'intake.example.json'), path.join(dist, 'intake.example.json'));
  if (existsSync(path.join(root, '.env'))) {
    copyFileSync(path.join(root, '.env'), path.join(dist, '.env'));
  }

  // Tidy intermediate files
  for (const f of ['labmate.cjs', 'labmate.blob']) {
    try { rmSync(path.join(dist, f)); } catch {}
  }

  console.log(`\n✅ Done. Your app is at:  dist/${exeName}`);
  console.log('   Double-click it (or run it) — no Node install required.');
  console.log('   Keep the prompts/, electron/, intake.example.json and .env files alongside it.\n');
})().catch((err) => {
  console.error(`\n✗ Build failed: ${err.message}`);
  process.exit(1);
});
