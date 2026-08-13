// Clean and stage the main-process build without shelling out to coreutils.
//
// The build previously ran `rm -rf dist/main` and `cp src/main/preload.cjs
// dist/main/main/preload.cjs`. Neither command exists in cmd.exe or
// PowerShell, so `npm run build` only worked from a POSIX shell. npm runs
// scripts through cmd.exe on Windows, so the && chaining is fine — only the
// coreutils calls had to go.
//
// The preload stays CommonJS (an ESM preload fails under Electron's sandbox),
// so tsc does not emit it and it is copied verbatim.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mainOut = join(root, 'dist', 'main');
const step = process.argv[2];

if (step === 'clean') {
  rmSync(mainOut, { recursive: true, force: true });
  console.log(`[zerog] cleaned ${mainOut}`);
} else if (step === 'preload') {
  const source = join(root, 'src', 'main', 'preload.cjs');
  const target = join(mainOut, 'main', 'preload.cjs');
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log(`[zerog] preload -> ${target}`);
} else {
  console.error('usage: node scripts/build-main.mjs <clean|preload>');
  process.exit(1);
}
