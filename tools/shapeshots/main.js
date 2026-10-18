// Shape screenshots for the README.
//
// The live widget hides itself from every capture API (that is what keeps the
// glass from refracting itself), so it cannot be screenshotted. This loads the
// real index.html with sample usage, a fixed window position, and glass frames
// cut from docs/assets/img/backdrop.webp instead of the screen, then writes:
//
//   docs/shapes.png        every shape side by side
//   docs/shapes-morph.gif  the morph cycle: bar → capsule → vertical → square → circle → bar
//
// Morphs are stepped rather than recorded in real time: each frame restarts
// the morph, pauses every animation and seeks it, so the GIF is smooth no
// matter how slow a capture is.
//
//   npm run shapeshots      (needs ffmpeg on PATH for the GIF)
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const DOCS = path.join(REPO, 'docs');
const WIN = { width: 640, height: 280 };     // main.js WIN_W / WIN_H
const PAD = 100;                             // backdrop beyond the window on each side
const FPS = 30;
const CROP_H = 260;                          // GIF height: down to the vertical capsule's shadow

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shapeshots-'));

// The backdrop, cut and scaled to the window plus PAD all round. The same
// image is the page background (so the widget sits on it seamlessly) and the
// glass frame (so the glass refracts exactly what is behind it).
function backdrop() {
  const png = path.join(TMP, 'backdrop.png');
  execFileSync('sips', ['-s', 'format', 'png', path.join(DOCS, 'assets/img/backdrop.webp'), '--out', png],
    { stdio: 'ignore' });
  const w = WIN.width + PAD * 2, h = WIN.height + PAD * 2;
  const img = nativeImage.createFromPath(png)
    .crop({ x: 600, y: 300, width: w * 2, height: h * 2 })
    .resize({ width: w, height: h, quality: 'best' });
  const out = path.join(TMP, 'bg.png');
  fs.writeFileSync(out, img.toPNG());
  // toBitmap is BGRA on every platform Electron runs on — the order the
  // shader expects from the macOS helper's frames.
  return { file: out, frame: { width: w, height: h, displayId: '1',
    rect: { x: -PAD, y: -PAD, width: w, height: h }, pixels: new Uint8Array(img.toBitmap()) } };
}

let cursor = { x: -1000, y: -1000 };
ipcMain.handle('get-shape', () => 'bar');
ipcMain.handle('get-orientation', () => 'horizontal');
ipcMain.handle('get-bounds', () => ({
  bounds: { x: 0, y: 0, ...WIN }, displayId: '1',
  displayBounds: { x: -2000, y: -2000, width: 6000, height: 6000 }, scaleFactor: 2,
}));
ipcMain.handle('get-live-position', () => ({ cursor, win: { x: 0, y: 0 } }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const bg = backdrop();
  const win = new BrowserWindow({
    ...WIN, show: false, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(REPO, 'index.html'));
  await win.webContents.insertCSS(`html { background: url("file://${bg.file}") -${PAD}px -${PAD}px / ` +
    `${WIN.width + PAD * 2}px ${WIN.height + PAD * 2}px no-repeat !important; }`);
  const js = (code) => win.webContents.executeJavaScript(code);

  // Sample numbers that show two colour stages, and a working session.
  const hour = 3600e3;
  const sat = new Date(); sat.setDate(sat.getDate() + ((6 - sat.getDay() + 7) % 7 || 7)); sat.setHours(21, 0, 0, 0);
  win.webContents.send('usage-update', {
    state: 'ok', session: 37, weekly: 62,
    resetsAt5: new Date(Date.now() + 3 * hour + 42 * 60e3).toISOString(), resetsAt7: sat.toISOString(),
  });
  win.webContents.send('status-update', 'working');
  win.webContents.send('glass-frame', bg.frame);
  await sleep(800);

  const frames = path.join(TMP, 'frames');
  fs.mkdirSync(frames);
  let n = 0;
  async function grab(rect) {
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    return (await win.webContents.capturePage(rect));
  }
  async function frame(times = 1) {
    const png = (await grab({ x: 0, y: 0, width: WIN.width, height: CROP_H }))
      .resize({ width: WIN.width }).toPNG();
    for (let i = 0; i < times; i++) fs.writeFileSync(path.join(frames, `f${String(n++).padStart(5, '0')}.png`), png);
  }

  // Put the widget in a state with no animation.
  async function set(shape, vertical) {
    await js(`document.getAnimations().forEach((a) => a.cancel());
      applyOrientation(${vertical}, false); applyShape('${shape}', false); 1`);
    await sleep(50);
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

  // Stills for the overview, each cropped to its widget plus shadow room.
  const stills = [];
  const labels = { bar: 'Bar', capsule: 'Capsule', square: 'Square', circle: 'Circle' };
  for (const st of cycle.slice(0, 5)) {
    await set(st.shape, st.vertical);
    await sleep(700);
    const r = await js(`(() => { const r = document.getElementById('widget').getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    const m = 22;
    const crop = { x: Math.max(0, Math.floor(r.x - m)), y: 0,
      width: Math.ceil(r.width + m * 2), height: Math.ceil(r.y + r.height + m + 6) };
    const file = path.join(TMP, `still-${stills.length}.png`);
    fs.writeFileSync(file, (await grab(crop)).toPNG());
    stills.push({ file, label: st.vertical ? 'Capsule, rotated' : labels[st.shape], w: crop.width, h: crop.height });
  }

  // The morph cycle.
  await set('bar', false);
  await sleep(500);
  await frame(FPS);   // hold a second on the bar
  for (let i = 0; i < cycle.length - 1; i++) {
    await morph(cycle[i], cycle[i + 1]);
    await set(cycle[i + 1].shape, cycle[i + 1].vertical);
    await sleep(300);
    await frame(Math.round(FPS * 0.8));
  }
  const gif = path.join(DOCS, 'shapes-morph.gif');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS),
    '-i', path.join(frames, 'f%05d.png'),
    '-vf', 'split[a][b];[a]palettegen=max_colors=200:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a',
    gif]);
  console.log('wrote ' + gif);

  // Overview: the stills laid out by a page of their own, then captured.
  const sheet = new BrowserWindow({ width: 1000, height: 400, show: false, useContentSize: true });
  // Inlined: a data: page may not load file:// images.
  const tiles = stills.map((s) => `<figure><img src="data:image/png;base64,${fs.readFileSync(s.file).toString('base64')}" ` +
    `style="width:${s.w}px;height:${s.h}px">` +
    `<figcaption>${s.label}</figcaption></figure>`).join('');
  const bar = tiles.split('</figure>')[0] + '</figure>';
  const rest = tiles.slice(bar.length);
  await sheet.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="
    margin:0;padding:24px;background:#10131a;font:600 13px -apple-system,'Segoe UI',sans-serif;color:#c9d1d9;
    display:flex;flex-direction:column;align-items:center;gap:20px">
    <style>figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:8px}
    img{border-radius:14px;display:block}</style>
    <div>${bar}</div>
    <div style="display:flex;gap:22px;align-items:flex-start">${rest}</div></body></html>`));
  await sleep(500);
  const size = await sheet.webContents.executeJavaScript(
    '({ w: document.body.scrollWidth, h: document.body.scrollHeight })');
  sheet.setContentSize(size.w, size.h);
  await sleep(300);
  const out = path.join(DOCS, 'shapes.png');
  fs.writeFileSync(out, (await sheet.webContents.capturePage()).toPNG());
  console.log('wrote ' + out);

  fs.rmSync(TMP, { recursive: true, force: true });
  app.quit();
});
