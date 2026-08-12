import { app, BrowserWindow, clipboard, ipcMain, Menu, session } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScreenService, discoverShellBackends, parseWslDistributions } from './session-service.js';
import { SessionHistoryStore, defaultHistoryPath } from './session-history.js';
import { buildRemoteScreenAttachArgs, buildRemoteScreenDiscoveryArgs, listKnownConnections, parseRemoteScreenList, validateKnownConnection } from './ssh-inventory.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const history = new SessionHistoryStore({ filePath: defaultHistoryPath(app.getPath('userData')) });
const service = new ScreenService({ onEvent: (event, session, available) => { void history.record(event, session, available); } });
let win: BrowserWindow | undefined;

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
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

ipcMain.handle('sessions:list', () => service.list());
ipcMain.handle('sessions:history', () => history.list());

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

ipcMain.handle('sessions:attach', (_event, id: unknown) => {
  if (typeof id !== 'string' || !id) throw new Error('attachSession requires a session id');
  return service.attach(
    id,
    (data) => win?.webContents.send('terminal:data', id, data),
    (message) => win?.webContents.send('terminal:status', id, message)
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
  clipboard.writeText(text);
});

ipcMain.handle('clipboard:readText', () => clipboard.readText());

ipcMain.handle('ai:suggest', () => ({
  command: 'git status --short',
  explanation: 'Read-only preview of changed files in the active workspace.'
}));

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
