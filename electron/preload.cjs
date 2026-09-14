const { contextBridge, ipcRenderer } = require('electron');
const listen = (channel, callback) => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('projectGrid', {
  getState: () => ipcRenderer.invoke('workspace:state'),
  addProjects: () => ipcRenderer.invoke('workspace:add'),
  removeProject: id => ipcRenderer.invoke('workspace:remove', id),
  acknowledge: id => ipcRenderer.invoke('workspace:acknowledge', id),
  markDone: (id, done) => ipcRenderer.invoke('workspace:done', id, done),
  acknowledgeAll: () => ipcRenderer.invoke('workspace:acknowledge-all'),
  settings: patch => ipcRenderer.invoke('workspace:settings', patch),
  openInCode: (id, relativePath) => ipcRenderer.invoke('project:code', id, relativePath),
  listDirectory: (id, relativePath = '', offset = 0) => ipcRenderer.invoke('project:directory', id, relativePath, offset),
  readFile: (id, relativePath) => ipcRenderer.invoke('project:file', id, relativePath),
  revealProject: id => ipcRenderer.invoke('project:reveal', id),
  startTerminal: id => ipcRenderer.invoke('terminal:start', id),
  restartTerminal: id => ipcRenderer.invoke('terminal:restart', id),
  attachTerminal: id => ipcRenderer.invoke('terminal:attach', id),
  launchCodex: id => ipcRenderer.invoke('terminal:codex', id),
  writeTerminal: (id, data) => ipcRenderer.send('terminal:write', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
  copy: text => ipcRenderer.invoke('clipboard:copy', text),
  onState: callback => listen('workspace:changed', callback),
  onTerminalData: callback => listen('terminal:data', callback),
  onFocusProject: callback => listen('project:focus', callback),
  onError: callback => listen('app:error', callback),
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  focusMode: enabled => ipcRenderer.send('window:focus-mode', enabled),
  quit: () => ipcRenderer.invoke('app:quit'),
});
