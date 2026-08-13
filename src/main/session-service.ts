import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { CreateLocalRequest, SessionBackend, SessionInfo, ShellBackend } from '../shared/types.js';

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

export type PtyHandle = {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
};

type SessionPty = {
  handle: PtyHandle;
  kind: 'local' | 'ssh';
};

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

export function shellBackendArgs(backend: SessionBackend, distribution?: string): ShellBackend {
  if (backend === 'wsl') {
    if (distribution && !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(distribution.trim())) throw new Error('Invalid WSL distribution name.');
    return { backend, executable: process.platform === 'win32' ? 'wsl.exe' : 'wsl', args: distribution ? ['-d', distribution.trim()] : [], label: distribution ? `WSL · ${distribution.trim()}` : 'WSL', wslDistribution: distribution?.trim() };
  }
  if (backend === 'powershell') return { backend, executable: process.platform === 'win32' ? 'pwsh.exe' : 'pwsh', args: [], label: 'PowerShell' };
  if (backend === 'zsh') return { backend, executable: 'zsh', args: [], label: 'zsh' };
  return { backend: 'bash', executable: 'bash', args: [], label: 'bash' };
}

/** Does this shell actually run here? Starts the real binary, so it is slow. */
export async function probeShellBackend(candidate: ShellBackend): Promise<boolean> {
  try {
    await execFileAsync(
      candidate.executable,
      candidate.backend === 'wsl' ? ['--status'] : ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * bash is assumed present; the optional backends are included only when the
 * probe says they run.
 *
 * The probe is injectable so tests can exercise the filtering without starting
 * real processes. GitHub's ubuntu runners ship pwsh, so the live probe is not
 * a fast ENOENT there — it cold-starts PowerShell, which intermittently
 * exceeded vitest's 5s default and failed CI on unrelated pull requests.
 */
export async function discoverShellBackends(
  isAvailable: (candidate: ShellBackend) => Promise<boolean> = probeShellBackend
): Promise<ShellBackend[]> {
  const result: ShellBackend[] = [shellBackendArgs('bash')];
  for (const backend of ['powershell', 'wsl'] as const) {
    const candidate = shellBackendArgs(backend);
    if (await isAvailable(candidate)) result.push(candidate);
  }
  return result;
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

  constructor(options: { onEvent?: ScreenService['onEvent'] } = {}) { this.onEvent = options.onEvent; }

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
    const backend = request.backend ?? 'bash';
    const shell = shellBackendArgs(backend, request.wslDistribution);
    const requestedCwd = request.cwd ?? homedir();
    if (backend !== 'bash' && !(await executableAvailable(shell.executable))) throw new Error(`${shell.label} is not installed or unavailable.`);
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

  attach(id: string, onData: (data: string) => void, onExit: (message: string) => void): SessionInfo {
    const existing = this.getSession(id);
    if (this.ptys.has(id)) return { ...existing, status: 'connected' };

    if (id.startsWith('local:')) {
      const fallback = this.fallbackLocalSessions.get(id);
      if (fallback) {
        fallback.status = 'connected';
        fallback.lastSeen = new Date().toISOString();
        const shell = shellBackendArgs(fallback.backend ?? 'bash', fallback.wslDistribution);
        this.spawnCommand(id, shell.executable, shell.args, onData, onExit, fallback.cwd);
        this.onEvent?.('attached', fallback, true);
        return { ...fallback };
      }
      // Session ids cross the IPC boundary from the renderer, so re-validate
      // rather than trusting that createLocal produced this one.
      const name = validateSessionName(id.slice('local:'.length));
      this.spawnCommand(id, 'screen', ['-x', name], onData, onExit);
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
      this.spawnCommand(id, 'ssh', args, onData, onExit);
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
    cwd = homedir()
  ): void {
    const pty = loadPty();
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
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
    this.ptys.set(sessionId, { handle, kind: sessionId.startsWith('ssh:') ? 'ssh' : 'local' });
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

  resize(sessionId: string, cols: number, rows: number): void {
    this.ptys.get(sessionId)?.handle.resize(cols, rows);
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

async function executableAvailable(executable: string): Promise<boolean> { try { await execFileAsync(executable, ['--version']); return true; } catch { return false; } }
