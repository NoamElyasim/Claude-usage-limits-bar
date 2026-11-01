// The macOS backdrop: the window's system blur (vibrancy), clipped to the
// widget's shape and set to the strength chosen in Settings by
// native/backdrop-mask.mm. Replaced the captured live glass, which needed
// Screen Recording permission, lit the menu bar's recording indicator the
// whole time, and hid the bar from screenshots.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Follows the window's appearance, so Settings → Appearance turns it light or
// dark along with the page (nativeTheme.themeSource).
const MATERIAL = 'hud';

// Settings → Blur, in points of blur radius. macOS draws its materials at 30;
// past ~60 the difference is hard to see.
const BLUR_DEFAULT = 30;
const BLUR_MAX = 60;

function addonPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'backdrop-mask.node')
    : path.join(__dirname, '..', 'bin', 'backdrop-mask.node');
}

let addon;
function load() {
  if (addon === undefined) {
    addon = null;
    if (process.platform === 'darwin' && fs.existsSync(addonPath())) {
      try { addon = require(addonPath()); } catch (e) { console.error('backdrop-mask failed to load', e); }
    }
  }
  return addon;
}

// Without the addon the blur would fill the whole window, margins and all, so
// there is no blur at all and the widget falls back to its plain dark fill.
function available() { return !!load(); }

// Kept so both can be put back after AppKit rebuilds the effect view's layers
// (an appearance change does), which drops the mask and resets the radius.
let lastRect = null;
let blurRadius = BLUR_DEFAULT;
let blurWorks = null;   // null until first tried

// rect: window-local DIP with a corner radius, as the renderer measures #widget.
function setMask(win, rect) {
  if (!load() || !win || win.isDestroyed()) return;
  lastRect = rect;
  addon.setMask(win.getNativeWindowHandle(), rect.x, rect.y, rect.width, rect.height, rect.radius);
  applyBlur(win);
}

function setBlur(win, radius) {
  blurRadius = Math.min(BLUR_MAX, Math.max(0, Number(radius) || 0));
  applyBlur(win);
}

function applyBlur(win) {
  if (!load() || !win || win.isDestroyed()) return;
  const ok = addon.setBlur(win.getNativeWindowHandle(), blurRadius);
  // Only a definite answer counts: before the first mask the layer tree may
  // not be built yet.
  if (ok || lastRect) blurWorks = ok;
}

function refresh(win) {
  if (lastRect) setMask(win, lastRect);
  else applyBlur(win);
}

// Whether the strength can be changed on this macOS (see setBlur in the addon).
function blurAdjustable() { return available() && blurWorks !== false; }

module.exports = { MATERIAL, BLUR_DEFAULT, BLUR_MAX, available, setMask, setBlur, refresh, blurAdjustable };
