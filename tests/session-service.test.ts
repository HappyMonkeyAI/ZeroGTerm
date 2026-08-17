import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createFakePty } from './helpers/fake-pty';
import { ScreenService, parseScreenList, parseWslDistributions, validateSessionName, validateSshTarget } from '../src/main/session-service';

const execFileAsync = promisify(execFile);

describe('screen session contract', () => {
  it('validates safe names', () => {
    expect(validateSessionName('project-1')).toBe('project-1');
    expect(() => validateSessionName('bad name')).toThrow();
    expect(() => validateSessionName('a;rm -rf /')).toThrow();
  });

  it('parses screen -ls output without shell interpolation', () => {
    const sessions = parseScreenList('There are screens on:\n\t1234.project-1\t(Detached)\n\t4567.other\t(Attached)\n2 Sockets in /run/screen/S-user.');
    expect(sessions.map(({ id, name }) => ({ id, name }))).toEqual([{ id: 'local:project-1', name: 'project-1' }, { id: 'local:other', name: 'other' }]);
  });

  it('parses the WSL distribution list', () => {
    expect(parseWslDistributions('NAME\nUbuntu\n* Debian\n')).toEqual(['Ubuntu', 'Debian']);
  });

  it('builds SSH arguments without shell interpolation', () => {
    expect(validateSshTarget('dev@example.com:2222')).toEqual({ target: 'dev@example.com:2222', args: ['-tt', '-p', '2222', '--', 'dev@example.com'] });
    expect(() => validateSshTarget('dev@example.com; touch /tmp/pwned')).toThrow();
  });

  it('rejects SSH targets that ssh would parse as options', () => {
    // `ssh -F<file>` reads an attacker-chosen config, which can set ProxyCommand.
    expect(() => validateSshTarget('-Fevil.cfg')).toThrow();
    expect(() => validateSshTarget('-oProxyCommand')).toThrow();
    expect(() => validateSshTarget('-4')).toThrow();
    expect(() => validateSshTarget('-bad@example.com')).toThrow();
    // The destination is also fenced off from option parsing.
    expect(validateSshTarget('example.com').args).toEqual(['-tt', '--', 'example.com']);
  });

  it('revalidates session ids arriving from the renderer', () => {
    const service = new ScreenService();
    const attachBadId = (id: string) => () => service.attach(id, () => undefined, () => undefined);
    expect(attachBadId('local:-Fevil.cfg')).toThrow();
    expect(attachBadId('local:-X')).toThrow();
    expect(attachBadId('local:a;rm -rf /')).toThrow();
  });

  it('routes input and output independently for two attached sessions', async () => {
    // SSH sessions rather than local ones: createLocal shells out to `screen`
    // where it is installed, which would put a real process back in the test.
    const pty = createFakePty();
    const service = new ScreenService({ spawnPty: pty.spawn });
    const first = await service.createSsh('first.example.com', 'first-routing');
    const second = await service.createSsh('second.example.com', 'second-routing');
    let firstOutput = '';
    let secondOutput = '';

    service.attach(first.id, (data) => { firstOutput += data; }, () => undefined);
    service.attach(second.id, (data) => { secondOutput += data; }, () => undefined);
    service.write(first.id, 'FIRST_INPUT');
    service.write(second.id, 'SECOND_INPUT');
    pty.spawned[0].emit('FIRST_SESSION_OK');
    pty.spawned[1].emit('SECOND_SESSION_OK');
    service.detachAll();

    expect(firstOutput).toBe('FIRST_SESSION_OK');
    expect(secondOutput).toBe('SECOND_SESSION_OK');
    expect(pty.spawned[0].writes).toEqual(['FIRST_INPUT']);
    expect(pty.spawned[1].writes).toEqual(['SECOND_INPUT']);
    expect(pty.spawned.map((item) => item.killed)).toEqual([true, true]);
  });

  it('starts the shell at the size of the pane that asked for it', async () => {
    // A pty spawned at a stock size draws its first frame for a terminal of the
    // wrong width, and a full-screen program redrawing over that frame leaves
    // pieces of it on screen.
    const pty = createFakePty();
    const service = new ScreenService({ spawnPty: pty.spawn });
    const session = await service.createSsh('sized.example.com', 'sized');

    service.attach(session.id, () => undefined, () => undefined, { cols: 203, rows: 67 });

    expect(pty.spawned[0].size).toEqual({ cols: 203, rows: 67 });
    expect(pty.spawned[0].resizes).toEqual([]);
  });

  it('ignores a size the pane could not measure', async () => {
    const pty = createFakePty();
    const service = new ScreenService({ spawnPty: pty.spawn });
    const session = await service.createSsh('unmeasured.example.com', 'unmeasured');

    service.attach(session.id, () => undefined, () => undefined, { cols: 0, rows: 0 });

    expect(pty.spawned[0].size).toEqual({ cols: 120, rows: 32 });
  });

  it('resizes an already attached session to the re-attaching pane', async () => {
    const pty = createFakePty();
    const service = new ScreenService({ spawnPty: pty.spawn });
    const session = await service.createSsh('reattach.example.com', 'reattach');
    service.attach(session.id, () => undefined, () => undefined, { cols: 100, rows: 40 });

    service.attach(session.id, () => undefined, () => undefined, { cols: 160, rows: 50 });

    expect(pty.spawned).toHaveLength(1);
    expect(pty.spawned[0].resizes).toEqual([{ cols: 160, rows: 50 }]);
  });

  it('drops a resize to the size the pty already has', async () => {
    // Panes refit on layout, font and status changes, and mostly arrive at the
    // size the pty already has. Forwarding it anyway makes ConPTY re-emit its
    // screen and every full-screen program redraw on SIGWINCH for nothing.
    const pty = createFakePty();
    const service = new ScreenService({ spawnPty: pty.spawn });
    const session = await service.createSsh('refit.example.com', 'refit');
    service.attach(session.id, () => undefined, () => undefined, { cols: 120, rows: 40 });

    service.resize(session.id, 120, 40);
    service.resize(session.id, 120, 41);
    service.resize(session.id, 120, 41);
    service.resize(session.id, 0, 41);

    expect(pty.spawned[0].resizes).toEqual([{ cols: 120, rows: 41 }]);
  });

  it('close removes transient SSH bookkeeping so the session no longer lists', async () => {
    const service = new ScreenService();
    const session = await service.createSsh('example.com', `close-ssh-${Date.now()}`);
    expect((await service.list()).some((item) => item.id === session.id)).toBe(true);

    service.close(session.id);
    expect((await service.list()).some((item) => item.id === session.id)).toBe(false);
  });

  it('close kills the pane PTY and drops transient bookkeeping', async () => {
    const pty = createFakePty();
    const service = new ScreenService({ spawnPty: pty.spawn });
    const session = await service.createSsh('close.example.com', 'close-pane');
    let exited = false;
    service.attach(session.id, () => undefined, () => { exited = true; });

    service.close(session.id);

    // The fake exits synchronously, so no polling: closing must kill the pty,
    // surface the exit to the pane, and forget the session.
    expect(pty.spawned[0].killed).toBe(true);
    expect(exited).toBe(true);
    expect((await service.list()).some((item) => item.id === session.id)).toBe(false);
  });

  // Covers the screen-backed half of close(): the pane detaches but the screen
  // session survives. Needs a real `screen`, so it is opt-in rather than a
  // source of environment-dependent CI failures.
  it.runIf(process.env.ZEROG_LIVE_SCREEN === '1')('close leaves a screen-backed session alive', async () => {
    const service = new ScreenService();
    const name = `close-${Date.now()}`;
    const session = await service.createLocal(name);
    expect(session.persistence).toBe('screen');
    service.attach(session.id, () => undefined, () => undefined);

    service.close(session.id);
    expect((await service.list()).some((item) => item.id === session.id)).toBe(true);
    await execFileAsync('screen', ['-S', name, '-X', 'quit']);
  }, 30000);
});
