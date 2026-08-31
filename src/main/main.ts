import { app, BrowserWindow, clipboard, ipcMain, Menu, safeStorage, session, shell } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeClipboardText } from './clipboard.js';
import { ScreenService, parseWslDistributions, type PtySize } from './session-service.js';
import { discoverShellBackends } from './shell-catalog.js';
import { SessionHistoryStore, defaultHistoryPath } from './session-history.js';
import { WorkspaceStore, defaultWorkspacePath } from './workspace-store.js';
import { buildRemoteScreenAttachArgs, buildRemoteScreenDiscoveryArgs, listKnownConnections, parseRemoteScreenList, validateKnownConnection } from './ssh-inventory.js';
import { createLocalDirectory, listLocalDirectory, localHome, removeLocalEntry, renameLocalEntry } from './local-fs.js';
import { decideExternalLink, isApplicationUrl } from './external-links.js';
import { SftpService } from './sftp-service.js';
import { AI_API_KEY, SPEECH_API_KEY, SecretStore, defaultSecretsPath } from './secret-store.js';
import { AiService } from './ai-service.js';
import type { AiSuggestionRequest, FileEntry, SpeechApiKeyStatus } from '../shared/types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const history = new SessionHistoryStore({ filePath: defaultHistoryPath(app.getPath('userData')) });
const workspaceStore = new WorkspaceStore({ filePath: defaultWorkspacePath(app.getPath('userData')) });
const service = new ScreenService({ onEvent: (event, session, available) => { void history.record(event, session, available); } });
let win: BrowserWindow | undefined;
// Transfer connections outlive any single panel opening, so the panel can be
// closed and reopened without re-authenticating to the host.
const sftp = new SftpService({ onEvent: (event) => win?.webContents.send('sftp:event', event) });
// API keys for speech servers. safeStorage is only usable after the app is
// ready, which every IPC call here already is.
const secrets = new SecretStore({ filePath: defaultSecretsPath(app.getPath('userData')), crypto: safeStorage });

/** A pane's measured size, as it arrives from the renderer. */
function parsePtySize(value: unknown): PtySize | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { cols, rows } = value as { cols?: unknown; rows?: unknown };
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return undefined;
  return { cols: cols as number, rows: rows as number };
}

