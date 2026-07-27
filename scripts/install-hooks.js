#!/usr/bin/env node
// Installs the Claude Code status hooks that drive the overlay's status dot.
//
// Run this from the environment Claude Code itself runs in — a plain shell on
// macOS/Linux, or inside WSL on Windows — because that is where ~/.claude and
// the /tmp/claude-status files live:
//
//   node scripts/install-hooks.js            install / update
//   node scripts/install-hooks.js --uninstall  remove them again
//
// Existing settings are merged, not replaced, and a timestamped backup is
// written next to settings.json first.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const HOOK_DIR = path.join(CLAUDE_DIR, 'hooks');
const HOOK_DEST = path.join(HOOK_DIR, 'claude-status.sh');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const SRC = path.join(__dirname, '..', 'hooks', 'claude-status.sh');

// Event → argument the hook is called with. This mapping is the whole state
// machine: prompt submitted = working, permission/notification = input needed,
// turn finished = done, session gone = clear the file.
const EVENTS = {
  UserPromptSubmit: 'working',
  Notification: 'input',
  PermissionRequest: 'input',
  Stop: 'done',
  SessionEnd: 'clear',
};

const MARKER = 'claude-status.sh';
const uninstall = process.argv.includes('--uninstall');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    // Never overwrite a settings file that failed to parse — that would throw
    // away every other setting the user has.
    console.error(`refusing to touch ${SETTINGS}: it is not valid JSON (${e.message})`);
    process.exit(1);
  }
}

function backup() {
  if (!fs.existsSync(SETTINGS)) return null;
  const dest = `${SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(SETTINGS, dest);
  return dest;
}

const settings = readSettings();
settings.hooks = settings.hooks || {};

if (uninstall) {
  for (const event of Object.keys(EVENTS)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => Object.assign({}, g, {
        hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes(MARKER)),
      }))
      .filter((g) => (g.hooks || []).length);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  const b = backup();
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  fs.rmSync(HOOK_DEST, { force: true });
  console.log(`removed status hooks from ${SETTINGS}${b ? ` (backup: ${b})` : ''}`);
  process.exit(0);
}

fs.mkdirSync(HOOK_DIR, { recursive: true });
fs.copyFileSync(SRC, HOOK_DEST);
fs.chmodSync(HOOK_DEST, 0o755);

for (const [event, arg] of Object.entries(EVENTS)) {
  const command = `~/.claude/hooks/claude-status.sh ${arg}`;
  const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  let found = false;
  for (const g of groups) {
    for (const h of (g.hooks || [])) {
      if (String(h.command || '').includes(MARKER)) {
        h.type = 'command';
        h.command = command;   // re-point an older install at the current path
        h.timeout = 5;
        found = true;
      }
    }
  }
  if (!found) groups.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
  settings.hooks[event] = groups;
}

const b = backup();
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');

console.log(`installed ${HOOK_DEST}`);
console.log(`wired ${Object.keys(EVENTS).join(', ')} in ${SETTINGS}${b ? ` (backup: ${b})` : ''}`);
if (process.platform === 'win32') {
  console.log('\nWarning: this looks like native Windows. Claude Code normally runs under\n' +
              'WSL here — if so, re-run this script from inside WSL instead.');
}
console.log('\nRestart Claude Code (or start a new session) for the hooks to load.');
