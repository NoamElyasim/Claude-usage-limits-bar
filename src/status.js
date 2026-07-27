// Claude Code session status, written by the hooks in hooks/claude-status.sh.
//
// Each live session owns one file named after its session id, containing
// "working" | "input" | "done". The hooks always write to /tmp/claude-status
// inside whatever OS Claude Code itself runs on, so the overlay has to look in
// a different place depending on where that is:
//
//   macOS / Linux   → /tmp/claude-status (same machine)
//   Windows host    → the WSL distro's /tmp, over the \\wsl.localhost share,
//                     because Claude Code runs inside WSL there
//
// Every candidate that exists is scanned, so a Windows box with several
// distros — or Claude Code running natively as well — is handled without
// configuration.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');

const STALE_S = 12 * 3600;
// A session also counts as live if its status file was touched this recently.
// Background-job sessions never appear in `pgrep -af session-id` — their id
// exists only in the hook payload, not in any process command line — so the
// pgrep check alone silently drops them and the dot stays grey forever.
const LIVE_S = 15 * 60;
const DISTRO_TTL_MS = 5 * 60 * 1000;

function run(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, encoding: 'buffer' },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

let distros = [];
let distrosAt = 0;

// `wsl.exe -l -q` prints UTF-16LE, so it has to be decoded explicitly or every
// name comes back with NUL bytes wedged between the characters.
async function wslDistros() {
  if (process.platform !== 'win32') return [];
  if (Date.now() - distrosAt < DISTRO_TTL_MS) return distros;
  distrosAt = Date.now();
  const out = await run('wsl.exe', ['-l', '-q']);
  if (out) {
    distros = out.toString('utf16le')
      .split(/\r?\n/)
      .map((s) => s.replace(/\0/g, '').trim())
      .filter(Boolean);
  }
  return distros;
}

async function candidateDirs() {
  const override = config.get('statusDirs');
  if (Array.isArray(override) && override.length) return override;
  if (process.env.CLAUDE_STATUS_DIR) return [process.env.CLAUDE_STATUS_DIR];

  if (process.platform !== 'win32') {
    const dirs = ['/tmp/claude-status'];
    const tmp = path.join(os.tmpdir(), 'claude-status');
    if (!dirs.includes(tmp)) dirs.push(tmp);
    return dirs;
  }

  // Native Windows first (Claude Code under Git Bash lands in %TEMP%), then
  // each WSL distro. \\wsl$ is the pre-21H1 spelling of the same share.
  const dirs = [path.join(os.tmpdir(), 'claude-status')];
  for (const d of await wslDistros()) {
    dirs.push(`\\\\wsl.localhost\\${d}\\tmp\\claude-status`);
    dirs.push(`\\\\wsl$\\${d}\\tmp\\claude-status`);
  }
  return dirs;
}

// Command lines of running claude processes, used to drop status files whose
// session died without SessionEnd firing. null means "couldn't tell" — in that
// case nothing is pruned, since guessing wrong hides a live session.
let liveCache = { at: 0, value: null };

async function liveSessionIds() {
  // The status poll runs every second; spawning a pgrep (or one wsl.exe per
  // distro) that often is pure overhead when process lists barely move.
  if (Date.now() - liveCache.at < 3000) return liveCache.value;

  let value = null;
  if (process.platform !== 'win32') {
    const out = await run('pgrep', ['-af', 'session-id']);
    value = out ? out.toString('utf8') : null;
  } else {
    const found = [];
    for (const d of await wslDistros()) {
      const out = await run('wsl.exe', ['-d', d, '-e', 'pgrep', '-af', 'session-id']);
      if (out) found.push(out.toString('utf8'));
    }
    value = found.length ? found.join('\n') : null;
  }
  liveCache = { at: Date.now(), value };
  return value;
}

async function readStatus() {
  const live = await liveSessionIds();
  const now = Date.now();
  const states = new Set();

  for (const dir of await candidateDirs()) {
    let names;
    try {
      names = await fs.promises.readdir(dir);
    } catch (_) {
      continue; // dir doesn't exist on this machine — expected for most candidates
    }
    for (const name of names) {
      try {
        const p = path.join(dir, name);
        const st = await fs.promises.stat(p);
        const ageS = (now - st.mtimeMs) / 1000;
        if (!st.isFile() || ageS > STALE_S) continue;
        if (live !== null && !live.includes(name) && ageS > LIVE_S) continue;
        states.add((await fs.promises.readFile(p, 'utf8')).trim());
      } catch (_) { /* file vanished mid-scan */ }
    }
  }

  for (const s of ['input', 'working', 'done']) if (states.has(s)) return s;
  return null;
}

module.exports = { readStatus, candidateDirs };
