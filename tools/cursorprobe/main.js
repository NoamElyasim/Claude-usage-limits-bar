// Cursor probe — glasslab, but with a real desktop frame and the real OS cursor.
//
// glasslab draws a synthetic arrow on a synthetic backdrop, so it can only prove
// the shader maths. This grabs one actual frame of the display (the capture has
// the pointer composited in, which is the whole problem), freezes it, and runs
// the exact uniform maths index.html runs, with the dodge off and on.
//
//   npm run cursorprobe   → tools/cursorprobe/out.png + diagnostics on stdout
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const REPO = path.join(HERE, '..', '..');
const INDEX = path.join(REPO, 'index.html');

function extract(html) {
  const marker = 'const fsSource = `';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('fsSource not found in index.html');
  const from = start + marker.length;
  return html.slice(from, html.indexOf('`;', from));
}

app.whenReady().then(async () => {
  const cursor = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(cursor);
  const physW = Math.round(disp.bounds.width * disp.scaleFactor);
  const physH = Math.round(disp.bounds.height * disp.scaleFactor);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
  });
  const displays = screen.getAllDisplays();
  const idx = displays.findIndex((d) => d.id === disp.id);
  const source = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[idx] || sources[0];

  // Put a bar-sized rect around the cursor so the pointer sits inside the glass,
  // which is the case that fails.
  const bar = { x: cursor.x - 280, y: cursor.y - 17, width: 560, height: 34 };

  const win = new BrowserWindow({
    width: 900, height: 640, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  await win.loadFile(path.join(HERE, 'probe.html'));

  const arg = JSON.stringify({
    sourceId: source.id,
    physW, physH,
    scaleFactor: disp.scaleFactor,
    displayBounds: disp.bounds,
    cursor, bar,
    fsSource: extract(fs.readFileSync(INDEX, 'utf8')),
  });
  const info = await win.webContents.executeJavaScript(`run(${arg})`);
  await new Promise((r) => setTimeout(r, 300));

  const out = path.join(HERE, 'out.png');
  fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify(info, null, 2));
  console.log('wrote ' + out);
  app.quit();
});
