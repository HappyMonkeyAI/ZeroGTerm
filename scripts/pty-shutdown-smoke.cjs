// Reproduce and guard against Windows ConPTY shutdown races with real processes.
const { spawn } = require('node:child_process');
if (process.platform !== 'win32') { console.log('Windows-only ConPTY check skipped.'); process.exit(0); }
if (!process.argv.includes('--worker')) {
  (async () => {
    for (const mode of ['forced', 'natural']) {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [__filename, '--worker', mode], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '', stderr = '';
        child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
        const timer = setTimeout(() => { child.kill(); reject(new Error(`${mode}: runner hung`)); }, 12000);
        child.on('error', reject);
        child.on('exit', code => { clearTimeout(timer); if (code !== 0 || /AttachConsole failed/.test(stderr)) reject(new Error(`${mode}: ${stderr || stdout}`)); else resolve(stdout.trim()); });
      });
      console.log(result);
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const pty = require('node-pty');
  const natural = process.argv.includes('natural');
  const code = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log('PTY_PIDS:'+process.pid+','+child.pid); ${natural ? 'setTimeout(()=>process.exit(0),50);' : 'setInterval(()=>{},1000);'}`;
  const terminal = pty.spawn(process.execPath, ['-e', code], { name: 'xterm-256color', cols: 100, rows: 24, cwd: process.cwd(), env: { ...process.env, TERM: 'xterm-256color' } });
  let output = '', done = false;
  const cap = setTimeout(() => { terminal.kill(); process.exitCode = 1; }, 8000);
  terminal.onData(data => {
    output += data;
    const match = output.match(/PTY_PIDS:(\d+),(\d+)/);
    if (!match || done) return;
    done = true; clearTimeout(cap);
    const pids = match.slice(1).map(Number);
    setTimeout(() => {
      terminal.kill();
      setTimeout(() => {
        const alive = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
        console.log(JSON.stringify({ mode: natural ? 'natural' : 'forced', pids, alive }));
        if (alive.length) { alive.forEach(pid => { try { process.kill(pid); } catch {} }); process.exitCode = 1; }
      }, 1500);
    }, natural ? 300 : 0);
  });
}
