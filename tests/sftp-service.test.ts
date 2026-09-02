import { describe, expect, it, vi } from 'vitest';
import { createFakePty, type FakePty } from './helpers/fake-pty';
import { SftpService } from '../src/main/sftp-service';
import type { SftpEvent } from '../src/shared/types';

/** Let every pending microtask run, so the service has read what was emitted. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const PROMPT = 'sftp> ';

function harness() {
  const { spawn, spawned } = createFakePty();
  const events: SftpEvent[] = [];
  const service = new SftpService({ spawnPty: spawn, onEvent: (event) => events.push(event) });
  return { service, spawned, events };
}

/** The client's echo of a command, its output, and the next prompt. */
function reply(pty: FakePty, output = '') {
  const command = pty.writes[pty.writes.length - 1] ?? '';
  pty.emit(`${command.replace(/\n$/, '')}\r\n${output ? `${output}\r\n` : ''}${PROMPT}`);
}

/** Connect, answering the login handshake, and hand back the ready connection. */
async function connect(target = 'dev@example.com', cwd?: string) {
  const { service, spawned, events } = harness();
  const opening = service.open(target, cwd);
  const pty = spawned[0];
  pty.emit(`Connected to example.com.\r\n${PROMPT}`);
  await settle();
  // Opening always asks where it landed first, so a relative path is never
  // guessed at; a requested directory is then a cd and a second pwd.
  reply(pty, 'Remote working directory: /home/dev');
  await settle();
  if (cwd) {
    reply(pty);
    await settle();
    reply(pty, `Remote working directory: ${cwd}`);
  }
  const connection = await opening;
  return { service, pty, events, connection };
}

