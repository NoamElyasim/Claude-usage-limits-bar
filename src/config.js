// Per-machine settings, kept in the OS user-data dir (never in the app folder)
// so the same installed app works for any user on any platform and nothing
// machine-specific has to be edited into the source before it runs.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = path.join(app.getPath('userData'), 'config.json');

const DEFAULTS = {
  orgId: null,        // discovered from /api/organizations on first run
  position: null,     // { x, y } in DIP, restored on launch
  // On by default: a status bar you have to remember to launch is a status bar
  // you stop seeing. Turn it off from the menu; the choice is then written
  // here and wins over this default.
  openAtLogin: true,
  statusDirs: null,   // override: array of dirs the Claude Code hooks write to
  shape: 'bar',       // 'bar' | 'capsule' | 'square' | 'circle', from the ⋮ menu
  capsuleOrientation: 'horizontal',   // or 'vertical' (⋮ → Rotate 90°)
};

let cache = null;

function all() {
  if (cache) return cache;
  try {
    cache = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (_) {
    cache = Object.assign({}, DEFAULTS);
  }
  return cache;
}

function get(key) {
  return all()[key];
}

function set(patch) {
  const next = Object.assign(all(), patch);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    // Write-then-rename: a half-written config.json would otherwise wipe the
    // saved position and org id on the next launch.
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('config: could not save', e);
  }
  return next;
}

module.exports = { get, set, all, FILE };
