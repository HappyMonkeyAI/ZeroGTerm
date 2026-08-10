const { contextBridge, ipcRenderer } = require('electron');

const api = {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  createLocalSession: (request) => ipcRenderer.invoke('sessions:createLocal', request),
  createSshSession: (request) => ipcRenderer.invoke('sessions:createSsh', request),
  attachSession: (id) => ipcRenderer.invoke('sessions:attach', id),
  write: (data) => ipcRenderer.send('terminal:write', data),
  resize: (cols, rows) => ipcRenderer.send('terminal:resize', cols, rows),
  copyText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  readText: () => ipcRenderer.invoke('clipboard:readText'),
  onData: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onStatus: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('terminal:status', listener);
    return () => ipcRenderer.removeListener('terminal:status', listener);
  },
  requestAiCommand: () => ipcRenderer.invoke('ai:suggest')
};

contextBridge.exposeInMainWorld('zerog', api);
