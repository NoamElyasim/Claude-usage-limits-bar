const {
  app, BrowserWindow, Menu, screen, session, ipcMain, desktopCapturer, nativeTheme,
} = require('electron');
const path = require('path');

// Before anything else touches userData: config resolves its path at require
// time, and the cookie jar opens on ready. Both would land in an empty folder
// after the rename if this ran later.
require('./src/migrate')();

const config = require('./src/config');
const auth = require('./src/auth');
const usage = require('./src/usage');
const status = require('./src/status');
const macBackdrop = require('./src/mac-backdrop');

const POLL_MS = 30000;
const STATUS_POLL_MS = 1000;

// Window is wider than the 560px bar so the CSS drop shadow has room to fade
// out inside it, and tall enough for the 224px vertical capsule; the
// body clips anything past the edge. One size for every shape: resizing the
// window mid-morph makes macOS show the old content shifted for a frame. The
// empty area is click-through instead (setInteractive below). Must match
// index.html.
const WIN_W = 640, WIN_H = 280;

const SHAPES = [
  { id: 'bar', label: 'Bar' },
  { id: 'capsule', label: 'Capsule' },
  { id: 'square', label: 'Square' },
  { id: 'circle', label: 'Circle' },
];

// Legacy bootstrap: an existing install may still have its cookies in a file
// next to the app. Imported once into the cookie jar, after which the jar
// (persisted in the user-data dir) is the only source of truth.
const LEGACY_COOKIE_FILES = [
  path.join(app.getPath('userData'), 'claude-cookies.txt'),
  path.join(__dirname, 'claude-cookies.txt'),
  path.join(__dirname, '..', 'claude-cookies.txt'),
];

let win;
let settingsWin = null;

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
  const vibrancy = macBackdrop.available();

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
    // macOS: the system blurs the desktop behind the widget, the way any
    // translucent Mac window does. Clipped to the widget's shape by
    // set-backdrop below. Elsewhere the renderer draws its own captured glass.
    ...(vibrancy && { vibrancy: macBackdrop.MATERIAL, visualEffectState: 'active' }),
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
  // this, the live-glass capture would recursively capture itself. It also
  // hides the bar from screenshots, so only where that capture runs: macOS
  // blurs natively and captures nothing.
  if (process.platform !== 'darwin') win.setContentProtection(true);

  let saveTimer = null;
  win.on('moved', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const b = win.getBounds();
      config.set({ position: { x: b.x, y: b.y } });
    }, 500);
  });

  function sendBounds() {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('bounds-update', boundsPayload());
  }
  win.on('move', sendBounds);
  // Lets the renderer pin the bar to the pointer for the length of a drag; see
  // liveWindow() in index.html.
  win.on('will-move', () => {
    const b = win.getBounds();
    win.webContents.send('drag-start', { cursor: screen.getCursorScreenPoint(), win: { x: b.x, y: b.y } });
  });
  // Dragging to another monitor, a resolution change or hot-plugging a display
  // all invalidate the renderer's capture stream, so it needs to hear about them.
  screen.on('display-metrics-changed', sendBounds);
  screen.on('display-added', sendBounds);
  screen.on('display-removed', sendBounds);

  const popupMenu = () => Menu.buildFromTemplate(menuTemplate()).popup({ window: win });

  // Only fires over the parts of the window that are not a drag region — the
  // transparent margin, and the menu button that opts out with no-drag.
  win.webContents.on('context-menu', popupMenu);
  ipcMain.handle('show-menu', popupMenu);

  // Right-clicking the bar itself cannot reach us at all: a
  // -webkit-app-region: drag surface is hit-tested as the window caption, so
  // Windows treats the click as non-client and raises its own
  // Move/Size/Close menu. hookWindowMessage on WM_NCRBUTTONDOWN and
  // WM_NCRBUTTONUP were both tried — the hook only observes the message, it
  // cannot stop DefWindowProc, and the caption menu wins either way. The
  // menu button above is the way in; undoing this would mean dropping the
  // drag region and moving the window from script instead.

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
    {
      label: 'Shape',
      submenu: SHAPES.map((sh) => ({
        label: sh.label,
        type: 'radio',
        checked: (config.get('shape') || 'bar') === sh.id,
        click: () => {
          config.set({ shape: sh.id });
          win.webContents.send('shape', sh.id);
        },
      })),
    },
    {
      // Only the capsule has a second orientation.
      label: 'Rotate 90°',
      visible: (config.get('shape') || 'bar') === 'capsule',
      click: () => {
        const next = config.get('capsuleOrientation') === 'vertical' ? 'horizontal' : 'vertical';
        config.set({ capsuleOrientation: next });
        win.webContents.send('orientation', next);
      },
    },
    { label: 'Settings…', click: openSettings },
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

  items.push({ type: 'separator' }, { label: 'Quit', click: () => app.quit() });
  return items;
}

