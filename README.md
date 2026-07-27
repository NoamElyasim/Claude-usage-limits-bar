# Claude Usage Overlay

An always-on-top glass bar showing your Claude usage limits and what Claude Code
is currently doing.

```
● 5h [██████░░░░ 37%]  7d [████░░░░░░ 38%]  ⏱ 3h 42m
```

- **5h + 7d usage** straight from the claude.ai usage API, polled every 30s.
  Green &lt;50% · yellow 50–80% · orange 80–90% · red ≥90%.
- **Claude Code status dot** — blue while a session is working, yellow (blinking)
  when it needs input, green when the turn finished, grey when nothing is running.
- **Real refraction.** The bar captures the desktop behind it and runs it through
  a WebGL shader: bevelled rim, chromatic aberration, frosted interior, bloom.
  `backdrop-filter` can't do this in a transparent window — it only samples the
  page itself — so this samples a live `desktopCapturer` feed instead. The window
  excludes itself from that capture, so there's no feedback loop.
- **Multi-monitor and mixed-DPI aware.** Drag it to another screen and it
  re-acquires that display's capture at that display's scale factor.

Runs on **Windows, macOS and Linux**. See [INSTALL.md](INSTALL.md) to set it up
on a new machine.

## Using it

- **Drag** anywhere on the bar to move it. Its position is remembered.
- **Hover** to lift it and reveal exact reset times for both windows.
- **Right-click** for: Refresh now · Always on top · Start at login ·
  Reset position · Sign in / Sign out · Quit.

## How it fits together

| File | Role |
| --- | --- |
| `main.js` | Window, polling loops, tray-less context menu, screen-capture IPC |
| `index.html` | The bar itself: layout, usage/status rendering, the glass shader |
| `preload.js` | The only bridge between the two (context isolation is on) |
| `src/auth.js` | claude.ai sign-in window + persistent cookie jar |
| `src/usage.js` | Usage API, org-id discovery |
| `src/status.js` | Finds and reads the Claude Code status files |
| `src/config.js` | Per-machine settings in the OS user-data dir |
| `hooks/claude-status.sh` | The Claude Code hook that writes those status files |
| `scripts/install-hooks.js` | Installs that hook and wires it into `settings.json` |

Nothing machine-specific lives in the source: the account is a cookie jar in the
user-data dir, the org id is discovered on first run, and the status directory is
probed. That is what makes it portable.

## Status dot mechanics

The hook writes `/tmp/claude-status/<session-id>` containing `working`, `input`
or `done` on each Claude Code lifecycle event, and deletes it at session end.
The overlay polls that directory once a second and shows the most urgent state
across all live sessions.

Two details that are easy to get wrong, both handled:

- `Notification` fires both for real permission prompts *and* for the idle
  "Claude is waiting for your input" nudge. After `Stop` has run, nothing is
  executing, so that nudge is suppressed instead of turning a finished task
  yellow.
- Background-job sessions never appear in `pgrep -af session-id` — their id only
  exists in the hook payload, never in a process command line. Liveness therefore
  falls back to file recency (15 min), or those sessions would show as grey.

On Windows the overlay runs natively while Claude Code runs inside WSL, so it
reads those files over `\\wsl.localhost\<distro>\tmp\...`, probing every
installed distro.

## Legacy

`overlay.py` and `SETUP.md` are the original tkinter version, Windows-only and
superseded by this app. They are kept only for reference.
