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

/**
 * What the main process knows about the stored speech server key.
 *
 * The key itself is never part of this: the panel needs to say whether one is
 * saved, not show it. `encryptionAvailable` is false on a system with no
 * keyring, where saving is refused rather than written in the clear.
 */
export interface SpeechApiKeyStatus {
  stored: boolean;
  encryptionAvailable: boolean;
}

/**
 * A session a workspace held, described well enough to find it again.
 *
 * The id alone is not enough. A local `screen` session's id is derived from its
 * name and comes back identical after a relaunch, but an SSH session's is a
 * fresh uuid each launch, so the durable keys travel alongside it. Never
 * carries cwd, command arguments, or credentials.
 */
export interface StoredWorkspaceMember {
  sessionId: string;
  kind: SessionKind;
  name: string;
  host?: string;
  screenName?: string;
  sshTarget?: string;
  backend?: string;
}

/** How a workspace was arranged, as stored. Validated on load, so loosely typed. */
export interface StoredWorkspaceView {
  layout: string;
  lastSplit: string;
  activeSessionId?: string;
  focusedSessionId?: string;
  maximizedSessionId?: string | null;
}

export interface StoredWorkspace {
  id: string;
  name: string;
  view: StoredWorkspaceView;
  members: StoredWorkspaceMember[];
}

export interface StoredWorkspaceFile {
  version: number;
  activeWorkspaceId?: string;
  workspaces: StoredWorkspace[];
}

/**
 * One command, in one directory, with what is known about how it went.
 *
 * Keyed by command *and* directory rather than command alone: running
 * `npm test` in two projects is two facts, and keeping them apart is what lets
 * the palette put the one from here first. The palette collapses them back
 * together for display.
 */
export interface CommandHistoryEntry {
  id: string;
  command: string;
  cwd?: string;
  host?: string;
  kind?: SessionKind;
  /** Of the most recent run. Absent when the shell reported none. */
  exitCode?: number;
  lastRun: string;
  runs: number;
  /** Times this was chosen from the palette, which is what makes it improve. */
  picks: number;
}

export interface StoredCommandHistoryFile {
  version: number;
  entries: CommandHistoryEntry[];
}

/** A command as the renderer reports it, before the store gives it an identity. */
export interface CommandRecord {
  command: string;
  cwd?: string;
  host?: string;
  kind?: SessionKind;
  exitCode?: number;
}
 
/**
 * What the model is told about where the developer is working.
 *
 * `output` is the untrusted part: a bounded tail of the pane, included only when
 * the setting says so, and never treated as instruction. See ai-protocol.ts.
 */
export interface AiSuggestionContext {
  shell?: string;
  cwd?: string;
  host?: string;
  kind?: SessionKind;
  output?: string;
}

export interface AiSuggestionRequest {
  prompt: string;
  /** The pane this was asked about, so the answer cannot land in another one. */
  sessionId?: string;
  context: AiSuggestionContext;
}

/**
 * A suggested command, or an explanation of why there is not one.
 *
 * An empty `command` is a normal outcome, not an error: it is what a reply that
 * did not parse, named several commands, or declined produces. The dialog shows
 * the explanation and has nothing to run.
 */
export interface AiSuggestion {
  command: string;
  explanation: string;
}

/** What the settings panel learns from testing an endpoint. */
export interface AiTestResult {
  ok: boolean;
  message: string;
}

/**
 * Which way a tunnel runs.
 *
 * `local` makes a port on the remote reachable here — the common case, and what
 * a remote dev server needs. `remote` makes a port on this machine reachable
 * from the remote, for a webhook or an agent calling back.
 */
export type ForwardDirection = 'local' | 'remote';

/**
 * How widely the listening port is exposed.
 *
 * `loopback` is the default everywhere: the port answers only on the machine
 * doing the listening. `all` re-exports someone else's service onto whatever
 * network that machine is attached to, so it is never implied — only chosen.
 */
export type ForwardBind = 'loopback' | 'all';

export type ForwardStatus = 'idle' | 'connecting' | 'open' | 'error';

/**
 * A tunnel to open.
 *
 * Deliberately symmetric: `listenPort`/`bind` describe the side that listens and
 * `destinationHost`/`destinationPort` the side that receives, whichever machine
 * each of those is. `direction` is the only thing that says which is which.
 */
export interface PortForwardRequest {
  target: string;
  direction: ForwardDirection;
  listenPort: number;
  destinationPort: number;
  /** Resolved on the receiving side. Defaults to localhost there. */
  destinationHost?: string;
  bind: ForwardBind;
  /** Reuses an id when reconnecting a remembered forward. */
  id?: string;
}

export interface PortForwardInfo extends PortForwardRequest {
  id: string;
  status: ForwardStatus;
  /** Why it is not open, when it is not. */
  message?: string;
}