// GPU is unstable under Toolbox/Wayland on this host; allow override.
if (process.env.ZEROG_ENABLE_GPU !== '1') {
  app.disableHardwareAcceleration();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0B0F14',
    // Do not gate visibility on ready-to-show: that event is unreliable with
    // Electron sandbox + Toolbox/Wayland and otherwise leaves a live hidden app.
    show: true,
    webPreferences: {
      // CommonJS preload is required; ESM preload fails under sandbox.
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // A link in a pane belongs in the user's browser, not in a window of this app.
  //
  // Electron's default answer to window.open is a new BrowserWindow, and xterm
  // activates an OSC 8 hyperlink by calling exactly that — so clicking a link in
  // a terminal opened a bare Electron window with no address bar, no profile and
  // no extensions, which is nobody's browser. Both handlers below refuse to
  // navigate and hand the URL to the desktop instead.
  //
  // They are also the backstop for the renderer's own link handling: whatever
  // asks for a window here, from any code path now or later, cannot get one.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url);
    return { action: 'deny' };
  });

  // The same for a link that would replace the workspace with a web page, which
  // would take every pane down with it.
  const contents = win.webContents;
  contents.on('will-navigate', (event, url) => {
    if (isApplicationUrl(url, contents.getURL())) return;
    event.preventDefault();
    openExternalLink(url);
  });

  win.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error('[zerog] did-fail-load', { code, desc, url });
  });
  win.webContents.on('preload-error', (_event, path, error) => {
    console.error('[zerog] preload-error', path, error);
  });
  win.webContents.on('console-message', (_event, _level, message) => {
    console.log('[renderer]', message);
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    const indexPath = join(__dirname, '../../renderer/index.html');
    void win.loadFile(indexPath);
  }

  win.on('closed', () => {
    win = undefined;
    service.detachAll();
    sftp.closeAll();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Hand a link to the desktop, if it is one this should open.
 *
 * The decision is in external-links.ts and is an allowlist of schemes: the URL
 * comes from terminal output, and the operating system will do a great deal more
 * with `file:` or an application's own scheme than open a web page. A refusal is
 * reported in the status bar rather than silently dropped, so a click that does
 * nothing still says why.
 */
function openExternalLink(url: string): void {
  const decision = decideExternalLink(url);
  if (!decision.open) {
    win?.webContents.send('links:refused', decision.reason);
    console.warn('[zerog] refused to open link', { url, reason: decision.reason });
    return;
  }
  void shell.openExternal(decision.url).catch((error) => {
    win?.webContents.send('links:refused', 'That link could not be opened.');
    console.error('[zerog] openExternal failed', error);
  });
}

ipcMain.handle('links:openExternal', (_event, url: unknown) => {
  const decision = decideExternalLink(url);
  // Rejecting rather than resolving quietly: the renderer puts the reason in the
  // status bar, so the user is never told nothing at all.
  if (!decision.open) throw new Error(decision.reason);
  return shell.openExternal(decision.url);
});

ipcMain.handle('sessions:list', () => service.list());
ipcMain.handle('sessions:history', () => history.list());
ipcMain.handle('sessions:historyRemove', (_event, entryId: string) => history.remove(entryId));

ipcMain.handle('workspaces:load', () => workspaceStore.load());
ipcMain.handle('workspaces:save', (_event, file: unknown) => workspaceStore.save(file));

ipcMain.handle('sessions:backends', () => discoverShellBackends());
ipcMain.handle('sessions:wslDistributions', async () => {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'wsl.exe' : 'wsl', ['--list', '--quiet']);
    return parseWslDistributions(stdout);
  } catch { return []; }
});

ipcMain.handle('sessions:createLocal', async (_event, request: unknown) => {
  if (!isRecord(request) || typeof request.name !== 'string') {
    throw new Error('createLocalSession requires { name: string }');
  }
  const cwd = typeof request.cwd === 'string' ? request.cwd : undefined;
  const backend = request.backend === 'bash' || request.backend === 'zsh' || request.backend === 'powershell' || request.backend === 'wsl' ? request.backend : undefined;
  const wslDistribution = typeof request.wslDistribution === 'string' ? request.wslDistribution : undefined;
  return service.createLocal({ name: request.name, cwd, ...(backend ? { backend } : {}), wslDistribution });
});

ipcMain.handle('sessions:createSsh', async (_event, request: unknown) => {
  if (!isRecord(request) || typeof request.target !== 'string') {
    throw new Error('createSshSession requires { target: string }');
  }
  const name = typeof request.name === 'string' ? request.name : undefined;
  return service.createSsh(request.target, name);
});

ipcMain.handle('connections:listKnown', () => listKnownConnections());
ipcMain.handle('screens:discoverRemote', async (_event, input: unknown) => {
  const connection = validateKnownConnection(input);
  const command = buildRemoteScreenDiscoveryArgs(connection);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  try {
    const { stdout } = await promisify(execFile)(command.file, command.args);
    return parseRemoteScreenList(stdout, connection.alias);
  } catch (error: any) {
    return { status: 'unavailable', host: connection.alias, reason: error?.code === 'ENOENT' ? 'ssh-unavailable' : 'host-unreachable', sessions: [] };
  }
});
ipcMain.handle('screens:attachRemote', (_event, input: unknown, screenName: unknown) => {
  const connection = validateKnownConnection(input);
  if (typeof screenName !== 'string') throw new Error('screenName is required');
  return buildRemoteScreenAttachArgs(connection, screenName);
});

ipcMain.handle('sessions:attach', (_event, id: unknown, size: unknown) => {
  if (typeof id !== 'string' || !id) throw new Error('attachSession requires a session id');
  return service.attach(
    id,
    (data) => win?.webContents.send('terminal:data', id, data),
    (message) => win?.webContents.send('terminal:status', id, message),
    parsePtySize(size)
  );
});

ipcMain.handle('sessions:close', (_event, id: unknown) => {
  if (typeof id !== 'string' || !id) throw new Error('closeSession requires a session id');
  service.close(id);
});

ipcMain.on('terminal:write', (_event, sessionId: unknown, data: unknown) => {
  if (typeof sessionId === 'string' && typeof data === 'string') service.write(sessionId, data);
});

ipcMain.on('terminal:resize', (_event, sessionId: unknown, cols: unknown, rows: unknown) => {
  if (typeof sessionId === 'string' && Number.isInteger(cols) && Number.isInteger(rows)) {
    service.resize(sessionId, cols as number, rows as number);
  }
});

ipcMain.handle('clipboard:writeText', (_event, text: unknown) => {
  if (typeof text !== 'string') throw new Error('clipboard:writeText requires a string');
  // Reject rather than resolve on a lost write: the renderer shows the message
  // in the status bar, so the user is not told text was copied when it was not.
  if (!writeClipboardText(clipboard, text)) {
    throw new Error('Clipboard write failed — another application is holding the clipboard');
  }
});

ipcMain.handle('clipboard:readText', () => clipboard.readText());

/** A string that crossed the IPC boundary and is about to be used as one. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${field} is required.`);
  return value;
}

function requireAiConfig(value: unknown): { baseUrl: string; model: string } {
  if (!isRecord(value)) throw new Error('An AI endpoint is required.');
  return {
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
    model: typeof value.model === 'string' ? value.model : ''
  };
}

/**
 * A suggestion request, shaped.
 *
 * The prompt and the context are checked for type here and for content by
 * buildSuggestionRequest, which is where those rules are tested. The captured
 * output is deliberately not inspected: it is untrusted by design, and
 * ai-protocol is what makes it safe to include.
 */
function requireSuggestionRequest(value: unknown): AiSuggestionRequest {
  if (!isRecord(value)) throw new Error('A request is required.');
  const context = isRecord(value.context) ? value.context : {};
  const text = (field: unknown): string | undefined => (typeof field === 'string' && field ? field : undefined);
  return {
    prompt: typeof value.prompt === 'string' ? value.prompt : '',
    ...(text(value.sessionId) ? { sessionId: String(value.sessionId) } : {}),
    context: {
      ...(text(context.shell) ? { shell: String(context.shell) } : {}),
      ...(text(context.cwd) ? { cwd: String(context.cwd) } : {}),
      ...(text(context.host) ? { host: String(context.host) } : {}),
      ...(context.kind === 'ssh' || context.kind === 'local' ? { kind: context.kind } : {}),
      ...(text(context.output) ? { output: String(context.output) } : {})
    }
  };
}

function requireEntryKind(value: unknown): FileEntry['kind'] {
  if (value === 'file' || value === 'directory' || value === 'symlink') return value;
  throw new Error('An entry kind of file, directory, or symlink is required.');
}

ipcMain.handle('fs:localHome', () => localHome());
ipcMain.handle('fs:listLocal', (_event, path: unknown) => listLocalDirectory(typeof path === 'string' && path ? path : undefined));
ipcMain.handle('fs:mkdirLocal', (_event, path: unknown) => createLocalDirectory(requireString(path, 'A folder path')));
ipcMain.handle('fs:renameLocal', (_event, from: unknown, to: unknown) => renameLocalEntry(requireString(from, 'The current path'), requireString(to, 'The new path')));
ipcMain.handle('fs:removeLocal', (_event, path: unknown, kind: unknown) => removeLocalEntry(requireString(path, 'A path'), requireEntryKind(kind)));

ipcMain.handle('sftp:open', (_event, target: unknown, cwd: unknown) => sftp.open(requireString(target, 'An SSH target'), typeof cwd === 'string' && cwd ? cwd : undefined));
ipcMain.handle('sftp:list', (_event, id: unknown, path: unknown) => sftp.list(requireString(id, 'A transfer connection'), typeof path === 'string' && path ? path : undefined));
ipcMain.handle('sftp:mkdir', (_event, id: unknown, path: unknown) => sftp.mkdir(requireString(id, 'A transfer connection'), requireString(path, 'A folder path')));
ipcMain.handle('sftp:rename', (_event, id: unknown, from: unknown, to: unknown) => sftp.rename(requireString(id, 'A transfer connection'), requireString(from, 'The current path'), requireString(to, 'The new path')));
ipcMain.handle('sftp:remove', (_event, id: unknown, path: unknown, kind: unknown) => sftp.remove(requireString(id, 'A transfer connection'), requireString(path, 'A path'), requireEntryKind(kind)));
ipcMain.handle('sftp:upload', (_event, id: unknown, localPath: unknown, remoteDir: unknown) => sftp.upload(requireString(id, 'A transfer connection'), requireString(localPath, 'A local file'), requireString(remoteDir, 'A remote folder')));
ipcMain.handle('sftp:download', (_event, id: unknown, remotePath: unknown, localDir: unknown, kind: unknown) => sftp.download(requireString(id, 'A transfer connection'), requireString(remotePath, 'A remote path'), requireString(localDir, 'A local folder'), requireEntryKind(kind)));
// The answer is a secret in two of the three cases, so it is passed straight
// through and never returned, logged, or kept.
ipcMain.handle('sftp:answerPrompt', (_event, id: unknown, answer: unknown) => {
  if (typeof answer !== 'string') throw new Error('An answer is required.');
  sftp.answerPrompt(requireString(id, 'A transfer connection'), answer);
});
ipcMain.handle('sftp:close', (_event, id: unknown) => sftp.close(requireString(id, 'A transfer connection')));

// The key is read here, per request, and never handed to the renderer.
const ai = new AiService({ readApiKey: () => secrets.get(AI_API_KEY) });

ipcMain.handle('ai:suggest', (_event, config: unknown, request: unknown) =>
  ai.suggest(requireAiConfig(config), requireSuggestionRequest(request)));
ipcMain.handle('ai:models', (_event, baseUrl: unknown) => ai.listModels(requireString(baseUrl, 'A base URL')));
ipcMain.handle('ai:test', (_event, config: unknown) => ai.test(requireAiConfig(config)));
ipcMain.handle('ai:cancel', () => ai.cancel());

async function aiKeyStatus(): Promise<SpeechApiKeyStatus> {
  return { stored: await secrets.has(AI_API_KEY), encryptionAvailable: secrets.encryptionAvailable() };
}

ipcMain.handle('aiKey:status', () => aiKeyStatus());
ipcMain.handle('aiKey:save', async (_event, key: unknown) => {
  await secrets.set(AI_API_KEY, typeof key === 'string' ? key.trim() : '');
  return aiKeyStatus();
});
ipcMain.handle('aiKey:clear', async () => {
  await secrets.clear(AI_API_KEY);
  return aiKeyStatus();
});

async function speechKeyStatus(): Promise<SpeechApiKeyStatus> {
  return { stored: await secrets.has(SPEECH_API_KEY), encryptionAvailable: secrets.encryptionAvailable() };
}

ipcMain.handle('speechKey:status', () => speechKeyStatus());
ipcMain.handle('speechKey:save', async (_event, key: unknown) => {
  // An empty key means "clear", which SecretStore already does — but the
  // string still has to be a string, and a pasted key often carries newlines.
  await secrets.set(SPEECH_API_KEY, typeof key === 'string' ? key.trim() : '');
  return speechKeyStatus();
});
ipcMain.handle('speechKey:clear', async () => {
  await secrets.clear(SPEECH_API_KEY);
  return speechKeyStatus();
});
ipcMain.handle('speechKey:read', () => secrets.get(SPEECH_API_KEY));

app.whenReady().then(() => {
  // Voice input captures the local microphone only. Electron denies all
  // permission requests unless a handler answers, so grant media explicitly.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });

  // Keep the normal window chrome, but let the ZeroG UI occupy the full
  // client area instead of showing Electron's default File/Edit/etc. menu.
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
