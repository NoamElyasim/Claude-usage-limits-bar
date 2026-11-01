// README images, recorded from the real widget with the real macOS blur.
//
// A window showing docs/assets/img/backdrop.webp is put on screen, the widget
// (the app's own index.html, vibrancy and blur mask) floats above it, and each
// image is a screen capture of a region that window fully covers — so nothing
// of the actual desktop ever lands in a file. Writes:
//
//   docs/shapes-morph.gif   hover, then the morph cycle: bar → capsule → vertical → square → circle → bar
//   docs/shapes.png         every shape side by side
//   docs/looks.png          Dark and Light, then Blur from clear to heavy
//   docs/settings-dark.png  the Settings window, in each appearance
//   docs/settings-light.png
//
// Animations are stepped rather than recorded in real time: each frame
// restarts the transition, pauses every animation and seeks it, so the GIF is
// smooth however slow a capture is.
//
//   npm run shapeshots      (macOS only; needs ffmpeg on PATH, and Screen
//                            Recording permission for the terminal it runs from)
//
// The windows sit on the primary display for about a minute while it runs.
const { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, screen } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const macBackdrop = require('../../src/mac-backdrop');

const REPO = path.join(__dirname, '..', '..');
const DOCS = path.join(REPO, 'docs');
const WIN = { width: 640, height: 280 };     // main.js WIN_W / WIN_H
const PAD = 100;                             // backdrop beyond the window on each side
const FPS = 30;
const CROP_H = 260;                          // GIF height: down to the vertical capsule's shadow
const GIF_W = 960;                           // 1.5x: sharp on Retina at the README's 640px

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shapeshots-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== 'darwin' || !macBackdrop.available()) {
  console.error('shapeshots records the macOS blur: run it on a Mac after `npm run build:native`.');
  process.exit(1);
}

// The backdrop at 2x, for the backdrop window's background.
function backdropFile() {
  const png = path.join(TMP, 'backdrop.png');
  execFileSync('sips', ['-s', 'format', 'png', path.join(DOCS, 'assets/img/backdrop.webp'), '--out', png],
    { stdio: 'ignore' });
  return png;
}

let origin;                                   // widget window's top-left, global DIP
let cursor = { x: -1000, y: -1000 };
ipcMain.handle('get-shape', () => 'bar');
ipcMain.handle('get-orientation', () => 'horizontal');
ipcMain.handle('get-bounds', () => {
  const d = screen.getPrimaryDisplay();
  return { bounds: { ...origin, ...WIN }, displayId: String(d.id), displayBounds: d.bounds, scaleFactor: d.scaleFactor };
});
ipcMain.handle('get-live-position', () => ({ cursor, win: origin }));

