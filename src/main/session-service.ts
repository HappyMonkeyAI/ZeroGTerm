import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { CreateLocalRequest, SessionInfo } from '../shared/types.js';
import { defaultShellBackend, isLocalShellBackend, resolveShellBackend } from './shell-catalog.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,48}$/;
/**
 * host, user@host, host:port, user@host:port — no shell metacharacters.
 * Host and user must start alphanumeric: a leading '-' would be parsed by
 * ssh's getopt as an option, and `-Fsome.cfg` can point ssh at an attacker
 * -chosen config file (hence ProxyCommand) without any shell involvement.
 */
const SSH_TARGET = /^(?:([A-Za-z0-9][A-Za-z0-9._-]*)@)?([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{1,5}))?$/;

/** The slice of node-pty's process this service actually uses. */
export type PtyProcess = {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (listener: (data: string) => void) => void;
  onExit: (listener: () => void) => void;
};

export type SpawnPty = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }
) => PtyProcess;

export type PtyHandle = {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
};

type SessionPty = {
  handle: PtyHandle;
  kind: 'local' | 'ssh';
  /** What the pty was last told, so a repeat of the same size is not re-sent. */
  cols: number;
  rows: number;
};

/** The pane's measured size in character cells. */
export type PtySize = { cols: number; rows: number };

/**
 * Size a pty starts at when the pane could not be measured — a placeholder,
 * not a preference. Panes pass their real size through attach().
 */
const FALLBACK_SIZE: PtySize = { cols: 120, rows: 32 };

/**
 * A size a pty can actually be given. Sizes cross the IPC boundary from the
 * renderer, and a zero or fractional one is rejected by ConPTY (and makes
 * every full-screen program wrap in the wrong place on Unix).
 */
function usableSize(size: PtySize | undefined): PtySize | undefined {
  if (!size) return undefined;
  const { cols, rows } = size;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return undefined;
  if (cols < 2 || rows < 2 || cols > 2000 || rows > 2000) return undefined;
  return { cols, rows };
}

export function validateSessionName(name: string): string {
  const value = name.trim();
  if (!NAME.test(value)) {
    throw new Error('Session names may contain letters, numbers, _, ., and - only.');
  }
  return value;
}

export function validateSshTarget(input: string): { target: string; args: string[] } {
  const value = input.trim();
  const match = value.match(SSH_TARGET);
  if (!match) {
    throw new Error('SSH target must look like host, user@host, or user@host:port.');
  }
  const [, user, host, portText] = match;
  if (portText) {
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('SSH port must be between 1 and 65535.');
    }
  }
  const destination = user ? `${user}@${host}` : host;
  const args = ['-tt'];
  if (portText) args.push('-p', portText);
  // '--' ends option parsing, so the destination can never be read as a flag.
  args.push('--', destination);
  return { target: value, args };
}

export function parseWslDistributions(output: string): string[] {
  return output.split(/\r?\n/).slice(1).map((line) => line.replace(/^\*?\s*/, '').trim())
    .map((line) => line.split(/\s{2,}/)[0]).filter((name) => /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name));
}

export function parseScreenList(output: string): SessionInfo[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = line.match(/^(\d+)\.(\S+)\s+\(([^)]+)\)/);
      if (!match) return [];
      const [, , name, state] = match;
      const attached = /attached/i.test(state);
      return [
        {
          id: `local:${name}`,
          name,
          kind: 'local' as const,
          host: 'local',
          cwd: homedir(),
          status: attached ? 'connected' : 'detached',
          lastSeen: new Date().toISOString(),
          persistence: 'screen' as const,
          backend: 'screen' as const,
          scope: 'local' as const,
          source: 'discovered' as const,
          screenName: name
        }
      ];
    });
}

function loadPty(): any {
  try {
    return require('node-pty');
  } catch {
    throw new Error('PTY support is not installed. Run: npm install node-pty (needs make/gcc-c++).');
  }
}

export class ScreenService {
  private ptys = new Map<string, SessionPty>();
  private sshSessions = new Map<string, SessionInfo>();
  private fallbackLocalSessions = new Map<string, SessionInfo>();
  private readonly onEvent?: (event: 'created' | 'attached' | 'detached' | 'closed' | 'reconnect-failed', session: SessionInfo, available: boolean) => void;
  /** Injectable so tests can exercise routing and teardown without a real shell. */
  private readonly spawnPty: SpawnPty;

  constructor(options: { onEvent?: ScreenService['onEvent']; spawnPty?: SpawnPty } = {}) {
    this.onEvent = options.onEvent;
    this.spawnPty = options.spawnPty ?? ((file, args, ptyOptions) => loadPty().spawn(file, args, ptyOptions));
  }

