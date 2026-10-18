const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usage', {
  onUpdate: (cb) => ipcRenderer.on('usage-update', (_e, data) => cb(data)),
  onStatus: (cb) => ipcRenderer.on('status-update', (_e, st) => cb(st)),
});

contextBridge.exposeInMainWorld('overlay', {
  showMenu: () => ipcRenderer.invoke('show-menu'),
  getShape: () => ipcRenderer.invoke('get-shape'),
  onShape: (cb) => ipcRenderer.on('shape', (_e, shape) => cb(shape)),
  getOrientation: () => ipcRenderer.invoke('get-orientation'),
  onOrientation: (cb) => ipcRenderer.on('orientation', (_e, o) => cb(o)),
  setInteractive: (on) => ipcRenderer.send('set-interactive', !!on),
});

contextBridge.exposeInMainWorld('glass', {
  getScreenSource: (displayId) => ipcRenderer.invoke('get-screen-source', displayId),
  getBounds: () => ipcRenderer.invoke('get-bounds'),
  cursorPoint: () => ipcRenderer.invoke('get-cursor-point'),
  livePosition: () => ipcRenderer.invoke('get-live-position'),
  onDragStart: (cb) => ipcRenderer.on('drag-start', (_e, p) => cb(p)),
  onBounds: (cb) => ipcRenderer.on('bounds-update', (_e, payload) => cb(payload)),
  mode: () => ipcRenderer.invoke('get-glass-mode'),
  onFrame: (cb) => ipcRenderer.on('glass-frame', (_e, frame) => cb(frame)),
});
