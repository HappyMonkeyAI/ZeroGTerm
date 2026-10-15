// Local release validation against a built Electron app. No publication or credentials.
// node scripts/release-smoke.mjs <executable> <profile-directory> [ssh-target]
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { createServer as httpServer } from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';

const [executable, profileArg, target] = process.argv.slice(2);
if (!executable || !profileArg) throw new Error('usage: node scripts/release-smoke.mjs <executable> <isolated-profile> [ssh-target]');
const profile = resolve(profileArg);
await mkdir(profile, { recursive: true });
const run = promisify(execFile);
const parsedTarget = target ? (await import('../dist/main/main/session-service.js')).parseSshTarget(target) : null;
const delay = ms => new Promise(r => setTimeout(r, ms));
const screenName = `zerog-release-${process.pid}`;
const expectedVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const results = [];
const logs = [];
let child, cdp, exitPromise;
let speechUploads = 0;
const fixture = httpServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.end(); return; }
  if (req.url === '/v1/audio/transcriptions') { speechUploads++; req.resume(); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ text: 'ZEROG_VOICE_TYPED_ONLY' })); }); return; }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/models') res.end(JSON.stringify({ data: [{ id: 'release-fixture' }] }));
  else if (req.url === '/v1/chat/completions') res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ command: 'pwd', explanation: 'Show the directory.' }) } }] }));
  else res.end(JSON.stringify({ marker: 'ZEROG_TUNNEL_OK' }));
});
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
const fixturePort = fixture.address().port;
async function freePort() {
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise(r => server.close(r));
  return port;
}
async function until(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function launch() {
  const port = await freePort();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(resolve(executable), [...(/^electron(?:\.exe)?$/i.test(basename(executable)) ? [resolve(process.env.ZEROG_SMOKE_APP_ROOT ?? process.cwd())] : []), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--disable-gpu', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  exitPromise = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  child.stdout.on('data', b => logs.push(b.toString())); child.stderr.on('data', b => logs.push(b.toString()));
  const page = await until(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p => p.type === 'page'); } catch { return null; }
  }, 'debugger target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, reject) => { ws.onopen = r; ws.onerror = reject; });
  let next = 0; const pending = new Map();
  ws.onmessage = event => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) { const { resolve, reject, timer } = pending.get(data.id); clearTimeout(timer); pending.delete(data.id); data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result); }
  };
  ws.onclose = () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Debugger closed')); } pending.clear(); };
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 45000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  await until(() => evaluate(() => Boolean(window.zerog && document.querySelector('button'))), 'renderer preload');
}
async function evaluate(fn, ...args) {
  const response = await cdp('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
}
async function quit() {
  await cdp('Browser.close').catch(() => {});
  const exit = await Promise.race([exitPromise, delay(12000).then(() => { throw new Error('App did not shut down within 12 seconds'); })]);
  assert.equal(exit.code, 0); child = undefined;
}
async function ssh(args) { return (await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...(parsedTarget.port ? ['-p', parsedTarget.port] : []), '--', parsedTarget.destination, ...args], { timeout: 15000 })).stdout; }
try {
  if (target) await ssh(['screen', '-dmS', screenName, 'bash', '--noprofile', '--norc']);
  await launch();
  const version = await evaluate(() => window.zerog.appVersion());
  assert.equal(version, expectedVersion); results.push({ check: 'packaged version and preload', version });
  await evaluate(port => { localStorage.setItem('zerog-settings', JSON.stringify({ appearance: { theme: 'nord' }, speech: { engine: 'server', serverUrl: `http://127.0.0.1:${port}/v1/audio/transcriptions`, serverModel: 'release-fixture', silenceThreshold: 0.0005 }, ai: { voiceInsert: 'type' } })); }, fixturePort);
  await cdp('Page.reload');
  await until(() => evaluate(() => document.documentElement?.dataset.theme === 'nord' && Boolean(document.querySelector('.drawer-action'))), 'stored settings and appearance');
  results.push({ check: 'appearance settings restored after renderer reload', theme: 'nord' });
  await evaluate(() => {
    window.__releaseOutput = {};
    window.zerog.onData((id, data) => { window.__releaseOutput[id] = (window.__releaseOutput[id] ?? '') + data; });
    const button = [...document.querySelectorAll('button')].find(b => b.classList.contains('drawer-action') && b.textContent.trim().startsWith('Local terminal'));
    if (!button) throw new Error('Local terminal button missing'); button.click();
  });
  await until(() => evaluate(() => Boolean(document.querySelector('.modal-actions button[type=submit]'))), 'local dialog');
  await evaluate(() => document.querySelector('.modal-actions button[type=submit]').click());
  const local = await until(() => evaluate(async () => (await window.zerog.listSessions()).find(s => s.kind === 'local' && s.status === 'connected')), 'local PTY');
  await evaluate(id => window.zerog.write(id, 'echo ZEROG_LOCAL_OK\r'), local.id);
  await until(() => evaluate(id => window.__releaseOutput[id]?.includes('ZEROG_LOCAL_OK'), local.id), 'local terminal output');
  results.push({ check: 'UI local terminal creation and real output', backend: local.backend });
  await evaluate(name => document.querySelector(`button[aria-label="Voice input for ${name}"]`).click(), local.name);
  await until(() => evaluate(() => Boolean(document.querySelector('button[title="Stop and transcribe"]'))), 'synthetic microphone capture');
  await delay(1200);
  await evaluate(() => document.querySelector('button[title="Stop and transcribe"]').click());
  await until(() => evaluate(id => window.__releaseOutput[id]?.includes('ZEROG_VOICE_TYPED_ONLY'), local.id), 'speech fixture text insertion');
  assert.equal(speechUploads, 1);
  await evaluate(id => window.zerog.write(id, String.fromCharCode(3)), local.id);
  results.push({ check: 'synthetic microphone, server transcription fixture, text insertion without Enter' });
  const modelResult = await evaluate(async port => {
    const config = { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'release-fixture' };
    return { models: await window.zerog.listAiModels(config.baseUrl), test: await window.zerog.testAiEndpoint(config), suggestion: await window.zerog.requestAiCommand(config, { prompt: 'show the directory', context: { kind: 'local' } }) };
  }, fixturePort);
  assert.deepEqual(modelResult.models, ['release-fixture']); assert.equal(modelResult.test.ok, true); assert.equal(modelResult.suggestion.command, 'pwd'); results.push({ check: 'AI HTTP fixture through preload', ...modelResult });
  if (process.env.ZEROG_SMOKE_BUILTIN_AUDIO) {
    const audio = (await readFile(process.env.ZEROG_SMOKE_BUILTIN_AUDIO)).toString('base64');
    const workerFile = (await readdir('dist/renderer/assets')).find(name => /^voice-worker-.*\.js$/.test(name));
    assert.ok(workerFile);
    await evaluate(async (audio, workerFile) => {
      const bytes = Uint8Array.from(atob(audio), c => c.charCodeAt(0));
      const decoder = new AudioContext();
      const decoded = await decoder.decodeAudioData(bytes.buffer);
      const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
      const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
      const samples = (await offline.startRendering()).getChannelData(0);
      await decoder.close();
      window.__builtinResult = null;
      const worker = new Worker(new URL(`./assets/${workerFile}`, location.href), { type: 'module' });
      window.__builtinWorker = worker;
      worker.onmessage = ({ data }) => { if (data.type === 'result' || data.type === 'error') { window.__builtinResult = data; worker.terminate(); } };
      worker.onerror = event => { window.__builtinResult = { type: 'error', message: event.message }; worker.terminate(); };
      worker.postMessage({ type: 'transcribe', id: 1, audio: samples, config: { model: 'onnx-community/whisper-tiny.en', precision: 'q8', device: 'wasm', language: 'auto', task: 'transcribe', multilingual: false } }, [samples.buffer]);
    }, audio, workerFile);
    console.log('Built-in Whisper: loading and transcribing synthesized audio');
    const transcript = await until(() => evaluate(() => window.__builtinResult), 'built-in Whisper inference', 180000);
    assert.equal(transcript.type, 'result', JSON.stringify(transcript));
    assert.match(transcript.text, /terminal|release|gravity/i);
    results.push({ check: 'built-in Whisper WASM inference on synthesized speech', transcript: transcript.text, elapsedMs: transcript.elapsedMs });
  }
  if (target) {
    const uploadFile = join(profile, 'release-fixture.txt'); const downloadDir = join(profile, 'download');
    await writeFile(uploadFile, 'ZeroG transfer roundtrip\n'); await mkdir(downloadDir, { recursive: true });
    const transfer = await evaluate(async (host, source, destination, directory) => {
      const api = window.zerog; const open = await api.sftpOpen(host);
      const remote = `${open.cwd}/${directory}`;
      try {
        await api.sftpMkdir(open.id, remote);
        await api.sftpUpload(open.id, source, remote);
        const listing = await api.sftpList(open.id, remote);
        await api.sftpDownload(open.id, `${remote}/release-fixture.txt`, destination, 'file');
        await api.sftpRename(open.id, `${remote}/release-fixture.txt`, `${remote}/renamed.txt`);
        await api.sftpRemove(open.id, `${remote}/renamed.txt`, 'file');
        await api.sftpRemove(open.id, remote, 'directory');
        return listing;
      } finally { await api.sftpClose(open.id); }
    }, target, uploadFile, downloadDir, `.zerog-release-${process.pid}`);
    assert.equal(await readFile(join(downloadDir, 'release-fixture.txt'), 'utf8'), 'ZeroG transfer roundtrip\n');
    results.push({ check: 'live SFTP mkdir/upload/list/download/rename/remove', path: transfer.path });
    const listenPort = await freePort();
    const forward = await evaluate((host, port) => window.zerog.openForward({ target: host, direction: 'local', listenPort: port, destinationPort: 22, bind: 'loopback' }), target, listenPort);
    const banner = await new Promise((resolve, reject) => { const socket = net.connect(listenPort, '127.0.0.1'); socket.setTimeout(5000); socket.once('data', b => { socket.destroy(); resolve(b.toString()); }); socket.once('error', reject); socket.once('timeout', () => { socket.destroy(); reject(new Error('SSH banner timeout')); }); });
    assert.match(banner, /^SSH-2\.0/); await evaluate(id => window.zerog.closeForward(id), forward.id);
    results.push({ check: 'live local SSH forwarding to remote SSH service', status: forward.status });
    const remotePort = 48652;
    const reverse = await evaluate((host, remotePort, localPort) => window.zerog.openForward({ target: host, direction: 'remote', listenPort: remotePort, destinationPort: localPort, destinationHost: '127.0.0.1', bind: 'loopback' }), target, remotePort, fixturePort);
    assert.match(await ssh(['curl', '-fsS', `http://127.0.0.1:${remotePort}/health`]), /ZEROG_TUNNEL_OK/);
    await evaluate(id => window.zerog.closeForward(id), reverse.id); results.push({ check: 'live reverse SSH forwarding to local HTTP fixture' });
    const screen = await evaluate(async (host, name) => {
      const api = window.zerog;
      const match = host.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
      const screens = await api.discoverRemoteScreens({ alias: match[2], hostName: match[2], ...(match[1] ? { user: match[1] } : {}), ...(match[3] ? { port: Number(match[3]) } : {}) });
      if (!screens.some(s => s.screenName === name)) throw new Error('Screen not discovered');
      const session = await api.createSshSession({ target: host, name, screenName: name }); await api.attachSession(session.id); return session;
    }, target, screenName);
    await until(() => evaluate(id => window.__releaseOutput[id]?.includes('bash-'), screen.id), 'screen prompt');
    await evaluate(id => { window.__releaseOutput[id] = ''; window.zerog.write(id, 'export ZEROG_RELEASE_PROBE=ZEROG_RESTART_OK\r'); }, screen.id);
    await until(() => evaluate(id => window.__releaseOutput[id]?.includes('bash-'), screen.id), 'export completed');
    await delay(1000);
    await evaluate(async session => {
      localStorage.setItem('zerog-release-storage', 'persisted');
      await window.zerog.saveWorkspaces({ version: 1, activeWorkspaceId: 'release', workspaces: [{ id: 'release', name: 'Release check', view: { layout: 'stack', lastSplit: 'vertical', activeSessionId: session.id, focusedSessionId: session.id, maximizedSessionId: null }, members: [{ sessionId: session.id, kind: 'ssh', name: session.name, host: session.host, sshTarget: session.sshTarget, screenName: session.screenName, backend: 'screen' }] }] });
    }, screen);
    await quit(); await launch();
    assert.equal(await evaluate(() => localStorage.getItem('zerog-release-storage')), 'persisted');
    assert.equal((await evaluate(() => window.zerog.listSessions())).filter(s => s.kind === 'ssh').length, 0);
    await until(() => evaluate(name => document.body.innerText.includes(name), screenName), 'restored ghost row');
    await evaluate(name => {
      window.__releaseOutput = {};
      window.zerog.onData((id, data) => { window.__releaseOutput[id] = (window.__releaseOutput[id] ?? '') + data; });
      const row = [...document.querySelectorAll('button')].find(b => b.textContent.includes(name));
      if (!row) throw new Error('Reconnect row missing'); row.click();
    }, screenName);
    const restored = await until(() => evaluate(async name => (await window.zerog.listSessions()).find(s => s.screenName === name), screenName), 'reconnected session');
    await until(() => evaluate(id => window.__releaseOutput[id]?.includes('bash-'), restored.id), 'restored screen output');
    await evaluate(id => { window.__releaseOutput[id] = ''; window.zerog.write(id, 'printenv ZEROG_RELEASE_PROBE\r'); }, restored.id);
    await until(() => evaluate(id => window.__releaseOutput[id]?.includes('ZEROG_RESTART_OK'), restored.id), 'surviving shell state');
    results.push({ check: 'application restart, workspace ghost, explicit reconnect, surviving shell state' });
  }
  if (!target && local.persistence === 'screen') {
    await evaluate(id => { window.__releaseOutput[id] = ''; window.zerog.write(id, 'export ZEROG_LOCAL_PROBE=ZEROG_LOCAL_RESTART_OK\r'); }, local.id);
    await until(() => evaluate(id => window.__releaseOutput[id]?.includes('ZEROG_LOCAL_RESTART_OK'), local.id), 'local export');
    await delay(1200);
    await quit(); await launch();
    await until(() => evaluate(async id => (await window.zerog.listSessions()).some(s => s.id === id && s.status === 'connected'), local.id), 'automatic local screen restoration');
    await evaluate(id => {
      window.__localRestored = '';
      window.zerog.onData((session, data) => { if (session === id) window.__localRestored += data; });
      window.zerog.write(id, 'printenv ZEROG_LOCAL_PROBE\r');
    }, local.id);
    await until(() => evaluate(() => window.__localRestored.includes('ZEROG_LOCAL_RESTART_OK')), 'local shell state survived app restart');
    await evaluate(id => window.zerog.closeSession(id), local.id);
    await run('screen', ['-S', local.screenName, '-X', 'quit']);
    results.push({ check: 'Linux local screen automatically restored with surviving shell state across app restart' });
  }
  const capture = await cdp('Page.captureScreenshot', { format: 'png' }); await writeFile(join(profile, 'smoke.png'), Buffer.from(capture.data, 'base64'));
  await quit();
  assert.doesNotMatch(logs.join(''), /AttachConsole failed|PTY shutdown timed out|shutdown failed/);
  console.log(JSON.stringify({ status: 'passed', results }, null, 2));
} catch (error) {
  console.error(error); process.exitCode = 1;
  if (child) { await quit().catch(() => child?.kill()); }
} finally {
  fixture.close();
  if (target) await ssh(['screen', '-S', screenName, '-X', 'quit']).catch(e => console.error('Test screen cleanup:', e.message));
  await writeFile(join(profile, 'runtime.log'), logs.join(''));
  await writeFile(join(profile, 'results.json'), JSON.stringify({ results, exitCode: process.exitCode ?? 0 }, null, 2));
}
