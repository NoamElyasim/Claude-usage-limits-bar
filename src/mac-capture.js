// Drives native/glass-capture on macOS: tells it which strip of desktop sits
// behind the bar, and turns its stdout back into frames for the renderer.
// See the top of native/glass-capture.swift for why desktopCapturer cannot be
// used there.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { app, screen } = require('electron');

const MAGIC = 0x46534c47; // "GLSF"
const HEADER = 32;

// Desktop around the bar to capture, in window-local DIP. Wider than the bar on
// every side because the rim refracts outward and the wide bloom blur reaches
// ~20px past the edge; tall enough for the hover lift and the unfolded detail
// row. Must stay in step with #widget's geometry in index.html.
const REGION = { left: 12, top: -14, width: 616, height: 120 };

// Extra desktop captured around REGION, so a drag can move the bar this far
// before the capture has to be retargeted; the retarget is requested once the
// bar comes within TILE_SLACK of the tile's edge, ahead of actually reaching it.
const TILE_MARGIN = { x: 160, y: 90 };
const TILE_SLACK = 40;
// Capture density, in pixels per DIP. One per DIP even on Retina: the glass
// frosts everything it shows, and side by side the half-resolution tile was
// indistinguishable while costing a quarter of the bytes — at full density the
// tile is ~4.5MB a frame and pushing that through stdout and IPC at 60fps kept
// the main process near 60% CPU. GLASS_TILE_SCALE overrides it for comparison.
const TILE_SCALE = Number(process.env.GLASS_TILE_SCALE) || 1;

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'glass-capture')
    : path.join(__dirname, '..', 'bin', 'glass-capture');
}

function available() {
  return process.platform === 'darwin' && fs.existsSync(helperPath());
}

// Helper diagnostics go here rather than to a console nobody sees in a
// packaged app: ~/Library/Logs/Claude Usage Limits Bar/glass-capture.log
function logLine(line) {
  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'glass-capture.log'), `${new Date().toISOString()} ${line}\n`);
  } catch (_) {}
}

const NO_PERMISSION = 3; // helper exit status, see glass-capture.swift
const PERMISSION_RETRY_MS = 4000;

function start(onFrame) {
  let child = null;
  let asked = false; // the system prompt is raised at most once per launch
  let lastErr = '';
  // Pipe chunks are ~64KB and a frame is ~1MB. Joining on every chunk copied
  // the growing buffer over and over, so chunks are queued and only joined
  // once a whole frame has arrived.
  let chunks = [];
  let queued = 0;
  let need = HEADER; // bytes the next step of parsing is waiting for
  let lastReq = '';
  let stopped = false;

  function launch() {
    const args = asked ? [] : ['--request'];
    asked = true;
    child = spawn(helperPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', (d) => {
      const msg = String(d).trim();
      // The permission check repeats every few seconds; log it once per run.
      if (msg !== lastErr) logLine(msg);
      lastErr = msg;
    });
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      queued += chunk.length;
      if (queued >= need) parse();
    });
    child.on('exit', (code) => {
      child = null;
      chunks = []; queued = 0; need = HEADER;
      lastReq = '';
      // No permission yet: a fresh process is the only way to notice a grant.
      // Anything else is a crash, which should not take the glass down for good.
      if (!stopped) setTimeout(launch, code === NO_PERMISSION ? PERMISSION_RETRY_MS : 2000);
    });
    child.stdin.on('error', () => {});
  }

  // Only the newest complete frame in a chunk is worth forwarding.
  function parse() {
    let buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, queued);
    let latest = null;
    need = HEADER;
    while (buf.length >= HEADER) {
      if (buf.readUInt32LE(0) !== MAGIC) { buf = Buffer.alloc(0); break; } // lost sync
      const w = buf.readUInt32LE(4), h = buf.readUInt32LE(8);
      const size = HEADER + w * h * 4;
      if (buf.length < size) { need = size; break; }
      latest = {
        width: w,
        height: h,
        displayId: String(buf.readUInt32LE(12)),
        rect: {
          x: buf.readFloatLE(16), y: buf.readFloatLE(20),
          width: buf.readFloatLE(24), height: buf.readFloatLE(28),
        },
        pixels: buf.subarray(HEADER, size),
      };
      buf = buf.subarray(size);
    }
    chunks = buf.length ? [buf] : [];
    queued = buf.length;
    if (!latest) return;
    const disp = screen.getAllDisplays().find((d) => String(d.id) === latest.displayId);
    if (!disp) return;
    // Display-local points → global DIP, the space window bounds live in.
    latest.rect.x += disp.bounds.x;
    latest.rect.y += disp.bounds.y;
    // No copy here: IPC serialises the bytes on send anyway, and a second
    // copy of a multi-megabyte frame per frame was most of the main process's
    // CPU while the backdrop was changing.
    onFrame(latest);
  }

  // Point the capture at the desktop behind the window.
  //
  // The capture covers a tile well beyond the bar, and the shader crops the
  // bar's rect out of it every frame. Retargeting ScreenCaptureKit takes tens
  // of milliseconds, so re-requesting on every drag step made the backdrop
  // trail the bar and snap into place; now a drag stays inside the current
  // tile and only re-centres it once the bar gets near its edge.
  let tile = null; // { display, x0, y0, x1, y1 } in global DIP

  function send(force) {
    const req = JSON.stringify({
      display: tile.display.id,
      x: tile.x0 - tile.display.bounds.x, y: tile.y0 - tile.display.bounds.y,
      w: tile.x1 - tile.x0, h: tile.y1 - tile.y0,
      scale: Math.min(TILE_SCALE, tile.display.scaleFactor),
    });
    if (req === lastReq && !force) return;
    lastReq = req;
    child.stdin.write(req + '\n');
  }

  // `force` re-sends an unchanged rect: the helper ignores it while its stream
  // runs, but uses it to retry a start that failed for lack of permission.
  function track(bounds, force = false) {
    if (!child) return;
    const disp = screen.getDisplayMatching(bounds);
    const db = disp.bounds;
    const clampX = (v) => Math.min(db.x + db.width, Math.max(db.x, v));
    const clampY = (v) => Math.min(db.y + db.height, Math.max(db.y, v));
    // What the shader needs right now…
    const nx0 = clampX(bounds.x + REGION.left), nx1 = clampX(bounds.x + REGION.left + REGION.width);
    const ny0 = clampY(bounds.y + REGION.top), ny1 = clampY(bounds.y + REGION.top + REGION.height);
    if (nx1 <= nx0 || ny1 <= ny0) return;

    // …is it still comfortably inside the tile? An edge that sits on the
    // display edge needs no slack: the tile cannot grow past it anyway.
    const fits = (lo, hi, t0, t1, d0, d1) =>
      (lo >= t0 + TILE_SLACK || t0 === d0) && (hi <= t1 - TILE_SLACK || t1 === d1) && lo >= t0 && hi <= t1;
    const ok = tile && tile.display.id === disp.id &&
      fits(nx0, nx1, tile.x0, tile.x1, db.x, db.x + db.width) &&
      fits(ny0, ny1, tile.y0, tile.y1, db.y, db.y + db.height);

    if (!ok) {
      tile = {
        display: disp,
        x0: clampX(nx0 - TILE_MARGIN.x), x1: clampX(nx1 + TILE_MARGIN.x),
        y0: clampY(ny0 - TILE_MARGIN.y), y1: clampY(ny1 + TILE_MARGIN.y),
      };
    }
    send(force);
  }

  function stop() {
    stopped = true;
    if (child) child.kill();
  }

  launch();
  return { track, stop };
}

module.exports = { available, start };
