export type SessionStatus = 'connected' | 'detached' | 'unavailable' | 'error';
export type SessionKind = 'local' | 'ssh';
/**
 * Every shell a session can run, plus the two transports.
 *
 * Windows PowerShell (`powershell.exe`, 5.1, always present) and PowerShell 7
 * (`pwsh.exe`, a separate install) are separate backends rather than one entry
 * that prefers whichever is installed: on a machine with both, which one a
 * session runs is a choice worth making explicitly, and stored sessions stay
 * honest about which they used.
 */
export type SessionBackend =
  | 'bash'
  | 'zsh'
  | 'fish'
  | 'sh'
  | 'powershell'
  | 'pwsh'
  | 'cmd'
  | 'wsl'
  | 'ssh'
  | 'screen';

/** The backends that name a shell to start, as opposed to a transport. */
export type LocalShellBackend = Exclude<SessionBackend, 'ssh' | 'screen'>;
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
  backend?: LocalShellBackend;
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
  backend: LocalShellBackend;
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

/** One entry in a directory listing, local or remote. */
export interface FileEntry {
  name: string;
  kind: 'file' | 'directory' | 'symlink';
  /** Bytes. Directories report whatever the filesystem says; it is not shown. */
  size: number;
  /**
   * Last-modified time as the source reported it. Remote listings come from the
   * server's `ls -l`, whose format is the server's choice and may omit the year,
   * so this stays a display string rather than a parsed date that would be wrong
   * about half the time.
   */
  modified?: string;
  permissions?: string;
  /** Where a symlink points, when the listing said. */
  linkTarget?: string;
}

export interface DirectoryListing {
  /** The absolute path that was actually listed, as the source resolved it. */
  path: string;
  entries: FileEntry[];
}

export interface SftpSessionInfo {
  /** Handle for later calls. Distinct from the terminal session's id. */
  id: string;
  target: string;
  cwd: string;
}

/**
 * Something the transfer connection needs from the user before it can continue:
 * a password, a key passphrase, or a host-key decision. ZeroG never answers
 * these itself — an unattended "yes" to an unknown host key is exactly the
 * check that makes SSH worth having.
 */
export interface SftpPrompt {
  sessionId: string;
  kind: 'password' | 'passphrase' | 'confirm';
  /** The prompt text as the SSH client wrote it, including any fingerprint. */
  text: string;
}

export type SftpEvent =
  | { type: 'progress'; sessionId: string; name: string; percent: number; detail: string }
  | { type: 'status'; sessionId: string; message: string }
  | { type: 'prompt'; prompt: SftpPrompt }
  | { type: 'closed'; sessionId: string; message: string };

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
  /** `size` starts the shell at the pane's own size, so its first frame fits. */
  attachSession(id: string, size?: { cols: number; rows: number }): Promise<SessionInfo>;
  closeSession(id: string): Promise<void>;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  copyText(text: string): Promise<void>;
  readText(): Promise<string>;
  onData(callback: (sessionId: string, data: string) => void): () => void;
  onStatus(callback: (sessionId: string, message: string) => void): () => void;
  requestAiCommand(): Promise<{ command: string; explanation: string }>;
  /** Local filesystem browsing for the transfer panel. Listing only; no reads. */
  listLocalDirectory(path?: string): Promise<DirectoryListing>;
  localHome(): Promise<string>;
  createLocalDirectory(path: string): Promise<void>;
  renameLocalEntry(from: string, to: string): Promise<void>;
  removeLocalEntry(path: string, kind: FileEntry['kind']): Promise<void>;
  /** Open an SFTP connection to an SSH target, starting at `cwd` when given. */
  sftpOpen(target: string, cwd?: string): Promise<SftpSessionInfo>;
  sftpList(sessionId: string, path?: string): Promise<DirectoryListing>;
  sftpMkdir(sessionId: string, path: string): Promise<void>;
  sftpRename(sessionId: string, from: string, to: string): Promise<void>;
  sftpRemove(sessionId: string, path: string, kind: FileEntry['kind']): Promise<void>;
  sftpUpload(sessionId: string, localPath: string, remoteDir: string): Promise<void>;
  sftpDownload(sessionId: string, remotePath: string, localDir: string): Promise<void>;
  /** Answer a password/passphrase prompt, or accept a host key with `yes`. */
  sftpAnswerPrompt(sessionId: string, answer: string): Promise<void>;
  sftpClose(sessionId: string): Promise<void>;
  onSftpEvent(callback: (event: SftpEvent) => void): () => void;
}

declare global {
  interface Window {
    zerog?: TerminalApi;
  }
}
