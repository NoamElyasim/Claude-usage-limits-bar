const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settings', {
  get: () => ipcRenderer.invoke('settings-get'),
  set: (patch) => ipcRenderer.invoke('settings-set', patch),
  reset: () => ipcRenderer.invoke('settings-reset'),
  close: () => ipcRenderer.send('settings-close'),
});
