// Hover hit-test regression check.
//
// The bar is a -webkit-app-region: drag surface, so CSS :hover can never match
// on it and the expand-on-hover has to be hit-tested in script. That is easy to
// break silently and impossible to see on the live bar (contentProtection hides
// it from every capture API), so this loads the real index.html with a scripted
// cursor and asserts the state it should reach.
//
//   npm run hovertest
const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const WIN = { x: 600, y: 600, width: 640, height: 130 };

// Scripted pointer. Every 'get-cursor-point' returns whatever this holds.
let cursor = { x: 0, y: 0 };
ipcMain.handle('get-cursor-point', () => cursor);

// Whether the glass path is live. Off exercises the no-glass fallback, where
// initGlass bails early — hover must still work there.
const WITH_GLASS = process.env.NO_GLASS !== '1';

let win;
function boundsPayload() {
  const bounds = win.getBounds();
  const disp = screen.getDisplayMatching(bounds);
  return { bounds, displayId: String(disp.id), displayBounds: disp.bounds, scaleFactor: disp.scaleFactor };
}
ipcMain.handle('get-bounds', () => boundsPayload());
ipcMain.handle('get-screen-source', async () => {
  if (!WITH_GLASS) throw new Error('hovertest: capture disabled');
  const disp = screen.getDisplayMatching(win.getBounds());
  const displays = screen.getAllDisplays();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const idx = displays.findIndex((d) => d.id === disp.id);
  const match = sources.find((s) => s.display_id && s.display_id === String(disp.id))
    || sources[idx >= 0 ? idx : 0] || sources[0];
  return {
    sourceId: match ? match.id : null,
    displayId: String(disp.id),
    scaleFactor: disp.scaleFactor,
    displayBounds: disp.bounds,
  };
});

const READ = `(() => {
  const el = document.getElementById('widget');
  const d = document.getElementById('detail');
  const c = document.getElementById('glass-canvas');
  const r = el.getBoundingClientRect();
  return {
    hovered: el.classList.contains('hovered'),
    noGlass: el.classList.contains('no-glass'),
    detail: getComputedStyle(d).display,
    rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height },
    canvas: [c.width, c.height],
  };
})()`;

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function at(point) {
  cursor = point;
  await settle(250);   // several frames of the rAF hit-test loop
  return win.webContents.executeJavaScript(READ);
}

const checks = [];
function expect(name, cond, detail) {
  checks.push({ name, pass: !!cond, detail });
}

app.whenReady().then(async () => {
  // Must be visible and on top: Chromium runs no requestAnimationFrame in a
  // hidden or fully occluded window, and both the hover hit-test and the glass
  // render loop live in rAF.
  win = new BrowserWindow({
    ...WIN, show: true, frame: false, transparent: true, hasShadow: false,
    alwaysOnTop: true, focusable: false, skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-stub.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  await win.loadFile(path.join(REPO, 'index.html'));
  await settle(1200);   // let initGlass attach or fail

  // Widget sits at left:40 top:12 inside the window, 560 wide.
  const away = { x: WIN.x - 300, y: WIN.y - 300 };
  const onBar = { x: WIN.x + 320, y: WIN.y + 24 };

  const off = await at(away);
  expect('starts unhovered', off.hovered === false, off.hovered);
  expect('#detail hidden when not hovered', off.detail === 'none', off.detail);
  const collapsedH = off.rect.h;

  const on = await at(onBar);
  expect('hovers when pointer is over the bar', on.hovered === true, on.hovered);
  expect('#detail shown on hover', on.detail === 'flex', on.detail);
  expect('bar grows on hover', on.rect.h > collapsedH, `${collapsedH} -> ${on.rect.h}`);
  expect('expanded bar still fits the window',
    on.rect.bottom <= WIN.height, `bottom ${on.rect.bottom} of ${WIN.height}`);

  // The area that only exists once expanded must keep it open, not oscillate.
  const lowerBand = { x: WIN.x + 320, y: WIN.y + on.rect.bottom - 4 };
  const held = await at(lowerBand);
  expect('stays hovered over the newly revealed strip', held.hovered === true, held.hovered);
  const held2 = await at(lowerBand);
  expect('and does not flicker on the next tick', held2.hovered === true, held2.hovered);

  if (WITH_GLASS) {
    expect('glass canvas follows the taller bar',
      held.canvas[1] > off.canvas[1] || off.noGlass,
      `${off.canvas.join('x')} -> ${held.canvas.join('x')}`);
  }

  const back = await at(away);
  expect('collapses when the pointer leaves', back.hovered === false, back.hovered);
  expect('#detail hidden again', back.detail === 'none', back.detail);
  expect('bar returns to its collapsed height', Math.abs(back.rect.h - collapsedH) < 0.5,
    `${collapsedH} -> ${back.rect.h}`);

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '  <- ' + JSON.stringify(c.detail)}`);
  console.log(`\nglass=${WITH_GLASS ? 'on' : 'off'}  noGlassClass=${off.noGlass}  ${checks.length - failed.length}/${checks.length} passed`);
  app.exit(failed.length ? 1 : 0);
});
