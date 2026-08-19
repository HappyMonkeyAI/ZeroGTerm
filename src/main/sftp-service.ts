// The stateful half of SFTP support: one live `sftp` client per remote host,
// with commands serialised onto it and its answers turned into data by
// sftp-protocol.ts.
//
// The client runs on a pty rather than on pipes. That is not incidental: with
// pipes, OpenSSH cannot ask for a key passphrase, a password, or a decision
// about an unknown host key — it either finds an agent identity or fails — and
// it prints no transfer progress. On a pty all three become possible, at the
// cost of having to read output written for a person.

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { DirectoryListing, FileEntry, SftpEvent, SftpSessionInfo } from '../shared/types.js';
import { baseName, joinRemote, sortEntries } from '../shared/files.js';
import { createRequire } from 'node:module';
import type { PtyProcess, SpawnPty } from './session-service.js';
import {
  buildSftpArgs,
  detectFatal,
  detectPrompt,
  endsWithPrompt,
  findError,
  isSafeRemotePath,
  parseListing,
  parseProgress,
  parsePwd,
  quoteLocalPath,
  quoteRemotePath,
  responseBody
} from './sftp-protocol.js';

const require = createRequire(import.meta.url);

/**
 * Wide enough that a long `ls -l` record is never wrapped by the pty, which
 * would split one file's row across two lines and lose its name. Rows are
 * nominal: nothing here is drawn.
 */
const PTY_COLS = 512;
const PTY_ROWS = 24;

/** How long the client may go silent before a command is given up on. */
const IDLE_MS = 25_000;
/**
 * The same limit for transfers, which are silent only if they have stalled:
 * the progress meter reprints about once a second while bytes are moving, and
 * every frame of it resets the clock.
 */
const TRANSFER_IDLE_MS = 60_000;
/** Opening waits longer, because it may be waiting on a person to type. */
const OPEN_IDLE_MS = 120_000;

/** A ceiling on live connections, so a stuck panel cannot spawn clients forever. */
const MAX_SESSIONS = 6;

type Waiter = {
  resolve: (body: string) => void;
  reject: (error: Error) => void;
  idleMs: number;
  timer: ReturnType<typeof setTimeout>;
  command: string;
  /** Set while a transfer is running, so meter frames become progress events. */
  reportProgress: boolean;
};

type Connection = {
  id: string;
  target: string;
  cwd: string;
  pty: PtyProcess;
  buffer: string;
  waiter: Waiter | null;
  /** Commands run one at a time: there is a single pty and a single prompt. */
  queue: Promise<unknown>;
  closed: boolean;
};

export class SftpService {
  private connections = new Map<string, Connection>();
  private readonly spawnPty: SpawnPty;
  private readonly onEvent: (event: SftpEvent) => void;

