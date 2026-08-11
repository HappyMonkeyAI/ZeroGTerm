export type SessionStatus = 'connected' | 'detached' | 'unavailable' | 'error';
export type SessionKind = 'local' | 'ssh';

export interface SessionInfo {
  id: string;
  name: string;
  kind: SessionKind;
  host: string;
  cwd: string;
  status: SessionStatus;
  lastSeen: string;
  /** Local sessions use screen when available; process is a non-persistent fallback. */
  persistence?: 'screen' | 'process';
  /** SSH only: validated user@host or host[:port] target. */
  sshTarget?: string;
}

export interface CreateLocalRequest {
  name: string;
  cwd?: string;
}

export interface CreateSshRequest {
  name?: string;
  target: string;
}

export interface TerminalApi {
  listSessions(): Promise<SessionInfo[]>;
  createLocalSession(request: CreateLocalRequest): Promise<SessionInfo>;
  createSshSession(request: CreateSshRequest): Promise<SessionInfo>;
  attachSession(id: string): Promise<SessionInfo>;
  /** Detach and close a pane's session; screen-backed sessions stay alive. */
  closeSession(id: string): Promise<void>;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  copyText(text: string): Promise<void>;
  readText(): Promise<string>;
  onData(callback: (sessionId: string, data: string) => void): () => void;
  onStatus(callback: (sessionId: string, message: string) => void): () => void;
  requestAiCommand(): Promise<{ command: string; explanation: string }>;
}

declare global {
  interface Window {
    zerog?: TerminalApi;
  }
}
