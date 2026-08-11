import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { SessionInfo } from '../shared/types.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,48}$/;
/** host, user@host, host:port, user@host:port — no shell metacharacters. */
const SSH_TARGET = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/;

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
  args.push(destination);
  return { target: value, args };
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
          persistence: 'screen' as const
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

  async createLocal(name: string, cwd = homedir()): Promise<SessionInfo> {
    const safeName = validateSessionName(name);
    if (!(await this.available())) {
      const fallback: SessionInfo = {
        id: `local:${safeName}`,
        name: safeName,
        kind: 'local',
        host: 'local',
        cwd,
        status: 'detached',
        lastSeen: new Date().toISOString(),
        persistence: 'process'
      };
      this.fallbackLocalSessions.set(fallback.id, fallback);
      return fallback;
    }
    await execFileAsync('screen', ['-dmS', safeName, 'bash'], { cwd });
    return {
      id: `local:${safeName}`,
      name: safeName,
      kind: 'local',
      host: 'local',
      cwd,
      status: 'detached',
      lastSeen: new Date().toISOString(),
      persistence: 'screen'
    };
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
      sshTarget: target
    };
    this.sshSessions.set(session.id, session);
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
        this.spawnCommand(id, 'bash', [], onData, onExit, fallback.cwd);
        return { ...fallback };
      }
      const name = id.slice('local:'.length);
      this.spawnCommand(id, 'screen', ['-x', name], onData, onExit);
      return { ...existing, status: 'connected', persistence: 'screen' };
    }

    const session = this.sshSessions.get(id);
    if (!session?.sshTarget) {
      throw new Error(`Unknown session: ${id}`);
    }
    const { args } = validateSshTarget(session.sshTarget);
    session.status = 'connected';
    session.lastSeen = new Date().toISOString();
    this.spawnCommand(id, 'ssh', args, onData, onExit);
    return { ...session };
  }

  private getSession(id: string): SessionInfo {
    if (id.startsWith('local:')) {
      const fallback = this.fallbackLocalSessions.get(id);
      if (fallback) return fallback;
      const name = id.slice('local:'.length);
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
      if (fallback) fallback.status = 'detached';
      const ssh = this.sshSessions.get(sessionId);
      if (ssh) ssh.status = 'detached';
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
    this.detach(sessionId);
    this.sshSessions.delete(sessionId);
    this.fallbackLocalSessions.delete(sessionId);
  }
}
