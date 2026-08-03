// Same API surface as the app's preload.js, but the cursor is scripted by the
// test instead of coming from the OS.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usage', {
  onUpdate: () => {},
  onStatus: () => {},
});

contextBridge.exposeInMainWorld('glass', {
  getScreenSource: (displayId) => ipcRenderer.invoke('get-screen-source', displayId),
  getBounds: () => ipcRenderer.invoke('get-bounds'),
  onBounds: (cb) => ipcRenderer.on('bounds-update', (_e, payload) => cb(payload)),
  cursorPoint: () => ipcRenderer.invoke('get-cursor-point'),
});
