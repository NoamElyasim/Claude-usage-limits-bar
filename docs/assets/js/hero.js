// Wires the WebGL glass to the DOM, drives the drag interaction, and
// animates placeholder usage data. Also owns the fallback logic: a static
// screenshot stands in for the live bar below 700px width, when WebGL is
// unavailable, or after a lost context.
import { createGlass } from './glass.js';

const bar = document.getElementById('bar');
const canvas = document.getElementById('glass-canvas');
const backdrop = document.getElementById('backdrop');
const dot = document.getElementById('dot');
const fill5h = document.getElementById('fill-5h');
const fill7d = document.getElementById('fill-7d');
const timer = document.getElementById('timer');
const reset5h = document.getElementById('reset-5h');
const reset7d = document.getElementById('reset-7d');
const fallbackImg = document.getElementById('bar-fallback');

// Declared here, above useFallback(), rather than near the tick()/
// setInterval call site below: useFallback() can run synchronously during
// module evaluation (the narrow-viewport branch), and a `let` declared later
// would still be in the temporal dead zone at that point.
let tickTimer = null;

// Module scope, not local to initGlass(), so the pointermove handler, the
// resize observer, and the media-query listener below can all reach the
// same instance and null-guard against the fallback paths where it never
// exists.
let glass = null;

// Set once a lost context or a failed createGlass() call has occurred.
// Distinct from `glass === null` at load time (which can still mean "not
// initialised yet, viewport is narrow"): this flag means the shader is
// permanently unavailable for the rest of the page's life, so a later
// widen past 700px must not try to resurrect it.
let glassDead = false;
let gateArmed = false;
let ticked = false;

// Narrow viewport and no-WebGL/lost-context resolve to the static
// screenshot; prefers-reduced-motion instead takes the normal shader init
// path and renders a single frame, holding the usage figures and status dot
// steady instead of ticking.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const narrowQuery = window.matchMedia('(max-width: 700px)');

function useFallback() {
  bar.hidden = true;
  fallbackImg.hidden = false;
  // An async webglcontextlost can fire after the interval already started;
  // stop it so nothing keeps mutating DOM behind the static image.
  if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null; }
}

/* glass.js uploads the backdrop texture lazily, inside render(), gated on
   backdropEl.complete/naturalWidth — so createGlass() itself never races the
   decode. But if the image is still loading when we call render() below, the
   first render needs the image ready to matter, and if it errors outright we
   should never spin up WebGL over a broken texture at all. So gate
   initialisation here: if the image already finished loading (success or
   failure) act immediately; otherwise wait for its `load` event and treat
   `error` the same as "no WebGL" — the no-glass CSS pill already covers a
   backdrop-less bar. */
function initGlass() {
  glass = createGlass({ canvas, barEl: bar, backdropEl: backdrop });
  if (glass) {
    // Render-on-change, not a continuous rAF loop: the backdrop is a static
    // image and glass.js never sets a nonzero uCursorRadUv, so almost every
    // frame of a continuous loop would re-run the 52-tap fragment shader
    // over pixels that hadn't changed. Render once now, then again on every
    // event that can move, resize, or reveal the bar — render() is cheap
    // and idempotent, re-reading getBoundingClientRect() each call.
    glass.render();
    window.addEventListener('resize', () => { if (glass) glass.render(); });
    // #bar's own box grows when :hover reveals #detail, and its transform
    // shifts on :hover too — neither is a window resize, so each needs its
    // own trigger. ResizeObserver catches the height change on both hover in
    // and hover out; transitionend catches the translateY settle finishing.
    const barResizeObserver = new ResizeObserver(() => { if (glass) glass.render(); });
    barResizeObserver.observe(bar);
    // transitionend bubbles: .fill animates width and background-color, and
    // #dot animates background and box-shadow, so a data tick would otherwise
    // fire four renders that change nothing about #bar's own box. Only #bar's
    // own transform settle moves the glass.
    bar.addEventListener('transitionend', (e) => {
      if (e.target === bar && glass) glass.render();
    });
    // A lost context leaves an empty canvas over a bar whose CSS fill
    // assumes the shader is painting; swap to the screenshot instead, and
    // mark the shader dead so a later resize cannot try to bring it back. No
    // webglcontextrestored handler — the fallback swap is permanent.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      glassDead = true;
      useFallback();
    });
  } else {
    glassDead = true;
    useFallback();
  }
}

// Only a narrow viewport short-circuits before the backdrop-decode gate
// below — the shader never initialises for it, so there is no reason to
// wait on the backdrop image. reducedMotion takes the same decode-gated path
// as the normal case, so it can still render its one live frame.
//
// This same gate runs again later, from narrowQuery's listener below, if the
// page loaded narrow and the shader was never started.
function startGlassDecodeGate() {
  // Cycling the viewport across 700px before the backdrop finishes decoding
  // would otherwise queue a second `load` listener and initialise a second
  // glass on the same context, stacking duplicate observers and handlers.
  if (gateArmed) return;
  gateArmed = true;
  if (backdrop.complete && backdrop.naturalWidth) {
    initGlass();
  } else if (backdrop.complete) {
    // complete is already true but naturalWidth is 0: the image failed to
    // decode. Distinct from the three glass-fallback triggers above — there
    // is no screenshot to fall back to without a decoded source image, so
    // this keeps the plain no-glass pill instead.
    bar.classList.add('no-glass');
  } else {
    backdrop.addEventListener('load', initGlass, { once: true });
    backdrop.addEventListener('error', () => bar.classList.add('no-glass'), { once: true });
  }
}

