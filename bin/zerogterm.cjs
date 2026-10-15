#!/usr/bin/env node

const { spawn } = require('node:child_process');
const path = require('node:path');
let electron;
try {
  electron = require('electron');
} catch {
  console.error('Electron runtime was not found. Install both packages: npm install --global electron@43 zerogterm');
  process.exit(1);
}

const packageRoot = path.resolve(__dirname, '..');
const child = spawn(electron, [packageRoot, ...process.argv.slice(2)], {
  stdio: 'inherit'
});

child.on('error', (error) => {
  console.error(`Failed to start ZeroG Terminal: ${error.message}`);
  process.exitCode = 1;
});

child.on('close', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
