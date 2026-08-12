import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ScreenService, discoverShellBackends, parseScreenList, parseWslDistributions, shellBackendArgs, validateSessionName, validateSshTarget } from '../src/main/session-service';

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

  it('parses WSL distributions and rejects unsafe argv values', () => {
    expect(parseWslDistributions('NAME\nUbuntu\n* Debian\n')).toEqual(['Ubuntu', 'Debian']);
    expect(shellBackendArgs('wsl', 'Ubuntu').args).toEqual(['-d', 'Ubuntu']);
    expect(() => shellBackendArgs('wsl', 'Ubuntu; rm -rf /')).toThrow();
  });

  it('discovers only installed optional shell backends', async () => {
    const backends = await discoverShellBackends();
    expect(backends.some((item) => item.backend === 'bash')).toBe(true);
  });
  it('builds SSH arguments without shell interpolation', () => {
    expect(validateSshTarget('dev@example.com:2222')).toEqual({ target: 'dev@example.com:2222', args: ['-tt', '-p', '2222', 'dev@example.com'] });
    expect(() => validateSshTarget('dev@example.com; touch /tmp/pwned')).toThrow();
  });

  it('routes input and output independently for two attached sessions', async () => {
    const service = new ScreenService();
    const first = await service.createLocal(`first-${Date.now()}`);
    const second = await service.createLocal(`second-${Date.now()}`);
    let firstOutput = '';
    let secondOutput = '';

    service.attach(first.id, (data) => { firstOutput += data; }, () => undefined);
    service.attach(second.id, (data) => { secondOutput += data; }, () => undefined);
    service.write(first.id, "printf 'FIRST_SESSION_OK\\n'\r");
    service.write(second.id, "printf 'SECOND_SESSION_OK\\n'\r");

    const deadline = Date.now() + 3000;
    while ((!firstOutput.includes('FIRST_SESSION_OK') || !secondOutput.includes('SECOND_SESSION_OK')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    service.detachAll();

    expect(firstOutput).toContain('FIRST_SESSION_OK');
    expect(firstOutput).not.toContain('SECOND_SESSION_OK');
    expect(secondOutput).toContain('SECOND_SESSION_OK');
    expect(secondOutput).not.toContain('FIRST_SESSION_OK');
  }, 5000);

  it('close removes transient SSH bookkeeping so the session no longer lists', async () => {
    const service = new ScreenService();
    const session = await service.createSsh('example.com', `close-ssh-${Date.now()}`);
    expect((await service.list()).some((item) => item.id === session.id)).toBe(true);

    service.close(session.id);
    expect((await service.list()).some((item) => item.id === session.id)).toBe(false);
  });

  it('close detaches the pane PTY without killing a screen-backed session', async () => {
    const service = new ScreenService();
    const name = `close-${Date.now()}`;
    const session = await service.createLocal(name);
    let exited = false;
    service.attach(session.id, () => undefined, () => { exited = true; });

    service.close(session.id);
    const deadline = Date.now() + 3000;
    while (!exited && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(exited).toBe(true);

    const stillListed = (await service.list()).some((item) => item.id === session.id);
    if (session.persistence === 'screen') {
      expect(stillListed).toBe(true);
      await execFileAsync('screen', ['-S', name, '-X', 'quit']);
    } else {
      expect(stillListed).toBe(false);
    }
  }, 5000);
});