if (narrowQuery.matches) {
  useFallback();
} else {
  startGlassDecodeGate();
}

// Widening back past 700px restores the live bar — unless the shader is
// permanently dead (see glassDead above), in which case the fallback image
// stays put for the rest of the page's life.
narrowQuery.addEventListener('change', (e) => {
  if (e.matches) {
    useFallback();
    return;
  }
  if (glassDead) return;
  fallbackImg.hidden = true;
  bar.hidden = false;
  if (glass) {
    glass.render();
  } else {
    // Page loaded narrow, so the shader never started — run it through the
    // same decode gate the normal load path uses.
    startGlassDecodeGate();
  }
  if (reducedMotion) {
    // Held steady: only seed the figures if they were never drawn, which
    // happens when the page loaded narrow and the bar is appearing now.
    if (!ticked) tick();
  } else if (tickTimer === null) {
    tick();
    tickTimer = setInterval(tick, 2200);
  }
});

/* Drag — the bar stays inside the backdrop, since outside it there is nothing
   to refract and the shader would sample the clamped edge row. */
let dragging = false;
let grabX = 0;
let grabY = 0;

bar.addEventListener('pointerdown', (e) => {
  dragging = true;
  bar.classList.add('dragging');
  bar.setPointerCapture(e.pointerId);
  const r = bar.getBoundingClientRect();
  grabX = e.clientX - r.left;
  grabY = e.clientY - r.top;
});

bar.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const bd = backdrop.getBoundingClientRect();
  const maxX = bd.width - bar.offsetWidth;
  const maxY = bd.height - bar.offsetHeight;
  const x = Math.min(Math.max(e.clientX - bd.left - grabX, 0), Math.max(maxX, 0));
  const y = Math.min(Math.max(e.clientY - bd.top - grabY, 0), Math.max(maxY, 0));
  bar.style.left = `${x}px`;
  bar.style.top = `${y}px`;
  // Render-on-change means dragging must drive its own render: glass is
  // null on every fallback path, and pointermove is bound unconditionally.
  if (glass) glass.render();
});

for (const ev of ['pointerup', 'pointercancel']) {
  bar.addEventListener(ev, (e) => {
    dragging = false;
    bar.classList.remove('dragging');
    if (bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId);
  });
}

/* Placeholder data. The thresholds and colours are the app's; the numbers are
   invented, and the page says so directly beneath the bar. */
function usageColor(pct) {
  if (pct >= 90) return '#e5484d';   // red
  if (pct >= 80) return '#f76b15';   // orange
  if (pct >= 50) return '#f5c518';   // yellow
  return '#34b96c';                  // green
}

function setUsage(el, pct) {
  el.style.width = `${Math.max(pct, 8)}%`;
  el.style.background = usageColor(pct);
  el.textContent = `${Math.round(pct)}%`;
}

const DOT_STATES = [
  { color: '#555555', glow: 'none' },                                  // nothing running
  { color: '#3b82f6', glow: '0 0 8px rgba(59,130,246,0.9)' },          // working
  { color: '#f5c518', glow: '0 0 8px rgba(245,197,24,0.9)' },          // needs input
  { color: '#34b96c', glow: '0 0 8px rgba(52,185,108,0.9)' },          // finished
];

let step = 0;
function tick() {
  ticked = true;
  // Creeps upward and wraps, so a visitor who lingers sees every colour band.
  step += 1;
  const p5 = (step * 7) % 100;
  const p7 = (step * 3 + 20) % 100;
  setUsage(fill5h, p5);
  setUsage(fill7d, p7);

  const s = DOT_STATES[step % DOT_STATES.length];
  dot.style.background = s.color;
  dot.style.boxShadow = s.glow;

  const mins = 240 - (step * 7) % 240;
  timer.textContent = `⏱ ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
  reset5h.textContent = `${(step % 12) + 1}:00 PM`;
  reset7d.textContent = 'Thursday';
}

// Guard against ticking placeholder data behind a static fallback image —
// bar.hidden is only true synchronously here for the narrow-viewport and
// no-WebGL-at-init cases; a later async webglcontextlost swap is handled by
// useFallback() clearing tickTimer itself, and a later widen is handled by
// narrowQuery's listener above.
if (!bar.hidden) {
  tick();
  // Reduced motion holds the usage figures and status dot steady after one
  // call instead of ticking every 2200ms.
  if (!reducedMotion) {
    tickTimer = setInterval(tick, 2200);
  }
}
