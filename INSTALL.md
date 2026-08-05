# Installing on a new machine

Two independent halves:

1. **The overlay app** — shows usage numbers. Needs a claude.ai login (done in
   the app itself, no files to copy).
2. **The status hooks** — make the dot follow Claude Code. Installed into
   `~/.claude` wherever Claude Code runs.

Do part 1 for the usage bars. Add part 2 if you want the dot to work.

---

## 1. The overlay app

Download the file for your system from
[the latest release](../../releases/latest), then follow that one section.
Nothing to install first — no Node, no clone.

| System | File | What to do |
| --- | --- | --- |
| Windows | `Claude Usage Limits Bar Setup <version>.exe` | Run it |
| Windows, no install | `Claude Usage Limits Bar <version>.exe` | Run it — portable |
| macOS | `Claude Usage Limits Bar-<version>.dmg` | Open, drag to Applications |
| Linux | `Claude Usage Limits Bar-<version>.AppImage` | `chmod +x`, then run |

Nothing here is code-signed — there is no Apple certificate and no Windows
one — so each OS objects once, in its own way. That is the only awkward part of
the install, and it is a one-time click.

**Windows.** SmartScreen shows a blue box: **More info → Run anyway**.

**macOS.** First launch must be **right-click → Open**, not a double-click. If
Gatekeeper refuses outright:

```bash
xattr -dr com.apple.quarantine "/Applications/Claude Usage Limits Bar.app"
```

**Linux.** An AppImage is the application; there is no install step.

```bash
chmod +x 'Claude Usage Limits Bar-'*.AppImage
./'Claude Usage Limits Bar-'*.AppImage
```

Then sign in with an **email code** — Google sign-in may refuse an embedded
browser. The session is stored in the OS user-data dir and survives restarts,
so this is once per machine.

### Running from source instead

Needs Node 18+.

```bash
git clone https://github.com/NoamElyasim/Claude-usage-limits-bar
cd Claude-usage-limits-bar
npm install
npm start
```

A clone is *source*, not a runnable app: `node_modules` and `dist` are
deliberately not in the repository, so `npm install` is not optional.

### Building installers

```bash
npm run dist:win     # → dist/*.exe        (must be run on Windows)
npm run dist:mac     # → dist/*.dmg        (must be run on macOS)
npm run dist:linux   # → dist/*.AppImage
```

Each target has to be built on its own OS, which is why
`.github/workflows/release.yml` builds all three on GitHub's runners and
attaches them to the release whenever a `v*` tag is pushed. To fill in a tag
that already exists, run that workflow manually and give it the tag.

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
   is `Claude Usage Limits Bar.exe`, or `Claude Usage Overlay.exe` if it predates
   the 1.2.0 rename. Task Manager will do.
2. **Remove its autostart.** Press <kbd>Win</kbd>+<kbd>R</kbd>, run
   `shell:startup`, and delete any overlay `.vbs` or shortcut there. The tkinter
   version launched from a `.vbs` in that folder, and it will keep coming back
   after every reboot until it is gone.
3. **Uninstall properly** if an older *Electron* build is installed — Settings →
   Apps, or the `Uninstall …exe` in its folder. Deleting the folder by hand
   leaves the uninstall entry and the login item behind.

**Upgrading across the 1.2.0 rename.** The app was called *Claude Usage
Overlay* until 1.2.0, and the rename changed its `appId`, so the new installer
does **not** replace the old one — uninstall the old app or you get two of
everything, two entries in Apps and two login items. Your session and settings
do carry over: on first launch the app copies the old user-data directory to
the new one, so you stay signed in and the bar reappears where you left it. The
old directory is copied, not moved, and can be deleted once you are happy.

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