describe('SFTP connections', () => {
  it('starts the system client with a vetted destination', async () => {
    const { pty, connection } = await connect('dev@example.com:2222');
    // Resolved to a real path, because a pty cannot start a bare command name
    // on Windows.
    expect(pty.file).toMatch(/sftp(\.[A-Za-z]+)?$/);
    expect(pty.args).toEqual(['-o', 'ConnectTimeout=20', '-P', '2222', 'dev@example.com']);
    // Wide enough that a long listing row is never wrapped into two lines.
    expect(pty.size.cols).toBeGreaterThanOrEqual(256);
    expect(connection.cwd).toBe('/home/dev');
  });

  it('opens at the directory the terminal was working in', async () => {
    const { pty, connection } = await connect('dev@example.com', '/srv/app/releases');
    expect(pty.writes).toContain('cd "/srv/app/releases"\n');
    expect(connection.cwd).toBe('/srv/app/releases');
  });

  it('keeps a panel that reopens on the same connection, without authenticating again', async () => {
    const { service, connection } = await connect();
    const again = await service.open('dev@example.com');
    expect(again.id).toBe(connection.id);
  });

  it('lists a directory without putting a filename through the glob expander', async () => {
    const { service, pty, connection } = await connect();
    const listing = service.list(connection.id);
    await settle();
    reply(pty, 'Remote working directory: /home/dev');
    await settle();
    expect(pty.writes[pty.writes.length - 1]).toBe('ls -lan\n');
    reply(pty, [
      'drwxr-xr-x    2 1000     1000         4096 Aug 18 09:12 build',
      '-rw-r--r--    1 1000     1000         1234 Aug 18 12:34 notes.md'
    ].join('\r\n'));
    const result = await listing;
    expect(result.path).toBe('/home/dev');
    // Directories first: the order a person scans a file list in.
    expect(result.entries.map((entry) => entry.name)).toEqual(['build', 'notes.md']);
  });

  it('uploads with both paths quoted, and reports progress while it runs', async () => {
    const { service, pty, events, connection } = await connect();
    const upload = service.upload(connection.id, 'C:\\Users\\dev\\app.tar.gz', '/srv/app');
    await settle();
    expect(pty.writes[pty.writes.length - 1]).toBe('put -p "C:/Users/dev/app.tar.gz" "/srv/app/app.tar.gz"\n');
    pty.emit('app.tar.gz                                    40%   80MB   9.7MB/s   00:12 ETA\r');
    await settle();
    expect(events.filter((event) => event.type === 'progress')).toHaveLength(1);
    reply(pty);
    await expect(upload).resolves.toBeUndefined();
  });

  it('downloads into the local folder that is on screen', async () => {
    const { service, pty, connection } = await connect();
    const download = service.download(connection.id, '/srv/app/notes.md', 'C:\\Users\\dev\\project', 'file');
    await settle();
    expect(pty.writes[pty.writes.length - 1]).toBe('get -p "/srv/app/notes.md" "C:/Users/dev/project/notes.md"\n');
    reply(pty);
    await expect(download).resolves.toBeUndefined();
  });

  it('downloads a remote folder recursively into the local folder', async () => {
    const { service, pty, connection } = await connect();
    const download = service.download(connection.id, '/srv/app/build', 'C:\\Users\\dev\\project', 'directory');
    await settle();
    expect(pty.writes[pty.writes.length - 1]).toBe('get -r -p "/srv/app/build" "C:/Users/dev/project/build"\n');
    reply(pty);
    await expect(download).resolves.toBeUndefined();
  });

  it('deletes a folder with rmdir, so a non-empty one fails instead of emptying', async () => {
    const { service, pty, connection } = await connect();
    const removal = service.remove(connection.id, '/srv/app/build', 'directory');
    await settle();
    expect(pty.writes[pty.writes.length - 1]).toBe('rmdir "/srv/app/build"\n');
    reply(pty);
    await removal;

    const file = service.remove(connection.id, '/srv/app/notes.md', 'file');
    await settle();
    expect(pty.writes[pty.writes.length - 1]).toBe('rm "/srv/app/notes.md"\n');
    reply(pty);
    await file;
  });

  it('accepts a bare prompt as the answer to a command that succeeded quietly', async () => {
    // How the real client actually answers `cd` and `mkdir`: no output, and on
    // Windows no echo of the command either, because ConPTY does not echo pty
    // input. Anything stricter than this hangs every silent command.
    const { service, pty, connection } = await connect();
    const mkdir = service.mkdir(connection.id, '/srv/app/new');
    await settle();
    pty.emit(PROMPT);
    await expect(mkdir).resolves.toBeUndefined();
  });

  it('drops output that arrives when nothing is waiting for it', async () => {
    // A repainted prompt left lying in the buffer would satisfy the next command
    // the moment it was issued, and every answer after that would be read as the
    // answer to the command before it.
    const { service, pty, connection } = await connect();
    pty.emit(`stray repaint\r\n${PROMPT}`);
    const listing = service.list(connection.id);
    await settle();
    expect(pty.writes[pty.writes.length - 1]).toBe('pwd\n');
    reply(pty, 'Remote working directory: /srv/app');
    await settle();
    reply(pty, '-rw-r--r--    1 1000     1000            5 Aug 18 12:34 notes.md');
    await expect(listing).resolves.toMatchObject({ path: '/srv/app' });
  });

  it('refuses a name the client would re-read, rather than acting on the wrong file', async () => {
    const { service, connection } = await connect();
    await expect(service.remove(connection.id, '/srv/app/*', 'file')).rejects.toThrow(/wildcard/);
  });

  it('turns what the server printed into the error the user sees', async () => {
    const { service, pty, connection } = await connect();
    const mkdir = service.mkdir(connection.id, '/srv/locked/new');
    await settle();
    reply(pty, "Couldn't create directory: Permission denied");
    await expect(mkdir).rejects.toThrow(/Permission denied/);
  });

  it('carries on after a failed command instead of wedging the connection', async () => {
    const { service, pty, connection } = await connect();
    const failing = service.mkdir(connection.id, '/srv/locked/new');
    await settle();
    reply(pty, "Couldn't create directory: Permission denied");
    await expect(failing).rejects.toThrow();

    const second = service.mkdir(connection.id, '/srv/app/new');
    await settle();
    expect(pty.writes[pty.writes.length - 1]).toBe('mkdir "/srv/app/new"\n');
    reply(pty);
    await expect(second).resolves.toBeUndefined();
  });
});

