// Same API surface as the app's preload.js, fed by tools/shapeshots/main.js
// instead of the OS: a fixed window position, a scripted pointer, and the
// widget's outline passed on to the real macOS blur mask.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usage', {
  onUpdate: (cb) => ipcRenderer.on('usage-update', (_e, data) => cb(data)),
  onStatus: (cb) => ipcRenderer.on('status-update', (_e, st) => cb(st)),
});

contextBridge.exposeInMainWorld('overlay', {
  showMenu: () => {},
  getShape: () => ipcRenderer.invoke('get-shape'),
  onShape: () => {},
  getOrientation: () => ipcRenderer.invoke('get-orientation'),
  onOrientation: () => {},
  setInteractive: () => {},
});

contextBridge.exposeInMainWorld('glass', {
  getBounds: () => ipcRenderer.invoke('get-bounds'),
  onBounds: () => {},
  cursorPoint: () => ipcRenderer.invoke('get-live-position').then((p) => p.cursor),
  livePosition: () => ipcRenderer.invoke('get-live-position'),
  mode: () => Promise.resolve('vibrancy'),
  setBackdrop: (rect) => ipcRenderer.send('set-backdrop', rect),
});
