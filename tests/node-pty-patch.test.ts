import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { patchWindowsPtyAgent } from '../scripts/patch-node-pty.mjs';

// Execute the patched vendor method with controlled process enumeration.
// This tests ordering, rather than just searching the patch text.
describe('node-pty ConPTY teardown patch', () => {
  const source = readFileSync('node_modules/node-pty/lib/windowsPtyAgent.js', 'utf8');
  it('waits for the console process list before closing its console', async () => {
    const method = patchWindowsPtyAgent(source).split('WindowsPtyAgent.prototype.kill = ')[1].split('WindowsPtyAgent.prototype._getConsoleProcessList')[0].trim().replace(/;$/, '');
    const events: string[] = [];
    let enumerate!: (pids: number[]) => void;
    const kill = new Function('process', `return (${method});`)({ kill: (pid: number) => events.push(`kill:${pid}`) });
    const agent = { _useConpty: true, _useConptyDll: false, _inSocket: {}, _outSocket: {}, _pty: 1,
      _getConsoleProcessList: () => new Promise<number[]>((resolve) => { enumerate = resolve; }),
      _ptyNative: { kill: () => events.push('close-console') },
      _conoutSocketWorker: { dispose: () => events.push('dispose') } };
    kill.call(agent);
    kill.call(agent);
    expect(events).toEqual([]);
    enumerate([42, 43]);
    await Promise.resolve();
    expect(events).toEqual(['close-console', 'dispose', 'kill:42', 'kill:43']);
    events.length = 0;
    const naturallyExited = { ...agent, _zerogKillPending: false, _exitCode: 0,
      _getConsoleProcessList: () => { throw new Error('must not enumerate a dead console'); } };
    kill.call(naturallyExited);
    kill.call(naturallyExited);
    expect(events).toEqual(['close-console', 'dispose']);
  });
  it('is idempotent and rejects an incompatible upstream implementation', () => {
    expect(patchWindowsPtyAgent(patchWindowsPtyAgent(source))).toBe(patchWindowsPtyAgent(source));
    expect(() => patchWindowsPtyAgent('changed upstream')).toThrow('no longer matches');
  });
});


it.each(['hoisted', 'nested'])('resolves a %s dependency during consumer installation', async (layout) => {
  const temporary = await mkdtemp(join(tmpdir(), 'zerog-pty-install-'));
  try {
    const app = join(temporary, 'node_modules', 'zerogterm');
    const dependency = layout === 'hoisted' ? join(temporary, 'node_modules', 'node-pty') : join(app, 'node_modules', 'node-pty');
    await mkdir(join(app, 'scripts'), { recursive: true });
    await mkdir(join(dependency, 'lib'), { recursive: true });
    await copyFile('scripts/patch-node-pty.mjs', join(app, 'scripts', 'patch-node-pty.mjs'));
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }));
    await copyFile('node_modules/node-pty/lib/windowsPtyAgent.js', join(dependency, 'lib', 'windowsPtyAgent.js'));
    await expect(promisify(execFile)(process.execPath, [join(app, 'scripts', 'patch-node-pty.mjs')])).resolves.toMatchObject({ stderr: '' });
  } finally {
    if (dirname(temporary) === tmpdir() && basename(temporary).startsWith('zerog-pty-install-')) await rm(temporary, { recursive: true, force: true });
  }
});
