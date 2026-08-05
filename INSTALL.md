# Installing on a new machine

Two independent halves:

1. **The overlay app** — shows usage numbers. Needs a claude.ai login (done in
   the app itself, no files to copy).
2. **The status hooks** — make the dot follow Claude Code. Installed into
   `~/.claude` wherever Claude Code runs.

Do part 1 for the usage bars. Add part 2 if you want the dot to work.

---

## 1. The overlay app

Pick one. Most people want Option A.

| You want to | Use | Needs |
| --- | --- | --- |
| Just run the bar | **A — download a build** | nothing |
| Work on the code | **B — run from source** | Node 18+ |
| Produce installers | **C — build them** | Node 18+, and the target OS |

### Option A — download a build

Grab the latest from [Releases](../../releases/latest):

| File | For |
| --- | --- |
| `Claude Usage Overlay Setup <version>.exe` | Windows, installed |
| `Claude Usage Overlay <version>.exe` | Windows, portable — no install |

Windows builds are unsigned, so SmartScreen warns on first launch:
**More info → Run anyway**. macOS and Linux builds are not published; produce
them with Option C on those machines.

### Option B — run from source (any OS)

Needs Node 18+.

```bash
git clone https://github.com/NoamElyasim/Claude-usage-limits-bar
cd Claude-usage-limits-bar
npm install
npm start
```

A clone is *source*, not a runnable app: `node_modules` and `dist` are
deliberately not in the repository, so `npm install` is not optional.

On first launch a claude.ai login window opens. Sign in with an **email code** —
Google sign-in may refuse an embedded browser. The session is stored in the OS
user-data dir and survives restarts, so this is once per machine.

### Option C — build an installer

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
and the ⋮ menu gains an *Allow screen recording…* item. Grant it in
System Settings → Privacy & Security → Screen Recording, then restart the app.
The app has no Dock icon by design — use the ⋮ button on the bar for the menu.

**Windows.** The overlay is a desktop app: install and run it **natively on
Windows**, never inside WSL — there is no desktop in there for it to draw on.
If Claude Code runs inside WSL (the usual setup), the two halves land in
different places, which is normal:

| Half | Where it goes |
| --- | --- |
| The overlay app | Windows — the release `.exe`, or `npm start` in a Windows shell |
| The status hooks | *Inside WSL*, because that is where Claude Code writes `/tmp/claude-status` |

If Claude Code runs natively on Windows too (via Git Bash), install the hooks
there instead; the overlay probes `%TEMP%\claude-status` as well, so both work
at once with no configuration. The hook needs `jq` and Git Bash does not ship
it — `winget install jqlang.jq`, then make sure `jq` is on the PATH the hook
sees.

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

### Replacing an older install

Nothing carries over between machines, and that is deliberate — sign in again,
and the window position starts at the default. Start-at-login defaults on, so
a fresh install registers itself.

Remove the old one first, in this order:

1. **Stop it.** The tkinter version is a `pythonw.exe` process; the Electron one
   is `Claude Usage Overlay.exe`. Task Manager will do.
2. **Remove its autostart.** Press <kbd>Win</kbd>+<kbd>R</kbd>, run
   `shell:startup`, and delete any overlay `.vbs` or shortcut there. The tkinter
   version launched from a `.vbs` in that folder, and it will keep coming back
   after every reboot until it is gone.
3. **Uninstall properly** if an older *Electron* build is installed — Settings →
   Apps, or `Uninstall Claude Usage Overlay.exe` in its folder. Deleting the
   folder by hand leaves the uninstall entry and the login item behind.

Your settings survive an in-place upgrade: the installer writes to
`%LOCALAPPDATA%\Programs`, while cookies and `config.json` live in `%APPDATA%`
and are untouched.

---

## 2. The Claude Code status hooks

Run this **in the environment Claude Code itself runs in** — a normal shell on
macOS/Linux, or *inside WSL* on Windows. It needs a clone, so this is the one
part that wants the source even if you installed the app from a release:

```bash
git clone https://github.com/NoamElyasim/Claude-usage-limits-bar
cd Claude-usage-limits-bar
node scripts/install-hooks.js
```

`npm install` is not needed for this — the script only uses Node's standard
library. On WSL, clone inside the WSL filesystem (`~/`), not `/mnt/c`.

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
| Bar shows `⚠ sign in` | No claude.ai session — ⋮ menu → *Sign in to Claude…* |
| Bars show `—` | Usage request failed: expired session or no network. It retries every 30s |
| Bar is a plain dark pill | Live capture unavailable — screen-recording permission, or no WebGL |
| Dot stuck grey | Hooks not installed, or the status dir isn't being found (above) |
| Bar off-screen after unplugging a monitor | It clamps to a visible display on launch; or ⋮ menu → *Reset position* |
