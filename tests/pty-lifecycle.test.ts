import { describe, expect, it } from 'vitest';
import { PtyLifecycle } from '../src/main/pty-lifecycle';
import type { SpawnPty } from '../src/main/session-service';
import { createFakePty } from './helpers/fake-pty';

describe('PTY shutdown', () => {
  it('waits for native exit after kill returns, including processes already closing', async () => {
    let exit: () => void = () => undefined;
    let kills = 0;
    const spawn: SpawnPty = () => ({ write() {}, resize() {}, kill() { kills++; }, onData() {}, onExit(listener) { exit = listener; } });
    const lifecycle = new PtyLifecycle(spawn);
    const process = lifecycle.start('shell', [], { name: 'xterm', cols: 80, rows: 24, cwd: '.', env: {} });
    process.kill();
    let finished = false;
    const shutdown = lifecycle.shutdown().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    exit();
    await shutdown;
    expect(finished).toBe(true);
    expect(kills).toBe(2);
  });
  it('does not kill processes that exited naturally', async () => {
    const fake = createFakePty();
    const lifecycle = new PtyLifecycle(fake.spawn);
    lifecycle.start('shell', [], { name: 'xterm', cols: 80, rows: 24, cwd: '.', env: {} });
    fake.spawned[0].exit();
    await lifecycle.shutdown();
    expect(fake.spawned[0].killed).toBe(false);
    expect(() => lifecycle.start('shell', [], { name: 'xterm', cols: 80, rows: 24, cwd: '.', env: {} })).toThrow('shutting down');
  });
  it('bounds shutdown when a native process never reports exit', async () => {
    const lifecycle = new PtyLifecycle(() => ({ write() {}, resize() {}, kill() {}, onData() {}, onExit() {} }));
    lifecycle.start('shell', [], { name: 'xterm', cols: 80, rows: 24, cwd: '.', env: {} });
    await expect(lifecycle.shutdown(10)).rejects.toThrow('PTY shutdown timed out');
  });
});