  async available(): Promise<boolean> {
    try {
      await execFileAsync('screen', ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<SessionInfo[]> {
    const local = (await this.available()) ? await this.listLocal() : [];
    const fallback = [...this.fallbackLocalSessions.values()];
    const ssh = [...this.sshSessions.values()];
    return [
      ...local.map((session) => ({
        ...session,
        status: this.ptys.has(session.id) ? 'connected' as const : session.status
      })),
      ...fallback.map((session) => ({
        ...session,
        status: this.ptys.has(session.id) ? 'connected' as const : session.status
      })),
      ...ssh.map((session) => ({
        ...session,
        status: this.ptys.has(session.id) ? 'connected' as const : session.status
      }))
    ];
  }

  private async listLocal(): Promise<SessionInfo[]> {
    try {
      const { stdout } = await execFileAsync('screen', ['-ls']);
      return parseScreenList(stdout);
    } catch (error: any) {
      if (typeof error?.stdout === 'string' && error.stdout.trim()) {
        return parseScreenList(error.stdout);
      }
      return [];
    }
  }

  async createLocal(nameOrRequest: string | CreateLocalRequest, cwd = homedir()): Promise<SessionInfo> {
    const request = typeof nameOrRequest === 'string' ? { name: nameOrRequest, cwd } : nameOrRequest;
    const safeName = validateSessionName(request.name);
    // No backend named means "whatever this machine prefers": a native shell
    // on Windows, the login shell or bash on Unix. resolveShellBackend throws by
    // name when a named backend is not installed, so a missing shell is a clear
    // message rather than a pty that dies on spawn.
    const shell = request.backend
      ? resolveShellBackend(request.backend, request.wslDistribution)
      : defaultShellBackend();
    const backend = shell.backend;
    const requestedCwd = request.cwd ?? homedir();
    if (!(await this.available())) {
      const fallback: SessionInfo = { id: `local:${safeName}`, name: safeName, kind: 'local', host: 'local', cwd: requestedCwd, status: 'detached', lastSeen: new Date().toISOString(), persistence: 'process', backend, scope: 'local', source: 'active', wslDistribution: shell.wslDistribution };
      this.fallbackLocalSessions.set(fallback.id, fallback);
      this.onEvent?.('created', fallback, true);
      return fallback;
    }
    await execFileAsync('screen', ['-dmS', safeName, shell.executable, ...shell.args], { cwd: requestedCwd });
    const session: SessionInfo = { id: `local:${safeName}`, name: safeName, kind: 'local', host: 'local', cwd: requestedCwd, status: 'detached', lastSeen: new Date().toISOString(), persistence: 'screen', backend: 'screen', scope: 'local', source: 'active', screenName: safeName, wslDistribution: shell.wslDistribution };
    this.onEvent?.('created', session, true);
    return session;
  }

  async createSsh(targetInput: string, name?: string): Promise<SessionInfo> {
    const { target } = validateSshTarget(targetInput);
    const safeName = validateSessionName(name?.trim() || target.replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 40));
    const session: SessionInfo = {
      id: `ssh:${randomUUID()}`,
      name: safeName,
      kind: 'ssh',
      host: target,
      cwd: '~',
      status: 'detached',
      lastSeen: new Date().toISOString(),
      sshTarget: target,
      backend: 'ssh',
      scope: 'remote',
      source: 'active'
    };
    this.sshSessions.set(session.id, session);
    this.onEvent?.('created', session, true);
    return session;
  }

  /**
   * Attach a pane to a session, starting its pty if it does not have one.
   *
   * `size` is the pane's own measurement. A pty spawned at some stock size and
   * resized a moment later shows its first frame at the wrong width, and a
   * full-screen program redrawing over that frame leaves pieces of it behind —
   * so the shell is started at the size it will actually be displayed at.
   */
  attach(id: string, onData: (data: string) => void, onExit: (message: string) => void, size?: PtySize): SessionInfo {
    const existing = this.getSession(id);
    if (this.ptys.has(id)) {
      // Re-attaching pane may be a different size than the one that started it.
      const measured = usableSize(size);
      if (measured) this.resize(id, measured.cols, measured.rows);
      return { ...existing, status: 'connected' };
    }

    if (id.startsWith('local:')) {
      const fallback = this.fallbackLocalSessions.get(id);
      if (fallback) {
        fallback.status = 'connected';
        fallback.lastSeen = new Date().toISOString();
        const shell = isLocalShellBackend(fallback.backend)
          ? resolveShellBackend(fallback.backend, fallback.wslDistribution)
          : defaultShellBackend();
        this.spawnCommand(id, shell.executable, shell.args, onData, onExit, fallback.cwd, size);
        this.onEvent?.('attached', fallback, true);
        return { ...fallback };
      }
      // Session ids cross the IPC boundary from the renderer, so re-validate
      // rather than trusting that createLocal produced this one.
      const name = validateSessionName(id.slice('local:'.length));
      this.spawnCommand(id, 'screen', ['-x', name], onData, onExit, homedir(), size);
      this.onEvent?.('attached', existing, true);
      return { ...existing, status: 'connected', persistence: 'screen' };
    }

    const session = this.sshSessions.get(id);
    if (!session?.sshTarget) {
      throw new Error(`Unknown session: ${id}`);
    }
    const { args } = validateSshTarget(session.sshTarget);
    session.status = 'connected';
    session.lastSeen = new Date().toISOString();
    try {
      this.spawnCommand(id, 'ssh', args, onData, onExit, homedir(), size);
    } catch (error) {
      session.status = 'error';
      this.onEvent?.('reconnect-failed', session, false);
      throw error;
    }
    this.onEvent?.('attached', session, true);
    return { ...session };
  }

  private getSession(id: string): SessionInfo {
    if (id.startsWith('local:')) {
      const fallback = this.fallbackLocalSessions.get(id);
      if (fallback) return fallback;
      const name = validateSessionName(id.slice('local:'.length));
      return {
        id,
        name,
        kind: 'local',
        host: 'local',
        cwd: homedir(),
        status: 'detached',
        lastSeen: new Date().toISOString(),
        persistence: 'screen'
      };
    }
    const session = this.sshSessions.get(id);
    if (!session) throw new Error(`Unknown session: ${id}`);
    return session;
  }

  private spawnCommand(
    sessionId: string,
    file: string,
    args: string[],
    onData: (data: string) => void,
    onExit: (message: string) => void,
    cwd = homedir(),
    size?: PtySize
  ): void {
    const { cols, rows } = usableSize(size) ?? FALLBACK_SIZE;
    const proc = this.spawnPty(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: process.env
    });
    const handle: PtyHandle = {
      write: (data: string) => proc.write(data),
      resize: (cols: number, rows: number) => proc.resize(cols, rows),
      kill: () => {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }
    };
    this.ptys.set(sessionId, { handle, kind: sessionId.startsWith('ssh:') ? 'ssh' : 'local', cols, rows });
    proc.onData(onData);
    proc.onExit(() => {
      this.ptys.delete(sessionId);
      const fallback = this.fallbackLocalSessions.get(sessionId);
      if (fallback) { fallback.status = 'detached'; this.onEvent?.('detached', fallback, false); }
      const ssh = this.sshSessions.get(sessionId);
      if (ssh) { ssh.status = 'detached'; this.onEvent?.('detached', ssh, false); }
      onExit(
        fallback
          ? 'Terminal detached. This process-only local session will not survive app exit; install screen for persistence.'
          : 'Terminal detached. Local screen sessions remain alive; SSH sessions end with the connection.'
      );
    });
  }

  write(sessionId: string, data: string): void {
    this.ptys.get(sessionId)?.handle.write(data);
  }

  /**
   * Tell a session's pty how big its pane is now.
   *
   * A resize is not free and not invisible: it makes ConPTY reflow and re-emit
   * its screen, and every full-screen program redraw on SIGWINCH. Panes refit
   * on layout, font and status changes, which mostly produce the size the pty
   * already has, so a repeat of the current size is dropped rather than paid
   * for in a torn redraw.
   */
  resize(sessionId: string, cols: number, rows: number): void {
    const pty = this.ptys.get(sessionId);
    if (!pty) return;
    const size = usableSize({ cols, rows });
    if (!size || (size.cols === pty.cols && size.rows === pty.rows)) return;
    pty.cols = size.cols;
    pty.rows = size.rows;
    pty.handle.resize(size.cols, size.rows);
  }

  detach(sessionId: string): void {
    this.ptys.get(sessionId)?.handle.kill();
    this.ptys.delete(sessionId);
  }

  detachAll(): void {
    for (const sessionId of this.ptys.keys()) this.detach(sessionId);
  }

  /**
   * Close a pane's session: detach its PTY and drop transient bookkeeping.
   * Screen-backed sessions are deliberately left running so they remain
   * discoverable via `screen -ls`; SSH and process-only sessions end.
   */
  close(sessionId: string): void {
    const session = this.getSession(sessionId);
    this.detach(sessionId);
    this.sshSessions.delete(sessionId);
    this.fallbackLocalSessions.delete(sessionId);
    this.onEvent?.('closed', session, false);
  }
}

