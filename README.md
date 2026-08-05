<div align="center">

# Claude Usage Overlay

**Know how much Claude you have left, without leaving what you're doing.**

A small always-on-top glass bar showing your 5-hour and 7-day usage limits —
and what Claude Code is doing right now.

Windows · macOS · Linux · MIT

<img src="docs/overlay.png" alt="The overlay bar, hovered, showing 5h and 7d usage and the reset times" width="820">

[Install](#install) · [Using it](#using-it) · [How it works](#how-it-works) · [Full setup guide](INSTALL.md)

</div>

---

## Why

- **Your real limits, not a guess.** Numbers come straight from the same
  claude.ai usage API the web app uses, polled every 30 seconds.
- **See trouble coming.** Bars stage from green to yellow to orange to red, so
  you notice you're near a limit before you hit it, not after.
- **Know when it resets.** Hover the bar and it lifts to show the exact reset
  time for both windows. The countdown to the next 5-hour reset is always on.
- **Watch Claude Code work.** A status dot follows your sessions live — blue
  while working, blinking yellow when it needs you, green when the turn is
  done, grey when nothing is running.
- **Actually made of glass.** The bar captures the desktop behind it and runs
  it through a WebGL shader: bevelled rim, chromatic aberration, frosted
  interior, bloom. `backdrop-filter` cannot do this in a transparent window —
  it only samples the page itself — so this samples a live `desktopCapturer`
  feed instead, excluding itself so there's no feedback loop.
- **Multi-monitor and mixed-DPI aware.** Drag it to another screen and it
  re-acquires that display's capture at that display's scale factor.
- **Nothing to configure.** No API key, no config file to edit, no org id to
  paste. Sign in once through the app's own window; everything else is
  discovered.
- **Stays out of the way.** No dock icon, no taskbar button, no window chrome —
  just the bar, on top of everything, wherever you put it.

## Install

Grab a build from [Releases](../../releases), or run it from source:

```bash
git clone https://github.com/NoamElyasim/claude-usage-overlay
cd claude-usage-overlay
npm install
npm start
```

On first launch a claude.ai sign-in window opens. Use an **email code** —
Google sign-in refuses an embedded browser. The session is stored in the OS
user-data dir and survives restarts, so this is once per machine.

To build an installer instead:

```bash
npm run dist:win     # → dist/*.exe
npm run dist:mac     # → dist/*.dmg
npm run dist:linux   # → dist/*.AppImage
```

Each target has to be built on its own OS. See [INSTALL.md](INSTALL.md) for
per-OS notes, where your data lives, and troubleshooting.

**Want the status dot?** That needs a hook installed into Claude Code itself:

```bash
node scripts/install-hooks.js
```

Run it in the environment Claude Code runs in — a normal shell on macOS and
Linux, or inside WSL on Windows if that is where you run Claude Code. Undo with
`--uninstall`.

## Using it

| Action | What happens |
| --- | --- |
| **Drag** the bar | Moves it. The position is remembered. |
| **Hover** the bar | Lifts it and reveals the exact reset time for both windows. |
| **Click the ⋮ button** | Opens the menu: Refresh now · Always on top · Start at login · Reset position · Sign in / Sign out · Quit. |

The menu sits behind a button rather than a right-click because the bar is a
drag surface — Windows hit-tests that as the window caption and answers a
right-click with its own Move/Size/Close menu before the app ever sees it.

## What the bar tells you

| Element | Meaning |
| --- | --- |
| `5h` bar | The 5-hour window, as a percentage of the limit |
| `7d` bar | The 7-day window |
| Bar colour | Green under 50% · yellow 50–80% · orange 80–90% · red 90%+ |
| `⏱` | Time left until the 5-hour window resets |
| Dot, blue | A Claude Code session is working |
| Dot, yellow blinking | A session needs your input |
| Dot, green | The turn finished |
| Dot, grey | Nothing is running |
| `—` in place of a number | The usage request failed: expired session or no network. It retries every 30s |
| `⚠ sign in` | No claude.ai session — open the menu → *Sign in to Claude…* |

## How it works

| File | Role |
| --- | --- |
| `main.js` | Window, polling loops, menu, screen-capture IPC |
| `index.html` | The bar itself: layout, usage/status rendering, the glass shader |
| `preload.js` | The only bridge between the two (context isolation is on) |
| `src/auth.js` | claude.ai sign-in window + persistent cookie jar |
| `src/usage.js` | Usage API, org-id discovery |
| `src/status.js` | Finds and reads the Claude Code status files |
| `src/config.js` | Per-machine settings in the OS user-data dir |
| `hooks/claude-status.sh` | The Claude Code hook that writes those status files |
| `scripts/install-hooks.js` | Installs that hook and wires it into `settings.json` |

Nothing machine-specific lives in the source: the account is a cookie jar in
the user-data dir, the org id is discovered on first run, and the status
directory is probed. That is what makes it portable.

### Status dot mechanics

The hook writes `/tmp/claude-status/<session-id>` containing `working`, `input`
or `done` on each Claude Code lifecycle event, and deletes it at session end.
The overlay polls that directory once a second and shows the most urgent state
across all live sessions.

Two details that are easy to get wrong, both handled:

- `Notification` fires both for real permission prompts *and* for the idle
  "Claude is waiting for your input" nudge. After `Stop` has run, nothing is
  executing, so that nudge is suppressed instead of turning a finished task
  yellow.
- Background-job sessions never appear in `pgrep -af session-id` — their id
  only exists in the hook payload, never in a process command line. Liveness
  therefore falls back to file recency (15 min), or those sessions would show
  as grey.

On Windows the overlay runs natively. If Claude Code runs inside WSL — the
usual setup — it reads those files over `\\wsl.localhost\<distro>\tmp\...`,
probing every installed distro; when Claude Code runs natively too, it finds
them in `%TEMP%\claude-status`.

### Development

```bash
npm start          # run from source
npm run hovertest  # hover hit-test regression check
npm run glasslab   # shader tuning harness
```

The bar calls `setContentProtection(true)` so the shader does not capture
itself, which also makes it invisible to every screenshot tool. `hovertest`
exists because of that: the hover behaviour cannot be eyeballed on the live
bar, so it is asserted against a scripted cursor instead.

## Legacy

`overlay.py` and `SETUP.md` are the original tkinter version, Windows-only and
superseded by this app. They are kept only for reference.

## License

MIT — see [LICENSE](LICENSE).
