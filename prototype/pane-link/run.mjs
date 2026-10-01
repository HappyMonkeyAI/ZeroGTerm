// PROTOTYPE - throwaway shell around relay.mjs. Run: npm run proto:pane-link
// Spawns two real `claude` TUIs under node-pty and relays between them on a quiet timer.
// Everything is logged to prototype/pane-link/run.log so the result can be inspected afterwards.
// Keys: q = break the link and quit.
import pty from 'node-pty';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRelay, strip } from './relay.mjs';

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const logPath = path.join(dir, 'run.log');
fs.writeFileSync(logPath, '');
const log = (...a) => fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${a.join(' ')}\n`);

const cwd = process.env.PROTO_CWD || fs.mkdtempSync(path.join(os.tmpdir(), 'pane-link-'));
const bin = process.env.CLAUDE_BIN || 'claude';
const cap = Number(process.env.PROTO_CAP || 4);
const relay = createRelay({ cap, quietMs: Number(process.env.PROTO_QUIET_MS || 3000) });
const panes = {};
const ready = { a: false, b: false };
const tails = { a: '', b: '' };

for (const id of ['a', 'b']) {
  const p = pty.spawn(bin, [], { name: 'xterm-256color', cols: 110, rows: 40, cwd, env: process.env });
  panes[id] = p;
  p.onData((d) => {
    const clean = strip(d);
    tails[id] = (tails[id] + clean).slice(-1500);
    log(`DATA ${id} ${JSON.stringify(clean).slice(0, 400)}`);
    if (/trust/i.test(clean) && /\byes\b|1\./i.test(tails[id]) && !ready[id]) {
      log(`trust prompt on ${id}, accepting`);
      p.write('\r');
    }
    if (/for\s*shortcuts/.test(tails[id])) ready[id] = true;
    run(relay.onData(id, d, Date.now()));
  });
  p.onExit((e) => { log(`EXIT ${id}`, JSON.stringify(e)); });
}

function run(actions) {
  for (const a of actions) {
    if (a.type === 'send') {
      log(`SEND -> ${a.to}: ${JSON.stringify(a.text).slice(0, 600)}`);
      // bracketed paste so embedded newlines don't submit early, then Enter
      panes[a.to].write('\x1b[200~' + a.text + '\x1b[201~');
      setTimeout(() => panes[a.to].write('\r'), 300);
    } else if (a.type === 'broken') {
      log(`BROKEN: ${a.reason}`);
      finish();
    }
  }
}

function render() {
  const s = relay.state;
  console.clear();
  console.log(`\x1b[1mphase\x1b[0m ${s.phase}  \x1b[1mwaitingOn\x1b[0m ${s.waitingOn}  \x1b[1mturns\x1b[0m ${s.turns}/${s.cap}  \x1b[1mbroken\x1b[0m ${s.brokenReason ?? '-'}`);
  console.log(`\x1b[2mcwd ${cwd}  ready a=${ready.a} b=${ready.b}\x1b[0m`);
  for (const t of s.transcript) console.log(`\x1b[1m#${t.turn} from ${t.from}\x1b[0m ${t.text.length} chars`);
  console.log('\x1b[1mbuffer (tail)\x1b[0m\n' + s.buf.slice(-600));
  console.log('\x1b[2m[q] break + quit\x1b[0m');
}

function finish() {
  fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(relay.state.transcript, null, 2));
  render();
  for (const p of Object.values(panes)) { try { p.kill(); } catch {} }
  setTimeout(() => process.exit(0), 300);
}

// Start once both TUIs look ready (or after a fallback delay).
const seed = process.env.PROTO_SEED ||
  'You are one of two AI agents talking to each other through a relay. Do not use any tools. ' +
  'Reply in at most three sentences. Topic: should a terminal app link two AI agent panes so they can talk? Make your opening argument.';
let started = false;
const startTimer = setInterval(() => {
  if (!started && ((ready.a && ready.b) || Date.now() - t0 > 25000)) {
    started = true;
    clearInterval(startTimer);
    log(`START ready a=${ready.a} b=${ready.b}`);
    run(relay.start('a', seed, Date.now()));
  }
}, 500);
const t0 = Date.now();
setInterval(() => { run(relay.tick(Date.now())); render(); }, 500);

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on('data', (k) => { if (String(k) === 'q') { log('USER BREAK'); run(relay.breakLink('user')); } });
}
setTimeout(() => { log('HARD TIMEOUT'); run(relay.breakLink('hard timeout 10min')); }, 600000);
