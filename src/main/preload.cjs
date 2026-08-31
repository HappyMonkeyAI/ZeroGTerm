const { contextBridge, ipcRenderer } = require('electron');

const api = {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  listHistory: () => ipcRenderer.invoke('sessions:history'),
  removeHistory: (entryId) => ipcRenderer.invoke('sessions:historyRemove', entryId),
  listForwards: () => ipcRenderer.invoke('forwards:list'),
  openForward: (request) => ipcRenderer.invoke('forwards:open', request),
  closeForward: (id) => ipcRenderer.invoke('forwards:close', id),
  answerForwardPrompt: (id, answer) => ipcRenderer.invoke('forwards:answerPrompt', id, answer),
  loadForwards: () => ipcRenderer.invoke('forwards:load'),
  saveForwards: (file) => ipcRenderer.invoke('forwards:save', file),
  onForwardEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('forwards:event', listener);
    return () => ipcRenderer.removeListener('forwards:event', listener);
  },
  loadWorkspaces: () => ipcRenderer.invoke('workspaces:load'),
  saveWorkspaces: (file) => ipcRenderer.invoke('workspaces:save', file),
  listBackends: () => ipcRenderer.invoke('sessions:backends'),
  listWslDistributions: () => ipcRenderer.invoke('sessions:wslDistributions'),
  createLocalSession: (request) => ipcRenderer.invoke('sessions:createLocal', request),
  createSshSession: (request) => ipcRenderer.invoke('sessions:createSsh', request),
  listKnownConnections: () => ipcRenderer.invoke('connections:listKnown'),
  discoverRemoteScreens: (connection) => ipcRenderer.invoke('screens:discoverRemote', connection),
  buildRemoteScreenAttach: (connection, screenName) => ipcRenderer.invoke('screens:attachRemote', connection, screenName),
  attachSession: (id, size) => ipcRenderer.invoke('sessions:attach', id, size),
  closeSession: (id) => ipcRenderer.invoke('sessions:close', id),
  write: (sessionId, data) => ipcRenderer.send('terminal:write', sessionId, data),
  resize: (sessionId, cols, rows) => ipcRenderer.send('terminal:resize', sessionId, cols, rows),
  copyText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  readText: () => ipcRenderer.invoke('clipboard:readText'),
  onData: (callback) => {
    const listener = (_event, sessionId, data) => callback(sessionId, data);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onStatus: (callback) => {
    const listener = (_event, sessionId, message) => callback(sessionId, message);
    ipcRenderer.on('terminal:status', listener);
    return () => ipcRenderer.removeListener('terminal:status', listener);
  },
  requestAiCommand: (config, request) => ipcRenderer.invoke('ai:suggest', config, request),
  listAiModels: (baseUrl) => ipcRenderer.invoke('ai:models', baseUrl),
  testAiEndpoint: (config) => ipcRenderer.invoke('ai:test', config),
  cancelAiRequest: () => ipcRenderer.invoke('ai:cancel'),
  aiApiKeyStatus: () => ipcRenderer.invoke('aiKey:status'),
  saveAiApiKey: (key) => ipcRenderer.invoke('aiKey:save', key),
  clearAiApiKey: () => ipcRenderer.invoke('aiKey:clear'),
  listLocalDirectory: (path) => ipcRenderer.invoke('fs:listLocal', path),
  localHome: () => ipcRenderer.invoke('fs:localHome'),
  createLocalDirectory: (path) => ipcRenderer.invoke('fs:mkdirLocal', path),
  renameLocalEntry: (from, to) => ipcRenderer.invoke('fs:renameLocal', from, to),
  removeLocalEntry: (path, kind) => ipcRenderer.invoke('fs:removeLocal', path, kind),
  sftpOpen: (target, cwd) => ipcRenderer.invoke('sftp:open', target, cwd),
  sftpList: (sessionId, path) => ipcRenderer.invoke('sftp:list', sessionId, path),
  sftpMkdir: (sessionId, path) => ipcRenderer.invoke('sftp:mkdir', sessionId, path),
  sftpRename: (sessionId, from, to) => ipcRenderer.invoke('sftp:rename', sessionId, from, to),
  sftpRemove: (sessionId, path, kind) => ipcRenderer.invoke('sftp:remove', sessionId, path, kind),
  sftpUpload: (sessionId, localPath, remoteDir) => ipcRenderer.invoke('sftp:upload', sessionId, localPath, remoteDir),
  sftpDownload: (sessionId, remotePath, localDir, kind) => ipcRenderer.invoke('sftp:download', sessionId, remotePath, localDir, kind),
  sftpAnswerPrompt: (sessionId, answer) => ipcRenderer.invoke('sftp:answerPrompt', sessionId, answer),
  sftpClose: (sessionId) => ipcRenderer.invoke('sftp:close', sessionId),
  onSftpEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('sftp:event', listener);
    return () => ipcRenderer.removeListener('sftp:event', listener);
  },
  speechApiKeyStatus: () => ipcRenderer.invoke('speechKey:status'),
  saveSpeechApiKey: (key) => ipcRenderer.invoke('speechKey:save', key),
  clearSpeechApiKey: () => ipcRenderer.invoke('speechKey:clear'),
  readSpeechApiKey: () => ipcRenderer.invoke('speechKey:read'),
  openExternal: (url) => ipcRenderer.invoke('links:openExternal', url),
  onLinkRefused: (callback) => {
    const listener = (_event, reason) => callback(reason);
    ipcRenderer.on('links:refused', listener);
    return () => ipcRenderer.removeListener('links:refused', listener);
  }
};

contextBridge.exposeInMainWorld('zerog', api);