// ─── Settings ────────────────────────────────────────────────────────────────
// A small window for how the widget looks: Appearance everywhere, Blur on
// macOS. Every change applies live and is saved straight away.
const APPEARANCES = ['system', 'dark', 'light'];

function settingsState() {
  return {
    appearance: config.get('appearance') || 'system',
    blur: config.get('blur') ?? macBackdrop.BLUR_DEFAULT,
    blurDefault: macBackdrop.BLUR_DEFAULT,
    blurMax: macBackdrop.BLUR_MAX,
    blurAdjustable: macBackdrop.blurAdjustable(),
  };
}

// themeSource drives prefers-color-scheme in both windows and the system
// material behind the widget, so this one switch restyles everything.
function applyAppearance() {
  nativeTheme.themeSource = config.get('appearance') || 'system';
}

function applySettings(patch) {
  const next = {};
  if (APPEARANCES.includes(patch.appearance)) next.appearance = patch.appearance;
  if ('blur' in patch) {
    const b = patch.blur === null ? null : Number(patch.blur);
    if (b === null || Number.isFinite(b)) next.blur = b === null ? null : Math.min(macBackdrop.BLUR_MAX, Math.max(0, b));
  }
  config.set(next);
  if ('appearance' in next) applyAppearance();
  if ('blur' in next) macBackdrop.setBlur(win, config.get('blur') ?? macBackdrop.BLUR_DEFAULT);
  return settingsState();
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    app.focus({ steal: true });
    settingsWin.show();
    return;
  }
  // Centred on whichever display the widget is on.
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const W = 380, H = 210;
  settingsWin = new BrowserWindow({
    width: W, height: H,
    x: Math.round(area.x + (area.width - W) / 2),
    y: Math.round(area.y + (area.height - H) / 3),
    title: 'Settings',
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#262628' : '#ececec',
    webPreferences: {
      preload: path.join(__dirname, 'src', 'settings', 'preload.js'),
      contextIsolation: true,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'src', 'settings', 'settings.html'));
  // No Dock icon, so the app is never active on its own; without stealing
  // focus the window opens behind whatever app is in front.
  settingsWin.once('ready-to-show', () => { app.focus({ steal: true }); settingsWin.show(); });
  settingsWin.on('closed', () => { settingsWin = null; });
}

ipcMain.handle('settings-get', () => settingsState());
ipcMain.handle('settings-set', (_e, patch) => applySettings(patch || {}));
ipcMain.handle('settings-reset', () => applySettings({ appearance: 'system', blur: null }));
ipcMain.on('settings-close', () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); });

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

ipcMain.handle('get-shape', () => config.get('shape') || 'bar');
ipcMain.handle('get-orientation', () => config.get('capsuleOrientation') || 'horizontal');

// Off while the pointer is away from the widget, so clicks on the window's
// transparent margin reach whatever is underneath. The renderer decides, from
// the same per-frame hit-test that drives hover.
ipcMain.on('set-interactive', (_e, on) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!on);
});

// 'vibrancy': macOS blurs behind the window; the renderer only reports the
//             widget's outline (set-backdrop) so the blur can follow it.
// 'none':     macOS without the mask addon; a plain dark fill, no capture.
// 'desktop':  the renderer opens a desktopCapturer stream itself.
ipcMain.handle('get-glass-mode', () => {
  if (process.platform !== 'darwin') return 'desktop';
  return macBackdrop.available() ? 'vibrancy' : 'none';
});

// The widget's outline in window-local DIP, sent whenever it changes: shape
// morphs, the hover detail row unfolding, the hover lift.
ipcMain.on('set-backdrop', (_e, rect) => macBackdrop.setMask(win, rect));

// The renderer needs the pointer to keep it out of the frosted glass, and it
// cannot get it from DOM events: the bar is a -webkit-app-region: drag surface,
// and Chromium delivers no mouse events over a drag region.
ipcMain.handle('get-cursor-point', () => screen.getCursorScreenPoint());

// Pointer and window position in one round trip, both read at call time. The
// glass polls this every frame while it is moving: the renderer's own
// window.screenX only catches up after the browser process relays the move,
// which is late enough to see as the backdrop lagging behind a drag.
ipcMain.handle('get-live-position', () => {
  const b = win && !win.isDestroyed() ? win.getBounds() : null;
  return { cursor: screen.getCursorScreenPoint(), win: b && { x: b.x, y: b.y } };
});

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
    applyAppearance();
    macBackdrop.setBlur(null, config.get('blur') ?? macBackdrop.BLUR_DEFAULT);
    // AppKit rebuilds the blur's layers when the appearance flips, which drops
    // the shape mask and the custom strength; put both back.
    nativeTheme.on('updated', () => setTimeout(() => macBackdrop.refresh(win), 50));
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
