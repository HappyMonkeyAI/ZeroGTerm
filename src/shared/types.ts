export type SessionStatus = 'connected' | 'detached' | 'unavailable' | 'error';
export type SessionKind = 'local' | 'ssh';
export type SessionBackend = 'bash' | 'zsh' | 'powershell' | 'wsl' | 'ssh' | 'screen';
export type SessionScope = 'local' | 'remote';
export type SessionSource = 'active' | 'discovered' | 'known-connection' | 'history';

export interface SessionInfo {
  id: string;
  name: string;
  kind: SessionKind;
  host: string;
  cwd: string;
  status: SessionStatus;
  lastSeen: string;
  persistence?: 'screen' | 'process';
  sshTarget?: string;
  backend?: SessionBackend;
  scope?: SessionScope;
  source?: SessionSource;
  screenName?: string;
  wslDistribution?: string;
}

export interface CreateLocalRequest {
  name: string;
  cwd?: string;
  backend?: Exclude<SessionBackend, 'ssh' | 'screen'>;
  wslDistribution?: string;
}

export interface CreateSshRequest {
  name?: string;
  target: string;
}

export interface KnownConnection {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  source?: string;
}

export interface RemoteScreenRequest {
  connection: KnownConnection;
  screenName?: string;
}

export interface ShellBackend {
  backend: Exclude<SessionBackend, 'ssh' | 'screen'>;
  executable: string;
  args: string[];
  label: string;
  wslDistribution?: string;
}

export interface HistoryEntry {
  id: string;
  timestamp: string;
  event: 'created' | 'attached' | 'detached' | 'closed' | 'reconnect-failed';
  session: Pick<SessionInfo, 'id' | 'name' | 'kind' | 'host' | 'backend' | 'scope' | 'screenName' | 'sshTarget' | 'wslDistribution'>;
  available: boolean;
}

export interface TerminalApi {
  listSessions(): Promise<SessionInfo[]>;
  listHistory(): Promise<HistoryEntry[]>;
  removeHistory(entryId: string): Promise<boolean>;
  listBackends(): Promise<ShellBackend[]>;
  listWslDistributions(): Promise<string[]>;
  createLocalSession(request: CreateLocalRequest): Promise<SessionInfo>;
  createSshSession(request: CreateSshRequest): Promise<SessionInfo>;
  listKnownConnections(): Promise<KnownConnection[]>;
  discoverRemoteScreens(connection: KnownConnection): Promise<SessionInfo[]>;
  buildRemoteScreenAttach(connection: KnownConnection, screenName: string): Promise<{ file: string; args: string[] }>;
  attachSession(id: string): Promise<SessionInfo>;
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
