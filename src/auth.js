// claude.ai authentication.
//
// The overlay reads the same usage endpoint the web app does, so it needs a
// logged-in claude.ai session. Electron's default session persists its cookie
// jar under the user-data dir, so signing in once through the built-in login
// window keeps working across restarts — no cookie file to copy between
// machines, which is what made the old setup non-portable.
const { session, BrowserWindow } = require('electron');
const fs = require('fs');

// Chromium's default UA says "Electron", which Cloudflare and Google's sign-in
// both treat as a bot. Everything that talks to claude.ai uses this instead.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

function jar() {
  return session.defaultSession.cookies;
}

async function hasSession() {
  try {
    const cookies = await jar().get({ url: 'https://claude.ai', name: 'sessionKey' });
    return cookies.some((c) => c.value);
  } catch (_) {
    return false;
  }
}

// Bootstrap path for an existing install (and for headless/scripted setups):
// a claude-cookies.txt next to the app is imported into the cookie jar once.
// Cookies must go through the jar rather than a manual Cookie header —
// Cloudflare's bot check rejects hand-set headers even with a valid session.
async function importCookieFile(candidates) {
  const file = candidates.find((f) => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } });
  if (!file) return false;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').trim(); } catch (_) { return false; }
  if (!raw) return false;

  for (const pair of raw.split(';').map((p) => p.trim()).filter(Boolean)) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    try {
      await jar().set({
        url: 'https://claude.ai',
        name: pair.slice(0, idx),
        value: pair.slice(idx + 1),
      });
    } catch (_) { /* skip individual malformed cookie */ }
  }
  return true;
}

let loginWin = null;

// Opens a real browser window at claude.ai and resolves once a session cookie
// shows up. Resolves false if the user closes the window first.
function signIn() {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus();
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    loginWin = new BrowserWindow({
      width: 520,
      height: 780,
      title: 'Sign in to Claude',
      autoHideMenuBar: true,
      webPreferences: { partition: undefined, contextIsolation: true },
    });
    loginWin.webContents.setUserAgent(UA);

    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      const w = loginWin;
      loginWin = null;
      if (w && !w.isDestroyed()) w.destroy();
      resolve(ok);
    };

    const poll = setInterval(async () => {
      if (await hasSession()) finish(true);
    }, 1500);

    loginWin.on('closed', () => finish(false));
    loginWin.loadURL('https://claude.ai/login', { userAgent: UA });
  });
}

async function signOut() {
  try {
    const cookies = await jar().get({ url: 'https://claude.ai' });
    for (const c of cookies) {
      const url = `https://${c.domain.replace(/^\./, '')}${c.path}`;
      await jar().remove(url, c.name).catch(() => {});
    }
    await session.defaultSession.flushStorageData();
  } catch (e) {
    console.error('auth: sign out failed', e);
  }
}

module.exports = { UA, hasSession, importCookieFile, signIn, signOut };
