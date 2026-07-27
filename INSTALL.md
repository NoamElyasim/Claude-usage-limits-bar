# Installing on a new machine

Two independent halves:

1. **The overlay app** — shows usage numbers. Needs a claude.ai login (done in
   the app itself, no files to copy).
2. **The status hooks** — make the dot follow Claude Code. Installed into
   `~/.claude` wherever Claude Code runs.

Do part 1 for the usage bars. Add part 2 if you want the dot to work.

---

## 1. The overlay app

### Option A — run from source (any OS)

Needs Node 18+.

```bash
git clone <your-repo-url> claude-usage-overlay
cd claude-usage-overlay
npm install
npm start
```

On first launch a claude.ai login window opens. Sign in with an **email code** —
Google sign-in may refuse an embedded browser. The session is stored in the OS
user-data dir and survives restarts, so this is once per machine.

### Option B — build an installer

```bash
npm run dist:win     # → dist/*.exe   (must be run on Windows)
npm run dist:mac     # → dist/*.dmg   (must be run on macOS)
npm run dist:linux   # → dist/*.AppImage
```

Each target has to be built on its own OS: the mac build needs `codesign` and
the Windows build needs to stamp the .exe, neither of which cross-compiles here.

The macOS build is unsigned, so the first launch needs
**right-click → Open** (or `xattr -dr com.apple.quarantine "/Applications/Claude Usage Overlay.app"`).

### Per-OS notes

**macOS.** The refraction effect needs Screen Recording permission. macOS asks
on first launch; if you miss the prompt, the bar falls back to a plain dark pill
and right-click gains an *Allow screen recording…* item. Grant it in
System Settings → Privacy & Security → Screen Recording, then restart the app.
The app has no Dock icon by design — right-click the bar itself for the menu.

**Windows.** Nothing special. If Claude Code runs inside WSL (the usual setup),
install the hooks *inside WSL* — see below.

**Linux.** Live capture needs a compositor that allows `desktopCapturer`. Under
Wayland this depends on the portal implementation; on X11 it just works. Without
it, everything except the refraction still works.

### Where your data lives

| What | Where |
| --- | --- |
| claude.ai session cookies | Electron user-data dir (`%APPDATA%`, `~/Library/Application Support`, `~/.config`) |
| Org id, window position, settings | `config.json` in the same folder |

Nothing sensitive is stored in the app folder, and nothing has to be edited into
the source. **Don't copy `claude-cookies.txt` between machines** — it's a live
session credential, and it's no longer needed: it exists only to bootstrap
machines upgraded from the pre-1.1 setup, and is `.gitignore`d.

---

## 2. The Claude Code status hooks

Run this **in the environment Claude Code itself runs in** — a normal shell on
macOS/Linux, or *inside WSL* on Windows:

```bash
node scripts/install-hooks.js
```

It copies `hooks/claude-status.sh` to `~/.claude/hooks/` and wires five events
(`UserPromptSubmit`, `Notification`, `PermissionRequest`, `Stop`, `SessionEnd`)
into `~/.claude/settings.json`, merging with whatever is already there and
writing a timestamped backup first. Restart Claude Code afterwards.

Undo with `node scripts/install-hooks.js --uninstall`.

### Checking it worked

```bash
ls /tmp/claude-status/     # one file per live session, after you send a prompt
cat /tmp/claude-status/*   # working | input | done
```

If files appear there but the dot stays grey, the overlay isn't finding the
directory. It probes `/tmp/claude-status` on macOS/Linux, and on Windows
`%TEMP%\claude-status` plus `\\wsl.localhost\<distro>\tmp\claude-status` for
every installed WSL distro. Override it in `config.json`:

```json
{ "statusDirs": ["\\\\wsl.localhost\\Ubuntu\\tmp\\claude-status"] }
```

or with the `CLAUDE_STATUS_DIR` environment variable.

The hook also paints the terminal tab title and taskbar badge. That part is
independent of the overlay — if you don't want it, delete the block after the
`pts` lookup in `claude-status.sh`.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Bar shows `⚠ sign in` | No claude.ai session — right-click → *Sign in to Claude…* |
| Bars show `—` | Usage request failed: expired session or no network. It retries every 30s |
| Bar is a plain dark pill | Live capture unavailable — screen-recording permission, or no WebGL |
| Dot stuck grey | Hooks not installed, or the status dir isn't being found (above) |
| Bar off-screen after unplugging a monitor | It clamps to a visible display on launch; or right-click → *Reset position* |
