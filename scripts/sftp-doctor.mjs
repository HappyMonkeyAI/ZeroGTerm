// Reproduce what the transfer panel does when it opens a connection, and print
// everything the sftp client says while it does it.
//
//   node scripts/sftp-doctor.mjs user@host
//   node scripts/sftp-doctor.mjs user@host --local   (no network: local server)
//
// The panel drives the system sftp client over a pty and waits for its `sftp> `
// prompt. When that prompt never arrives the panel can only report that the host
// stopped responding, which says nothing about why. This prints the raw traffic
// with timings, so the answer is visible: an unanswered password prompt, a host
// key question, a banner, a client that never started, or silence.
//
// Nothing here is part of the application. It exists because this failure mode
// happens on someone else's machine, against someone else's server.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const target = args.find((value) => !value.startsWith('-'));
const local = args.includes('--local');

if (!target && !local) {
  console.error('usage: node scripts/sftp-doctor.mjs user@host [--local]');
  process.exit(2);
}

let pty;
try {
  pty = require(join(root, 'node_modules', 'node-pty'));
} catch (error) {
  console.error('node-pty is not built here. Run npm install first.');
  console.error(String(error));
  process.exit(2);
}

const { findOpenSshTool } = await import(new URL('../dist/main/main/shell-catalog.js', import.meta.url).href).catch(
  async () => {
    console.error('dist is missing or stale. Run npm run build first.');
    process.exit(2);
  }
);

const client = findOpenSshTool('sftp');
console.log('platform      :', process.platform, process.arch);
console.log('sftp client   :', client ?? 'NOT FOUND — this alone would break the panel');
console.log('SSH_AUTH_SOCK :', process.env.SSH_AUTH_SOCK ? 'set (agent available)' : 'not set');
if (!client) process.exit(1);

// The same arguments the service builds, so this exercises the real invocation.
const spawnArgs = local
  ? ['-D', process.platform === 'win32' ? 'C:/PROGRA~1/Git/usr/lib/ssh/SFTP-S~1.EXE' : '/usr/lib/openssh/sftp-server']
  : ['-o', 'ConnectTimeout=20', target];

console.log('arguments     :', JSON.stringify(spawnArgs));
console.log('');
console.log('--- raw pty traffic (ctrl-c to stop) ---');

const started = Date.now();
const stamp = () => `${String((Date.now() - started) / 1000).padStart(6, ' ')}s`;

const term = pty.spawn(client, spawnArgs, {
  name: 'xterm-256color',
  cols: 512,
  rows: 24,
  cwd: process.cwd(),
  env: process.env
});

let seen = '';
let prompted = false;
let answered = false;
/** Which line endings have been tried, in the order the service tries them. */
const terminators = [
  { label: 'LF', value: '\n' },
  { label: 'CR', value: '\r' }
];
let tried = -1;

/**
 * Ask `pwd` with the next line ending.
 *
 * Which one submits a command depends on whether the client's interactive line
 * editor is running: without it a newline ends a line, with it the editor accepts
 * on carriage return. An unsubmitted command is echoed and then ignored, which
 * looks exactly like the host having gone quiet — so the service probes, and so
 * does this.
 */
function askWithNextTerminator() {
  tried += 1;
  if (tried >= terminators.length) return;
  const { label, value } = terminators[tried];
  console.log(`${stamp()} ---> asking for the working directory, ending the line with ${label}`);
  term.write(`pwd${value}`);
  setTimeout(() => {
    if (answered) return;
    console.log(`${stamp()} ---> no answer to ${label}; that ending does not submit for this client`);
    askWithNextTerminator();
  }, 5000);
}

term.onData((data) => {
  seen += data;
  console.log(`${stamp()} RECV ${JSON.stringify(data)}`);
  if (/Remote working directory:/.test(seen)) {
    if (!answered) {
      answered = true;
      const { label } = terminators[Math.min(tried, terminators.length - 1)];
      console.log(`${stamp()} ---> answered. This client submits on ${label}.`);
      // There is nothing left to learn once it has answered.
      setTimeout(() => {
        try { term.kill(); } catch { /* gone */ }
        verdict();
        process.exit(0);
      }, 400);
    }
    return;
  }
  if (!prompted && seen.includes('sftp>')) {
    prompted = true;
    console.log(`${stamp()} ---> prompt seen.`);
    askWithNextTerminator();
  }
});

term.onExit(({ exitCode }) => {
  console.log(`${stamp()} EXIT code=${exitCode}`);
  verdict();
  process.exit(0);
});

// Anything the client is waiting on, in the words it used.
function verdict() {
  console.log('');
  console.log('--- verdict ---');
  const plain = seen.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const tail = plain.slice(-400).trim();
  if (!plain) {
    console.log('The client produced no output at all. It started but said nothing —');
    console.log('so the panel would wait, then report that the host stopped responding.');
  } else if (answered) {
    console.log('Healthy: the prompt appeared and pwd was answered. The panel should work');
    console.log('against this host.');
  } else if (prompted) {
    console.log('The prompt appeared but pwd was not answered within the time this ran.');
  } else if (/password:|passcode|verification code|two-factor|\(yes\/no/i.test(plain)) {
    console.log('The client is waiting for you to answer something:');
    console.log(`  ${tail.split('\n').pop()}`);
    console.log('The panel surfaces password, passphrase and host-key questions. If it did');
    console.log('not surface this one, the wording is what it failed to recognise.');
  } else {
    console.log('No prompt appeared. The last thing the client said was:');
    console.log(`  ${tail || '(nothing)'}`);
  }
  console.log('');
  console.log('Paste everything above, including the raw traffic.');
}

// Long enough to outlast ConnectTimeout and a slow login, short enough to end.
setTimeout(() => {
  console.log(`${stamp()} (giving up on further output)`);
  try { term.kill(); } catch { /* already gone */ }
  verdict();
  process.exit(0);
}, 45_000);