export type PortForwardEvent =
  | { type: 'status'; forward: PortForwardInfo }
  // The same three questions an SSH client can ask, so the renderer answers a
  // tunnel's password prompt with the control it already has for a transfer's.
  | { type: 'prompt'; forwardId: string; prompt: Pick<SftpPrompt, 'kind' | 'text'> }
  | { type: 'closed'; forwardId: string; message: string };

export interface StoredPortForwardFile {
  version: number;
  forwards: Array<Omit<PortForwardInfo, 'status' | 'message'>>;
}

export interface TerminalApi {
  listSessions(): Promise<SessionInfo[]>;
  listHistory(): Promise<HistoryEntry[]>;
  removeHistory(entryId: string): Promise<boolean>;
  /**
   * The command history, and the three things done to it.
   *
   * Held in the main process like the other durable state. `recordCommand` is
   * called only for text that passed command-redaction, and only while the
   * setting is on; `pickCommand` notes a deliberate choice, which is what makes
   * the ranking improve with use.
   */
  listCommandHistory(): Promise<CommandHistoryEntry[]>;
  recordCommand(record: CommandRecord): Promise<CommandHistoryEntry | null>;
  pickCommand(id: string): Promise<void>;
  clearCommandHistory(): Promise<void>;
  /**
   * The stored workspace layout, and a way to replace it.
   *
   * Held in the main process rather than localStorage because it is durable
   * session metadata, validated on both sides of the boundary; `saveWorkspaces`
   * rejects a file it cannot make sense of and returns what it actually stored.
   */
  loadWorkspaces(): Promise<StoredWorkspaceFile>;
  saveWorkspaces(file: StoredWorkspaceFile): Promise<StoredWorkspaceFile>;
  /** Tunnels currently open, which outlive the Ports view being closed. */
  listForwards(): Promise<PortForwardInfo[]>;
  /**
   * Open a tunnel, resolving once it is actually listening.
   *
   * Rejects with the client's own reason when it cannot — a port already bound,
   * a refused key, an sshd that will not widen a remote forward. A password or
   * host-key question arrives as a `prompt` event while this is still pending.
   */
  openForward(request: PortForwardRequest): Promise<PortForwardInfo>;
  closeForward(id: string): Promise<void>;
  answerForwardPrompt(id: string, answer: string): Promise<void>;
  loadForwards(): Promise<StoredPortForwardFile>;
  saveForwards(file: StoredPortForwardFile): Promise<StoredPortForwardFile>;
  onForwardEvent(callback: (event: PortForwardEvent) => void): () => void;
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
  /**
   * Ask the configured endpoint for a command.
   *
   * Made in the main process, not here: a renderer fetch is cross-origin and
   * Ollama refuses those unless OLLAMA_ORIGINS is set, and the API key then
   * never has to enter the renderer at all. An empty `command` in the answer is
   * a normal outcome — see AiSuggestion.
   */
  requestAiCommand(config: { baseUrl: string; model: string }, request: AiSuggestionRequest): Promise<AiSuggestion>;
  /** Model ids the endpoint reports, for the settings panel's list. */
  listAiModels(baseUrl: string): Promise<string[]>;
  testAiEndpoint(config: { baseUrl: string; model: string }): Promise<AiTestResult>;
  /** Abandon a suggestion in flight, when the dialog that wanted it has gone. */
  cancelAiRequest(): Promise<void>;
  aiApiKeyStatus(): Promise<SpeechApiKeyStatus>;
  saveAiApiKey(key: string): Promise<SpeechApiKeyStatus>;
  clearAiApiKey(): Promise<SpeechApiKeyStatus>;
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
  sftpDownload(sessionId: string, remotePath: string, localDir: string, kind: FileEntry['kind']): Promise<void>;
  /** Answer a password/passphrase prompt, or accept a host key with `yes`. */
  sftpAnswerPrompt(sessionId: string, answer: string): Promise<void>;
  sftpClose(sessionId: string): Promise<void>;
  onSftpEvent(callback: (event: SftpEvent) => void): () => void;
  /**
   * Open a link in the user's own browser. Rejects when the URL is not one ZeroG
   * will open — the scheme allowlist lives in the main process, because the URL
   * arrives from terminal output and the renderer is not where that is decided.
   */
  openExternal(url: string): Promise<void>;
  /** A link the main process refused, so a click that did nothing can say why. */
  onLinkRefused(callback: (reason: string) => void): () => void;
  /** Whether a speech server key is saved, and whether saving one is possible. */
  speechApiKeyStatus(): Promise<SpeechApiKeyStatus>;
  /**
   * Store the speech server key, encrypted by the OS. Rejects on a system with
   * no secret store rather than writing it in the clear. An empty key clears it.
   */
  saveSpeechApiKey(key: string): Promise<SpeechApiKeyStatus>;
  /** Forget the stored key. */
  clearSpeechApiKey(): Promise<SpeechApiKeyStatus>;
  /**
   * The stored key, for the one moment it is needed: building the Authorization
   * header of a transcription request. Not held in renderer state.
   */
  readSpeechApiKey(): Promise<string | null>;
}

declare global {
  interface Window {
    zerog?: TerminalApi;
  }
}
