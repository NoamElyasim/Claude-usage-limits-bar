const {
  app, BrowserWindow, Menu, screen, shell, systemPreferences,
  session, ipcMain, desktopCapturer,
} = require('electron');
const path = require('path');

const config = require('./src/config');
const auth = require('./src/auth');
const usage = require('./src/usage');
const status = require('./src/status');

const POLL_MS = 30000;
const STATUS_POLL_MS = 1000;

// Window is wider than the 560px bar so the CSS drop shadow has room to fade
// out inside it; the body clips anything past the edge. Must match index.html.
const WIN_W = 640, WIN_H = 130;

// Legacy bootstrap: an existing install may still have its cookies in a file
// next to the app. Imported once into the cookie jar, after which the jar
// (persisted in the user-data dir) is the only source of truth.
const LEGACY_COOKIE_FILES = [
  path.join(app.getPath('userData'), 'claude-cookies.txt'),
  path.join(__dirname, 'claude-cookies.txt'),
  path.join(__dirname, '..', 'claude-cookies.txt'),
];

let win;

// ─── Window placement ────────────────────────────────────────────────────────
function defaultPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + (workArea.width - WIN_W) / 2),
    y: workArea.y,
  };
}

// A saved position can point off-screen after a monitor is unplugged or a
// laptop is docked somewhere else, which would leave the bar invisible with no
// way to drag it back.
function clampToDisplay(pos) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return defaultPosition();
  const area = screen.getDisplayMatching({ x: pos.x, y: pos.y, width: WIN_W, height: WIN_H }).workArea;
  const visible = pos.x + WIN_W > area.x && pos.x < area.x + area.width &&
                  pos.y + WIN_H > area.y && pos.y < area.y + area.height;
  return visible ? pos : defaultPosition();
}

function createWindow() {
  const pos = clampToDisplay(config.get('position'));

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false, // shadow is drawn in CSS to follow the pill shape
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  win.loadFile('index.html');
  win.setAlwaysOnTop(true, 'screen-saver');
  // Keeps the bar visible across Spaces and over fullscreen apps on macOS;
  // no-op elsewhere.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Excludes this window from desktopCapturer's own screen capture — without
  // this, the live-glass capture would recursively capture itself.
  win.setContentProtection(true);

  let saveTimer = null;
  win.on('moved', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const b = win.getBounds();
      config.set({ position: { x: b.x, y: b.y } });
    }, 500);
  });

  function sendBounds() {
    if (win && !win.isDestroyed()) win.webContents.send('bounds-update', boundsPayload());
  }
  win.on('move', sendBounds);
  // Dragging to another monitor, a resolution change or hot-plugging a display
  // all invalidate the renderer's capture stream, so it needs to hear about them.
  screen.on('display-metrics-changed', sendBounds);
  screen.on('display-added', sendBounds);
  screen.on('display-removed', sendBounds);

  win.webContents.on('context-menu', () => Menu.buildFromTemplate(menuTemplate()).popup());

  win.webContents.once('did-finish-load', () => {
    sendBounds();
    // Safety net: 'move' covers dragging, but a failed capture attach or a
    // stream that ended on its own would otherwise never be retried.
    setInterval(sendBounds, 2000);
    pushUsage();
    setInterval(pushUsage, POLL_MS);
    pushStatus();
    setInterval(pushStatus, STATUS_POLL_MS);
  });
}

// ─── Polling ─────────────────────────────────────────────────────────────────
async function pushUsage() {
  const data = await usage.fetchUsage();
  if (win && !win.isDestroyed()) win.webContents.send('usage-update', data);
}

let statusBusy = false;
async function pushStatus() {
  if (statusBusy) return; // never stack a reader on a stuck WSL share read
  statusBusy = true;
  let st = null;
  try { st = await status.readStatus(); } catch (_) {}
  statusBusy = false;
  if (win && !win.isDestroyed()) win.webContents.send('status-update', st);
}

// ─── Menu ────────────────────────────────────────────────────────────────────
function setLoginItem(on) {
  if (process.platform === 'linux') return;
  try {
    app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
  } catch (e) {
    console.error('could not set login item', e);
  }
}

