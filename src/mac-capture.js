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
    // Copy out of the shared stdout chunk before it is handed across IPC.
    latest.pixels = new Uint8Array(latest.pixels);
    onFrame(latest);
  }

  // Point the capture at the desktop behind the window. Cheap to call often:
  // unchanged requests are dropped here and in the helper.
  // `force` re-sends an unchanged rect: the helper ignores it while its stream
  // runs, but uses it to retry a start that failed for lack of permission.
  function track(bounds, force = false) {
    if (!child) return;
    const disp = screen.getDisplayMatching(bounds);
    const db = disp.bounds;
    // Clamped to the display: ScreenCaptureKit rejects a source rect that runs
    // off it, and the shader clamps samples at the texture edge anyway.
    const x0 = Math.max(db.x, bounds.x + REGION.left);
    const y0 = Math.max(db.y, bounds.y + REGION.top);
    const x1 = Math.min(db.x + db.width, bounds.x + REGION.left + REGION.width);
    const y1 = Math.min(db.y + db.height, bounds.y + REGION.top + REGION.height);
    if (x1 <= x0 || y1 <= y0) return;
    const req = JSON.stringify({
      display: disp.id,
      x: x0 - db.x, y: y0 - db.y, w: x1 - x0, h: y1 - y0,
      scale: disp.scaleFactor,
    });
    if (req === lastReq && !force) return;
    lastReq = req;
    child.stdin.write(req + '\n');
  }

  function stop() {
    stopped = true;
    if (child) child.kill();
  }

  launch();
  return { track, stop };
}

module.exports = { available, start };