// Settings window, backed by a plain object instead of config.json.
const settings = { appearance: 'dark', blur: macBackdrop.BLUR_DEFAULT };
ipcMain.handle('settings-get', () => ({
  ...settings, blurDefault: macBackdrop.BLUR_DEFAULT, blurMax: macBackdrop.BLUR_MAX, blurAdjustable: true,
}));
ipcMain.handle('settings-set', () => null);
ipcMain.handle('settings-reset', () => null);
ipcMain.on('settings-close', () => {});

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  nativeTheme.themeSource = 'dark';
  const area = screen.getPrimaryDisplay().workArea;
  origin = {
    x: Math.round(area.x + (area.width - WIN.width) / 2),
    y: Math.round(area.y + (area.height - WIN.height) / 2),
  };

  // Behind the widget: the backdrop, in a window that never takes focus (so
  // Stage Manager leaves the user's windows alone).
  const bgFile = backdropFile();
  const bgWin = new BrowserWindow({
    x: origin.x - PAD, y: origin.y - PAD, width: WIN.width + PAD * 2, height: WIN.height + PAD * 2,
    frame: false, resizable: false, focusable: false, skipTaskbar: true, hasShadow: false,
    enableLargerThanScreen: true, show: false, backgroundColor: '#000000',
  });
  bgWin.setAlwaysOnTop(true, 'pop-up-menu');
  // A file: page, since a data: page may not load the file:// image.
  const bgPage = path.join(TMP, 'backdrop.html');
  fs.writeFileSync(bgPage, '<!doctype html><body style="margin:0;overflow:hidden;background:#000">');
  await bgWin.loadFile(bgPage);
  // Which pixel of backdrop.webp (2400×1400) sits at the window's top-left,
  // and how many image pixels make one DIP: 2 shows it whole and soft, 1
  // closer up, so its thin lines and highlights read through the glass.
  async function showBackdrop(at, density = 2) {
    await bgWin.webContents.executeJavaScript(`document.body.style.background =
      'url("file://${bgFile}") -${at.x / density}px -${at.y / density}px / ' +
      '${2400 / density}px ${1400 / density}px no-repeat'; 1`);
  }
  // Crisp stripes for the blur comparison: the photo is too soft to show
  // the difference between clear and heavy.
  async function showStripes() {
    // A gradient is sized to its element, and the empty page is 0px tall.
    await bgWin.webContents.executeJavaScript(`document.body.style.background = 'none';
      document.documentElement.style.height = '100%';
      document.documentElement.style.background =
      'repeating-linear-gradient(-35deg, #f2994a 0 9px, #10131a 9px 18px, #2ec4b6 18px 27px, ' +
      '#10131a 27px 36px, #ffffff 36px 40px, #10131a 40px 50px, #9b5de5 50px 59px, #10131a 59px 68px)'; 1`);
  }
  await showBackdrop({ x: 600, y: 300 });
  bgWin.showInactive();

  const win = new BrowserWindow({
    ...origin, ...WIN, frame: false, transparent: true, resizable: false, focusable: false,
    skipTaskbar: true, hasShadow: false, show: false,
    vibrancy: macBackdrop.MATERIAL, visualEffectState: 'active',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  ipcMain.on('set-backdrop', (_e, rect) => macBackdrop.setMask(win, rect));
  await win.loadFile(path.join(REPO, 'index.html'));
  win.showInactive();
  const js = (code) => win.webContents.executeJavaScript(code);

  // Sample numbers that show two colour stages, and a working session.
  const hour = 3600e3;
  const sat = new Date(); sat.setDate(sat.getDate() + ((6 - sat.getDay() + 7) % 7 || 7)); sat.setHours(21, 0, 0, 0);
  win.webContents.send('usage-update', {
    state: 'ok', session: 37, weekly: 62,
    resetsAt5: new Date(Date.now() + 3 * hour + 42 * 60e3).toISOString(), resetsAt7: sat.toISOString(),
  });
  win.webContents.send('status-update', 'working');
  macBackdrop.setBlur(win, macBackdrop.BLUR_DEFAULT);
  await sleep(1200);

  // Screen capture of a window-local rect, at the display's full resolution.
  let shotN = 0;
  async function shoot(rect) {
    // Two frames for the page, then time for the mask to reach the window server.
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await sleep(70);
    const file = path.join(TMP, `shot-${shotN++}.png`);
    execFileSync('screencapture', ['-x', '-R' + [origin.x + rect.x, origin.y + rect.y, rect.width, rect.height].join(','), file]);
    return file;
  }

  const frames = path.join(TMP, 'frames');
  fs.mkdirSync(frames);
  let n = 0;
  async function frame(times = 1) {
    const file = await shoot({ x: 0, y: 0, width: WIN.width, height: CROP_H });
    for (let i = 0; i < times; i++) fs.copyFileSync(file, path.join(frames, `f${String(n++).padStart(5, '0')}.png`));
  }

  // Put the widget in a state with no animation.
  async function set(shape, vertical) {
    await js(`document.getAnimations().forEach((a) => a.cancel());
      applyOrientation(${vertical}, false); applyShape('${shape}', false); 1`);
    await sleep(50);
  }

  const widgetRect = () => js(`(() => { const r = document.getElementById('widget').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);

  // Pointer on or off the widget; hover is hit-tested from it every frame.
  async function hover(on) {
    const r = await widgetRect();
    cursor = on ? { x: origin.x + r.x + r.width * 0.3, y: origin.y + r.y + r.height / 2 } : { x: -1000, y: -1000 };
    await js(`new Promise((r) => { const want = ${on}; (function wait() {
      if (document.getElementById('widget').classList.contains('hovered') === want) r(); else requestAnimationFrame(wait);
    })(); })`);
  }

  // A hover transition, stepped like the morphs.
  async function hoverStep(on) {
    const ms = 300;
    for (let t = 0; t <= ms; t += 1000 / FPS) {
      await hover(!on);
      await js('document.getAnimations().forEach((a) => a.finish()); 1');
      await hover(on);
      await js(`document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ${t}; }); 1`);
      await frame();
    }
    await js('document.getAnimations().forEach((a) => a.finish()); 1');
  }

  // One morph, stepped: restart it for every frame and seek everything to t.
  // The rings' draw-in starts on a 110ms timer, so its clock runs that far behind.
  async function morph(from, to) {
    const ms = 600;
    for (let t = 0; t <= ms; t += 1000 / FPS) {
      await set(from.shape, from.vertical);
      const trigger = from.shape !== to.shape
        ? `applyShape('${to.shape}', true)`
        : `applyOrientation(${to.vertical}, true)`;
      await js(`${trigger}; document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 0; }); 1`);
      await sleep(140);
      await js(`document.getAnimations().forEach((a) => { a.pause();
        a.currentTime = a.transitionProperty === 'stroke-dasharray' ? Math.max(0, ${t} - 110) : ${t}; }); 1`);
      await frame();
    }
    await js('document.getAnimations().forEach((a) => a.finish()); 1');
  }

  const cycle = [
    { shape: 'bar', vertical: false },
    { shape: 'capsule', vertical: false },
    { shape: 'capsule', vertical: true },
    { shape: 'square', vertical: false },
    { shape: 'circle', vertical: false },
    { shape: 'bar', vertical: false },
  ];

  // A widget-sized crop with room for its shadow and some backdrop around it.
  async function still(margin = 22) {
    await sleep(700);
    const r = await widgetRect();
    return shoot({ x: Math.max(0, Math.floor(r.x - margin)), y: 0,
      width: Math.ceil(r.width + margin * 2), height: Math.ceil(r.y + r.height + margin + 6) });
  }

  // ── Stills of every shape ──
  const shapeTiles = [];
  const labels = { bar: 'Bar', capsule: 'Capsule', square: 'Square', circle: 'Circle' };
  for (const st of cycle.slice(0, 5)) {
    await set(st.shape, st.vertical);
    shapeTiles.push({ file: await still(), label: st.vertical ? 'Capsule, rotated' : labels[st.shape] });
  }

  // ── The GIF: hover on the bar, then the morph cycle ──
  await set('bar', false);
  await sleep(500);
  await frame(FPS);                      // hold a second on the bar
  await hoverStep(true);
  await frame(Math.round(FPS * 1.4));    // reset times showing
  await hoverStep(false);
  await frame(Math.round(FPS * 0.5));
  for (let i = 0; i < cycle.length - 1; i++) {
    await morph(cycle[i], cycle[i + 1]);
    await set(cycle[i + 1].shape, cycle[i + 1].vertical);
    await sleep(300);
    await frame(Math.round(FPS * 0.8));
  }
  const gif = path.join(DOCS, 'shapes-morph.gif');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS),
    '-i', path.join(frames, 'f%05d.png'),
    '-vf', `scale=${GIF_W}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=200:stats_mode=diff[p];` +
      '[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
    gif]);
  console.log('wrote ' + gif);

  // ── Looks: appearance over the photo, then blur strength over stripes ──
  await set('capsule', false);
  await showBackdrop({ x: 1540, y: 696 }, 1);
  const lookTiles = { appearance: [], blur: [] };
  for (const [mode, label] of [['dark', 'Dark'], ['light', 'Light']]) {
    nativeTheme.themeSource = mode;
    await sleep(300);
    macBackdrop.refresh(win);
    lookTiles.appearance.push({ file: await still(40), label });
  }
  nativeTheme.themeSource = 'dark';
  await showStripes();
  await sleep(300);
  macBackdrop.refresh(win);
  for (const [radius, label] of [[0, 'Clear'], [8, 'Soft'], [macBackdrop.BLUR_MAX, 'Heavy']]) {
    macBackdrop.setBlur(win, radius);
    lookTiles.blur.push({ file: await still(40), label });
  }

  // ── Settings window, in each appearance ──
  win.hide();
  bgWin.hide();
  for (const mode of ['dark', 'light']) {
    nativeTheme.themeSource = mode;
    settings.appearance = mode;
    const sw = new BrowserWindow({
      width: 380, height: 210, title: 'Settings', resizable: false, minimizable: false,
      maximizable: false, fullscreenable: false, focusable: false, show: false,
      backgroundColor: mode === 'dark' ? '#262628' : '#ececec',
      webPreferences: { preload: path.join(REPO, 'src', 'settings', 'preload.js'), contextIsolation: true },
    });
    await sw.loadFile(path.join(REPO, 'src', 'settings', 'settings.html'));
    sw.showInactive();
    await sleep(800);
    const id = sw.getMediaSourceId().split(':')[1];
    const out = path.join(DOCS, `settings-${mode}.png`);
    execFileSync('screencapture', ['-x', '-l' + id, out]);
    sw.destroy();
    console.log('wrote ' + out);
  }

  // ── Sheets: stills laid out by a page of their own, then captured ──
  const uri = (f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
  const tile = (t) => {
    const img = nativeImage.createFromPath(t.file).getSize();   // 2x pixels
    return `<figure><img src="${uri(t.file)}" style="width:${img.width / 2}px;height:${img.height / 2}px">` +
      `<figcaption>${t.label}</figcaption></figure>`;
  };
  async function sheet(rows, out) {
    const w = new BrowserWindow({ width: 1000, height: 400, show: false, useContentSize: true });
    // Inlined: a data: page may not load file:// images.
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="
      margin:0;padding:24px;background:#10131a;font:600 13px -apple-system,'Segoe UI',sans-serif;color:#c9d1d9;
      display:flex;flex-direction:column;align-items:center;gap:22px">
      <style>figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:8px}
      img{border-radius:14px;display:block} h3{margin:0;font-size:12px;letter-spacing:.08em;color:#7d8590}
      .row{display:flex;gap:22px;align-items:flex-start;justify-content:center}</style>
      ${rows.map((r) => (r.title ? `<h3>${r.title}</h3>` : '') + `<div class="row">${r.tiles.map(tile).join('')}</div>`).join('')}
      </body></html>`));
    await sleep(500);
    const size = await w.webContents.executeJavaScript('({ w: document.body.scrollWidth, h: document.body.scrollHeight })');
    w.setContentSize(size.w, size.h);
    await sleep(300);
    fs.writeFileSync(out, (await w.webContents.capturePage()).toPNG());
    w.destroy();
    console.log('wrote ' + out);
  }
  await sheet([{ tiles: shapeTiles.slice(0, 1) }, { tiles: shapeTiles.slice(1) }], path.join(DOCS, 'shapes.png'));
  await sheet([
    { title: 'APPEARANCE', tiles: lookTiles.appearance },
    { title: 'BLUR', tiles: lookTiles.blur },
  ], path.join(DOCS, 'looks.png'));

  fs.rmSync(TMP, { recursive: true, force: true });
  app.quit();
});