describe('what ends a line', () => {
  /**
   * A client whose interactive editor accepts only on carriage return, which is
   * what a real connection does — and it echoes, which is how that shows.
   * Reported from a live Ubuntu host: the panel sent a newline, saw its own
   * command echoed back, and waited for an answer that could never come.
   */
  function carriageReturnOnly(pty: FakePty) {
    let handled = 0;
    return () => {
      while (handled < pty.writes.length) {
        const written = pty.writes[handled];
        handled += 1;
        // The editor echoes whatever was typed, submitted or not.
        pty.emit(written.replace(/[\r\n]/g, ''));
        if (!written.endsWith('\r')) continue;
        const command = written.trim();
        pty.emit(`\r\n${command === 'pwd' ? 'Remote working directory: /home/dev\r\n' : ''}${PROMPT}`);
      }
    };
  }

  it('finds the terminator the client accepts, rather than assuming one', async () => {
    vi.useFakeTimers();
    try {
      const { service, spawned } = harness();
      const opening = service.open('dev@example.com');
      const pty = spawned[0];
      const pump = carriageReturnOnly(pty);
      pty.emit(`Connected to example.com.\r\n${PROMPT}`);
      await vi.advanceTimersByTimeAsync(0);
      // The newline attempt is echoed and then ignored, so the probe waits it out
      // and tries the other terminator.
      pump();
      await vi.advanceTimersByTimeAsync(6_000);
      pump();
      await vi.advanceTimersByTimeAsync(0);
      const connection = await opening;
      expect(connection.cwd).toBe('/home/dev');
      // Everything afterwards uses what was found to work.
      expect(pty.writes.some((written) => written === 'pwd\r')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers when the alternate terminator first flushes a buffered command', async () => {
    vi.useFakeTimers();
    try {
      const { service, spawned } = harness();
      const opening = service.open('dev@example.com');
      const pty = spawned[0];
      let handled = 0;
      let carriageReturns = 0;
      pty.emit(`Connected to example.com.${String.fromCharCode(13)}${String.fromCharCode(10)}${PROMPT}`);
      await vi.advanceTimersByTimeAsync(0);
      const pump = () => {
        while (handled < pty.writes.length) {
          const written = pty.writes[handled++];
          pty.emit(written.split(String.fromCharCode(13)).join('').split(String.fromCharCode(10)).join(''));
          if (!written.endsWith(String.fromCharCode(13))) continue;
          carriageReturns += 1;
          const response = carriageReturns === 1
            ? `Invalid command.${String.fromCharCode(13)}${String.fromCharCode(10)}`
            : `Remote working directory: /home/dev${String.fromCharCode(13)}${String.fromCharCode(10)}`;
          pty.emit(`${response}${PROMPT}`);
        }
      };
      // The first two LF attempts are echoed but not submitted. The first CR
      // flushes that buffered input and is rejected; the second CR is clean.
      for (let attempt = 0; attempt < 6 && carriageReturns < 2; attempt += 1) {
        await vi.advanceTimersByTimeAsync(5_000);
        pump();
        await vi.advanceTimersByTimeAsync(0);
        pump();
      }
      const connection = await opening;
      expect(connection.cwd).toBe('/home/dev');
      expect(pty.writes.filter((written) => written === `pwd${String.fromCharCode(13)}`)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up with a message naming the problem when neither works', async () => {
    vi.useFakeTimers();
    try {
      const { service, spawned } = harness();
      const opening = service.open('dev@example.com').catch((error: Error) => error);
      spawned[0].emit(`Connected to example.com.\r\n${PROMPT}`);
      // Every command is echoed and none is ever answered.
      await vi.advanceTimersByTimeAsync(30_000);
      const failure = await opening;
      expect(failure.message).toMatch(/accepted neither line ending/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('when nothing comes back', () => {
  // The rejection is caught as it is created rather than asserted on afterwards:
  // advancing the timers is what rejects, so a handler attached after that has
  // already missed it, and the run reports an unhandled rejection.
  it('says the client produced no output, rather than blaming the host', async () => {
    vi.useFakeTimers();
    try {
      const { service, spawned } = harness();
      const opening = service.open('dev@example.com').catch((error: Error) => error);
      expect(spawned).toHaveLength(1);
      // Nothing is ever emitted: the client started and said nothing at all.
      await vi.advanceTimersByTimeAsync(40_000);
      const failure = await opening;
      expect(failure.message).toMatch(/produced no output/);
      // And it points somewhere useful rather than leaving the user guessing.
      expect(failure.message).toMatch(/sftp-doctor/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('quotes what the client last said, so an unrecognised question is visible', async () => {
    vi.useFakeTimers();
    try {
      const { service, spawned } = harness();
      const opening = service.open('dev@example.com').catch((error: Error) => error);
      // A two-factor prompt whose wording ZeroG does not recognise: the panel
      // cannot ask for it, so the error has to carry it instead.
      spawned[0].emit('Duo two-factor login for dev\r\n\r\nPasscode or option (1-3): ');
      await vi.advanceTimersByTimeAsync(130_000);
      const failure = await opening;
      expect(failure.message).toMatch(/Passcode or option \(1-3\)/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what only a pty makes possible', () => {
  it('asks the user for a password rather than failing the connection', async () => {
    const { service, spawned, events } = harness();
    const opening = service.open('dev@example.com');
    const pty = spawned[0];
    pty.emit("dev@example.com's password: ");
    await settle();
    const question = events.find((event) => event.type === 'prompt');
    expect(question).toMatchObject({ type: 'prompt', prompt: { kind: 'password' } });

    service.answerPrompt(question?.type === 'prompt' ? question.prompt.sessionId : '', 'hunter2');
    expect(pty.writes).toContain('hunter2\n');
    pty.emit(`\r\nConnected to example.com.\r\n${PROMPT}`);
    await settle();
    reply(pty, 'Remote working directory: /home/dev');
    await expect(opening).resolves.toMatchObject({ cwd: '/home/dev' });
  });

  it('asks again when the password was wrong', async () => {
    const { service, spawned, events } = harness();
    void service.open('dev@example.com').catch(() => undefined);
    const pty = spawned[0];
    pty.emit("dev@example.com's password: ");
    await settle();
    const first = events.find((event) => event.type === 'prompt');
    const id = first?.type === 'prompt' ? first.prompt.sessionId : '';
    service.answerPrompt(id, 'wrong');
    pty.emit('\r\nPermission denied, please try again.\r\n');
    pty.emit("dev@example.com's password: ");
    await settle();
    // The same prompt text must not be swallowed as a repeat of the first ask.
    expect(events.filter((event) => event.type === 'prompt')).toHaveLength(2);
  });

  it('hands an unknown host key to the user, fingerprint and all', async () => {
    const { service, spawned, events } = harness();
    void service.open('dev@example.com').catch(() => undefined);
    spawned[0].emit([
      "The authenticity of host 'example.com (203.0.113.7)' can't be established.",
      'ED25519 key fingerprint is SHA256:abc123.',
      'Are you sure you want to continue connecting (yes/no/[fingerprint])? '
    ].join('\r\n'));
    await settle();
    const question = events.find((event) => event.type === 'prompt');
    expect(question).toMatchObject({ type: 'prompt', prompt: { kind: 'confirm' } });
    expect(question?.type === 'prompt' ? question.prompt.text : '').toContain('SHA256:abc123');
  });

  it('fails the open when the host cannot be reached', async () => {
    const { service, spawned } = harness();
    const opening = service.open('dev@example.com');
    spawned[0].emit('ssh: connect to host example.com port 22: Connection refused\r\n');
    await expect(opening).rejects.toThrow(/Connection refused/);
  });

  it('says goodbye before killing the client, so a half-written upload is flushed', async () => {
    const { service, pty, connection } = await connect();
    service.close(connection.id);
    expect(pty.writes[pty.writes.length - 1]).toBe('bye\n');
  });
});

describe('the connection handle', () => {
  it('refuses a terminal session id, which is not a connection handle', async () => {
    // The exact failure a user hit with the pane directory browser against a
    // Linux host: "Error invoking remote method 'sftp:list': Error: This
    // transfer connection is closed. Reopen the transfer panel." The browser
    // passed the terminal session's id, and only the id that `open` returns
    // names a connection — the two are different namespaces, which is why the
    // service reports the one it does not know as closed.
    const { service } = harness();
    await expect(service.list('ssh:1')).rejects.toThrow('This transfer connection is closed');
  });

  it('still refuses it while a connection to that host is open', async () => {
    // The confusion is not rescued by there being a connection: the handle is a
    // separate namespace, so a live connection to the very same host does not
    // make the terminal's id mean anything.
    const { service, connection } = await connect();
    expect(connection.id).not.toBe('ssh:1');
    await expect(service.list('ssh:1')).rejects.toThrow('This transfer connection is closed');
    service.closeAll();
  });
});
