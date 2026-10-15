import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { resolve, join, dirname } from 'node:path';

// node-pty 1.1.0 closes ConPTY before its process-list helper can attach.
// Keep teardown behind enumeration; do not switch to the experimental DLL backend.
const marker = '// ZeroG: enumerate before closing the console (v3).';
export function patchWindowsPtyAgent(source) {
  if (source.includes(marker)) return source;
  const start = '                this._getConsoleProcessList().then(function (consoleProcessList) {';
  const end = '                this._conoutSocketWorker.dispose();';
  const previous = source.indexOf('                // ZeroG: enumerate before closing the console');
  const from = previous >= 0 ? previous : source.indexOf(start);
  const to = previous >= 0 ? source.indexOf('\n            }\n            else {', from) : source.indexOf(end, from) + end.length;
  if (from < 0 || to < end.length || !source.slice(from, to).includes('._ptyNative.kill(')) {
    throw new Error('node-pty teardown patch no longer matches; review before upgrading.');
  }
  return source.slice(0, from) + `                ${marker}
                if (this._zerogKillPending) { return; }
                this._zerogKillPending = true;
                // A graceful client exit may precede the delayed public onExit.
                // Its console is already gone; do not fork an AttachConsole helper.
                if (this._exitCode !== undefined) {
                    this._ptyNative.kill(this._pty, this._useConptyDll);
                    this._conoutSocketWorker.dispose();
                    return;
                }
                this._getConsoleProcessList().then(function (consoleProcessList) {
                    try {
                        _this._ptyNative.kill(_this._pty, _this._useConptyDll);
                    } finally {
                        _this._conoutSocketWorker.dispose();
                        consoleProcessList.forEach(function (pid) {
                            try { process.kill(pid); } catch (e) { /* already exited */ }
                        });
                    }
                });` + source.slice(to);
}

export async function patchNodePty(root) {
  // npm may hoist dependencies beside the installed app rather than under it.
  const manifest = root ? join(root, 'node_modules', 'node-pty', 'package.json') : createRequire(import.meta.url).resolve('node-pty/package.json');
  const directory = dirname(manifest);
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (pkg.version !== '1.1.0') throw new Error(`Review the ConPTY teardown patch for node-pty ${pkg.version}.`);
  const file = join(directory, 'lib', 'windowsPtyAgent.js');
  const source = await readFile(file, 'utf8');
  const patched = patchWindowsPtyAgent(source);
  if (patched !== source) await writeFile(file, patched);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await patchNodePty();
}
