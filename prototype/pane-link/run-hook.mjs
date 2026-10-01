// PROTOTYPE - throwaway. Hook-driven variant of run.mjs: turn end + reply text come from a
// Claude Code Stop hook injected per pane with `--settings`, not from scraping the screen.
// Run: npm run proto:pane-link-hook   (env: PROTO_CWD, CLAUDE_BIN, PROTO_CAP, PROTO_SEED)
// Output: hook-run.log (every raw event) and hook-transcript.json (what was relayed).
import pty from 'node-pty';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strip } from './relay.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(dir, 'hook-run.log');
fs.writeFileSync(logPath, '');
const log = (...a) => fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${a.join(' ')}\n`);

const cwd = process.env.PROTO_CWD || process.cwd();
const bin = process.env.CLAUDE_BIN || 'claude';
const cap = Number(process.env.PROTO_CAP || 4);
const hookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zerog-hooks-'));
const eventsPath = path.join(hookDir, 'events.jsonl');
const sink = path.join(dir, 'hook-sink.mjs');

// Inline settings: the documented nested hooks schema. Forward slashes avoid JSON/escape trouble.
const q = (p) => '"' + p.replace(/\\/g, '/') + '"';
const settings = JSON.stringify({
  hooks: { Stop: [{ hooks: [{ type: 'command', command: `node ${q(sink)}` }] }] },
});

const panes = {};
const ready = { a: false, b: false };
const tails = { a: '', b: '' };
const transcript = [];
let waitingOn = null;
let turns = 0;
let readOffset = 0;
let finished = false;
const other = (p) => (p === 'a' ? 'b' : 'a');

for (const id of ['a', 'b']) {
  const p = pty.spawn(bin, ['--settings', settings], {
    name: 'xterm-256color', cols: 110, rows: 40, cwd,
    env: { ...process.env, ZEROG_PANE_ID: id, ZEROG_HOOK_DIR: hookDir },
  });
  panes[id] = p;
  p.onData((d) => {
    tails[id] = (tails[id] + strip(d)).slice(-1500);
    if (/for\s*shortcuts/.test(tails[id])) ready[id] = true;
  });
  p.onExit((e) => log(`EXIT ${id}`, JSON.stringify(e)));
}

function send(to, text) {
  log(`SEND -> ${to}: ${JSON.stringify(text).slice(0, 500)}`);
  waitingOn = to;
  panes[to].write('\x1b[200~' + text + '\x1b[201~');
  setTimeout(() => panes[to].write('\r'), 300);
}

function finish(reason) {
  if (finished) return;
  finished = true;
  log(`DONE: ${reason}`);
  fs.writeFileSync(path.join(dir, 'hook-transcript.json'), JSON.stringify(transcript, null, 2));
  for (const p of Object.values(panes)) { try { p.kill(); } catch { /* already gone */ } }
  setTimeout(() => process.exit(0), 300);
}

function handle(ev) {
  log(`HOOK pane=${ev.pane} keys=${Object.keys(ev.payload).join(',')} msg=${JSON.stringify(ev.payload.last_assistant_message ?? null).slice(0, 300)}`);
  if (ev.pane !== waitingOn) { log(`  ignored (waiting on ${waitingOn})`); return; }
  const reply = (ev.payload.last_assistant_message ?? '').trim();
  turns += 1;
  transcript.push({ turn: turns, from: ev.pane, text: reply, at: ev.at });
  if (!reply) return finish('empty reply');
  if (turns >= cap) return finish('turn cap');
  send(other(ev.pane), `Message from the other agent (${ev.pane}):\n${reply}`);
}

setInterval(() => {
  if (!fs.existsSync(eventsPath)) return;
  const buf = fs.readFileSync(eventsPath, 'utf8');
  const lines = buf.slice(readOffset).split('\n');
  const complete = lines.slice(0, -1); // last piece may be a partial write
  readOffset += complete.reduce((n, l) => n + l.length + 1, 0);
  for (const l of complete) if (l.trim()) { try { handle(JSON.parse(l)); } catch (e) { log('bad event line', String(e)); } }
}, 200);

const seed = process.env.PROTO_SEED ||
  'You are one of two AI agents talking to each other through a relay. Do not use any tools. ' +
  'Reply in at most three sentences. Topic: should a terminal app link two AI agent panes so they can talk? Make your opening argument.';
const t0 = Date.now();
const startTimer = setInterval(() => {
  if ((ready.a && ready.b) || Date.now() - t0 > 40000) {
    clearInterval(startTimer);
    log(`START ready a=${ready.a} b=${ready.b} hookDir=${hookDir}`);
    send('a', seed);
  }
}, 500);
setTimeout(() => finish('hard timeout 5min'), 300000);
