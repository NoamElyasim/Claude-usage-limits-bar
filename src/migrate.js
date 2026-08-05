// Carries the user-data directory across a rename of the app.
//
// Electron derives userData from productName, so renaming the app points it at
// a brand-new empty folder: the claude.ai cookie jar, the discovered org id and
// the saved window position are all still on disk, just under the old name, and
// the app looks signed out. Copy the old profile across the first time the new
// one is needed.
//
// Must run before anything reads userData — src/config.js resolves its path at
// require time, and the session cookie jar is opened on app ready.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Oldest last. Only the first one that exists is used.
const FORMER_NAMES = ['Claude Usage Overlay'];

// A directory Chromium happened to create is not a profile. Treat it as empty
// unless it actually holds something worth keeping, or a half-started app would
// block the migration forever.
function hasProfile(dir) {
  return fs.existsSync(path.join(dir, 'config.json'))
      || fs.existsSync(path.join(dir, 'Network', 'Cookies'));
}

module.exports = function migrateUserData() {
  let current;
  try {
    current = app.getPath('userData');
  } catch (_) {
    return null;                      // nothing sensible to do this early
  }
  if (hasProfile(current)) return null;   // already migrated, or genuinely in use

  const parent = path.dirname(current);
  for (const name of FORMER_NAMES) {
    const legacy = path.join(parent, name);
    if (legacy === current || !hasProfile(legacy)) continue;
    try {
      fs.mkdirSync(current, { recursive: true });
      // Copied, not moved: if the new build turns out to be broken the old
      // install still has an intact profile to fall back to.
      fs.cpSync(legacy, current, { recursive: true, force: false, errorOnExist: false });
      console.log(`migrated user data from "${name}"`);
      return legacy;
    } catch (e) {
      console.error('could not migrate user data from', legacy, e);
      return null;
    }
  }
  return null;
};