function menuTemplate() {
  const items = [
    { label: 'Refresh now', click: pushUsage },
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: win.isAlwaysOnTop(),
      click: () => win.setAlwaysOnTop(!win.isAlwaysOnTop(), 'screen-saver'),
    },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: config.get('openAtLogin'),
      click: (item) => {
        config.set({ openAtLogin: item.checked });
        setLoginItem(item.checked);
      },
      // Electron only implements login items on macOS and Windows.
      visible: process.platform !== 'linux',
    },
    {
      label: 'Reset position',
      click: () => {
        const p = defaultPosition();
        win.setPosition(p.x, p.y);
        config.set({ position: p });
      },
    },
    { type: 'separator' },
    {
      label: 'Sign in to Claude…',
      click: async () => { if (await auth.signIn()) pushUsage(); },
    },
    {
      label: 'Sign out',
      click: async () => { await auth.signOut(); pushUsage(); },
    },
  ];

  // Screen recording is the one permission the live-glass refraction needs, and
  // macOS only grants it from System Settings.
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    items.push({
      label: 'Allow screen recording…',
      click: () => shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'),
    });
  }

  items.push({ type: 'separator' }, { label: 'Quit', click: () => app.quit() });
  return items;
}

// ─── Live-glass screen source (feeds the WebGL refraction shader in index.html) ─
// Everything the renderer needs to crop the capture to the widget: which display
// it currently sits on, that display's origin/size, and its scale factor. Sent on
// every move so the shader keeps working across monitors with different DPI.
function boundsPayload() {
  const bounds = win.getBounds();
  const disp = screen.getDisplayMatching(bounds);
  return {
    bounds,
    displayId: String(disp.id),
    displayBounds: disp.bounds,
    scaleFactor: disp.scaleFactor,
  };
}

ipcMain.handle('get-bounds', () => boundsPayload());

// The renderer needs the pointer to keep it out of the frosted glass, and it
// cannot get it from DOM events: the bar is a -webkit-app-region: drag surface,
// and Chromium delivers no mouse events over a drag region.
ipcMain.handle('get-cursor-point', () => screen.getCursorScreenPoint());

ipcMain.handle('get-screen-source', async (_e, displayId) => {
  const displays = screen.getAllDisplays();
  const disp = (displayId && displays.find((d) => String(d.id) === String(displayId)))
    || screen.getDisplayMatching(win.getBounds());
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  let match = sources.find((s) => s.display_id && s.display_id === String(disp.id));
  if (!match) {
    // display_id comes back empty on some Windows drivers, which used to fall
    // through to sources[0] — always the primary, so a widget on the second
    // monitor sampled the wrong screen. Fall back to positional order instead,
    // which lines up with screen.getAllDisplays().
    const idx = displays.findIndex((d) => d.id === disp.id);
    match = sources[idx >= 0 ? idx : 0] || sources[0];
  }
  return {
    sourceId: match ? match.id : null,
    displayId: String(disp.id),
    scaleFactor: disp.scaleFactor,
    displayBounds: disp.bounds,
  };
});

// ─── Startup ─────────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.showInactive();
  });

  app.whenReady().then(async () => {
    // No dock icon on macOS: this is an accessory window, not an app you switch
    // to. (Packaged builds also set LSUIElement so it never appears at all.)
    if (process.platform === 'darwin' && app.dock) app.dock.hide();

    session.defaultSession.setUserAgent(auth.UA);
    setLoginItem(!!config.get('openAtLogin'));

    if (!(await auth.hasSession())) await auth.importCookieFile(LEGACY_COOKIE_FILES);

    createWindow();

    // Nothing to show without a session, so ask for one instead of sitting on
    // an empty bar. Only on a genuinely cold start — never on later failures,
    // which are usually transient network errors.
    if (!(await auth.hasSession())) {
      if (await auth.signIn()) pushUsage();
    }
  });

  app.on('window-all-closed', () => app.quit());
}