  constructor(options: { spawnPty?: SpawnPty; onEvent?: (event: SftpEvent) => void } = {}) {
    this.spawnPty = options.spawnPty ?? ((file, args, ptyOptions) => require('node-pty').spawn(file, args, ptyOptions));
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  /**
   * Connect to a host and settle on a starting directory.
   *
   * Resolves only once the client is ready for commands, which may be after the
   * user has answered a password or host-key question — those arrive as events
   * while this promise is still pending, and are answered with answerPrompt().
   */
  async open(target: string, cwd?: string): Promise<SftpSessionInfo> {
    // A connection to this host is worth reusing: authenticating again — with a
    // password or a key passphrase — is a real cost to pay for closing a panel
    // and reopening it. Connections are dropped when the window closes.
    const reusable = this.connections.get(this.findByTarget(target)?.id ?? '');
    if (reusable) {
      if (cwd && cwd !== '~' && isSafeRemotePath(cwd) && cwd !== reusable.cwd) {
        try {
          reusable.cwd = await this.enqueue(reusable, () => this.changeDirectory(reusable, cwd));
        } catch {
          this.onEvent({ type: 'status', sessionId: reusable.id, message: `${cwd} is not reachable; staying in ${reusable.cwd}.` });
        }
      }
      return { id: reusable.id, target: reusable.target, cwd: reusable.cwd };
    }
    if (this.connections.size >= MAX_SESSIONS) {
      throw new Error('Too many open transfer connections. Close one and try again.');
    }
    const { file, args } = buildSftpArgs(target);
    const id = `sftp:${randomUUID()}`;
    const pty = this.spawnPty(file, args, {
      name: 'xterm-256color',
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: homedir(),
      env: process.env
    });
    const connection: Connection = { id, target, cwd: '.', pty, buffer: '', waiter: null, queue: Promise.resolve(), closed: false };
    this.connections.set(id, connection);
    pty.onData((data) => this.receive(connection, data));
    pty.onExit(() => this.handleExit(connection));

    try {
      await this.waitForPrompt(connection, '', OPEN_IDLE_MS);
      // Ask the server where "here" is before trusting any relative path: the
      // panel shows this path, and the login directory is not always the home
      // directory the local side would guess.
      const home = await this.pwd(connection);
      connection.cwd = home;
      if (cwd && cwd !== '~' && isSafeRemotePath(cwd)) {
        try {
          connection.cwd = await this.changeDirectory(connection, cwd);
        } catch (error) {
          // A stale or unreadable terminal cwd must not cost the user the whole
          // panel — start at the login directory and say why.
          this.onEvent({ type: 'status', sessionId: id, message: `${cwd} is not reachable; starting in ${home}.` });
        }
      }
      return { id, target, cwd: connection.cwd };
    } catch (error) {
      this.destroy(connection);
      throw error;
    }
  }

  async list(sessionId: string, path?: string): Promise<DirectoryListing> {
    const connection = this.get(sessionId);
    return this.enqueue(connection, async () => {
      if (path) connection.cwd = await this.changeDirectory(connection, path);
      else connection.cwd = await this.pwd(connection);
      // `ls` with no path argument lists the working directory, which keeps
      // every filename out of the glob expander. -a includes dotfiles, -n keeps
      // owner columns numeric so a long user name cannot merge two columns.
      const body = await this.command(connection, 'ls -lan', IDLE_MS);
      const failure = findError(body);
      if (failure) throw new Error(failure);
      return { path: connection.cwd, entries: sortEntries(parseListing(body)) };
    });
  }

  async mkdir(sessionId: string, path: string): Promise<void> {
    const connection = this.get(sessionId);
    await this.enqueue(connection, () => this.checked(connection, `mkdir ${quoteRemotePath(path)}`, IDLE_MS));
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const connection = this.get(sessionId);
    await this.enqueue(connection, () => this.checked(connection, `rename ${quoteRemotePath(from)} ${quoteRemotePath(to)}`, IDLE_MS));
  }

  /**
   * Delete one entry. Directories use `rmdir`, which fails on a non-empty one —
   * a recursive remote delete is not something this panel should be able to do
   * by accident, and the terminal is one keystroke away for the rest.
   */
  async remove(sessionId: string, path: string, kind: FileEntry['kind']): Promise<void> {
    const connection = this.get(sessionId);
    const command = kind === 'directory' ? `rmdir ${quoteRemotePath(path)}` : `rm ${quoteRemotePath(path)}`;
    await this.enqueue(connection, () => this.checked(connection, command, IDLE_MS));
  }

  async upload(sessionId: string, localPath: string, remoteDir: string): Promise<void> {
    const connection = this.get(sessionId);
    const name = baseName(localPath);
    const destination = joinRemote(remoteDir, name);
    // -p keeps the modification time, so an uploaded file does not look newer
    // than the build that produced it.
    const command = `put -p ${quoteLocalPath(localPath)} ${quoteRemotePath(destination)}`;
    await this.enqueue(connection, () => this.checked(connection, command, TRANSFER_IDLE_MS, true));
  }

  async download(sessionId: string, remotePath: string, localDir: string): Promise<void> {
    const connection = this.get(sessionId);
    const name = baseName(remotePath);
    const destination = `${localDir.replace(/[\\/]+$/, '')}/${name}`;
    const command = `get -p ${quoteRemotePath(remotePath)} ${quoteLocalPath(destination)}`;
    await this.enqueue(connection, () => this.checked(connection, command, TRANSFER_IDLE_MS, true));
  }

  /**
   * Send an answer to a pending password, passphrase, or host-key question.
   *
   * Written straight to the pty and never stored, logged, or echoed back to the
   * renderer. The pending command's own promise is what resolves afterwards.
   */
  answerPrompt(sessionId: string, answer: string): void {
    const connection = this.get(sessionId);
    if (/[\r\n]/.test(answer)) throw new Error('An answer must be a single line.');
    // Forget which question was asked: a rejected password is followed by the
    // very same prompt text, and the user has to be given the field again.
    lastQuestion.delete(sessionId);
    connection.pty.write(`${answer}\n`);
  }

  close(sessionId: string): void {
    const connection = this.connections.get(sessionId);
    if (!connection) return;
    if (!connection.closed) {
      try {
        // Ask for a clean goodbye first: it flushes any half-written file on the
        // server rather than leaving a truncated upload behind.
        connection.pty.write('bye\n');
      } catch {
        /* the pty may already be gone */
      }
    }
    setTimeout(() => this.destroy(connection), 250);
  }

  closeAll(): void {
    for (const id of [...this.connections.keys()]) this.close(id);
  }

  /** Handles held for a target, so the panel can reuse one connection per host. */
  findByTarget(target: string): SftpSessionInfo | undefined {
    for (const connection of this.connections.values()) {
      if (connection.target === target && !connection.closed) {
        return { id: connection.id, target: connection.target, cwd: connection.cwd };
      }
    }
    return undefined;
  }

  private get(sessionId: string): Connection {
    const connection = this.connections.get(sessionId);
    if (!connection || connection.closed) throw new Error('This transfer connection is closed. Reopen the transfer panel.');
    return connection;
  }

  /** Serialise work onto one connection: there is a single pty and one prompt. */
  private enqueue<T>(connection: Connection, work: () => Promise<T>): Promise<T> {
    const result = connection.queue.then(work, work);
    // The chain must survive a rejected step, or one failed command would poison
    // every later one on the same connection.
    connection.queue = result.catch(() => undefined);
    return result;
  }

  private async pwd(connection: Connection): Promise<string> {
    const body = await this.command(connection, 'pwd', IDLE_MS);
    const failure = findError(body);
    if (failure) throw new Error(failure);
    const path = parsePwd(body);
    if (!path) throw new Error('The server did not report a working directory.');
    return path;
  }

  private async changeDirectory(connection: Connection, path: string): Promise<string> {
    await this.checked(connection, `cd ${quoteRemotePath(path)}`, IDLE_MS);
    return this.pwd(connection);
  }

  /** Run a command and turn anything that looks like a failure into a throw. */
  private async checked(connection: Connection, command: string, idleMs: number, reportProgress = false): Promise<void> {
    const body = await this.command(connection, command, idleMs, reportProgress);
    const failure = findError(body);
    if (failure) throw new Error(failure);
  }

  private command(connection: Connection, command: string, idleMs: number, reportProgress = false): Promise<string> {
    if (connection.closed) return Promise.reject(new Error('This transfer connection is closed.'));
    connection.buffer = '';
    const pending = this.waitForPrompt(connection, command, idleMs, reportProgress);
    connection.pty.write(`${command}\n`);
    return pending;
  }

  private waitForPrompt(connection: Connection, command: string, idleMs: number, reportProgress = false): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (connection.waiter) {
        reject(new Error('A transfer command is already running on this connection.'));
        return;
      }
      const waiter: Waiter = {
        resolve,
        reject,
        idleMs,
        command,
        reportProgress,
        timer: setTimeout(() => this.fail(connection, new Error('The remote host stopped responding.')), idleMs)
      };
      connection.waiter = waiter;
      // Output that arrived between the write and this handler being installed
      // is already in the buffer, so re-run the check rather than waiting for
      // the next chunk that may never come.
      this.settle(connection);
    });
  }

  private receive(connection: Connection, data: string): void {
    // Nothing is being waited for, so nothing arriving now answers a command.
    // Dropping it is what keeps request and response paired: a repainted prompt
    // left in the buffer would satisfy the *next* command instantly, and every
    // answer after that would be attributed to the command before it.
    if (!connection.waiter) return;
    connection.buffer += data;
    // Bounded: a directory of a hundred thousand files must not become a
    // hundred megabytes of retained string. Keeping the tail is right for every
    // consumer here — the prompt, the last meter frame, the final error line.
    if (connection.buffer.length > 4_000_000) connection.buffer = connection.buffer.slice(-2_000_000);
    const waiter = connection.waiter;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.timer = setTimeout(() => this.fail(connection, new Error('The remote host stopped responding.')), waiter.idleMs);
      if (waiter.reportProgress) {
        const progress = parseProgress(data);
        if (progress) this.onEvent({ type: 'progress', sessionId: connection.id, ...progress });
      }
    }
    this.settle(connection);
  }

  /**
   * Decide whether the connection's current output ends the wait: a prompt for
   * the next command, a question for the user, or a failure that ends it all.
   */
  private settle(connection: Connection): void {
    const waiter = connection.waiter;
    if (!waiter) return;

    const fatal = detectFatal(connection.buffer);
    if (fatal) {
      this.fail(connection, new Error(fatal));
      return;
    }

    const question = detectPrompt(connection.buffer);
    if (question) {
      // Ask once per question: the buffer keeps growing, and a re-emitted
      // prompt would replace the field the user is already typing into.
      const text = question.text;
      if (connection.buffer.length && text !== lastQuestion.get(connection.id)) {
        lastQuestion.set(connection.id, text);
        this.onEvent({ type: 'prompt', prompt: { sessionId: connection.id, kind: question.kind, text } });
      }
      return;
    }

    // A bare prompt with nothing before it is the *normal* answer to a command
    // that succeeded quietly — verified against the real client, which replies
    // to `cd` and `mkdir` with the prompt alone, and which ConPTY does not echo
    // the command back through. Waiting for more than this hangs every silent
    // command; that pairing is kept honest by receive() instead.
    if (!endsWithPrompt(connection.buffer)) return;

    clearTimeout(waiter.timer);
    connection.waiter = null;
    lastQuestion.delete(connection.id);
    waiter.resolve(responseBody(connection.buffer, waiter.command));
  }

  private fail(connection: Connection, error: Error): void {
    const waiter = connection.waiter;
    connection.waiter = null;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private handleExit(connection: Connection): void {
    const wasOpen = !connection.closed;
    connection.closed = true;
    this.fail(connection, new Error('The transfer connection closed.'));
    this.connections.delete(connection.id);
    lastQuestion.delete(connection.id);
    if (wasOpen) {
      this.onEvent({ type: 'closed', sessionId: connection.id, message: `Transfer connection to ${connection.target} closed.` });
    }
  }

  private destroy(connection: Connection): void {
    connection.closed = true;
    try {
      connection.pty.kill();
    } catch {
      /* already gone */
    }
    this.connections.delete(connection.id);
    lastQuestion.delete(connection.id);
  }
}

/** The last question each connection asked, so it is only surfaced once. */
const lastQuestion = new Map<string, string>();

