const { contextBridge, ipcRenderer } = require('electron');

const api = {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  listHistory: () => ipcRenderer.invoke('sessions:history'),
  removeHistory: (entryId) => ipcRenderer.invoke('sessions:historyRemove', entryId),
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
  requestAiCommand: () => ipcRenderer.invoke('ai:suggest')
};

contextBridge.exposeInMainWorld('zerog', api);
