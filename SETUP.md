# Claude Usage Overlay — Setup

Always-on-top tkinter widget showing Claude Pro session (5h) and weekly (7d) usage + reset countdown.

```
5h [████░░] 37%  |  7d [████████] 38%
          resets in 3h 42m
```

## Requirements

- Windows 10/11
- Python 3.x with tkinter (standard in official python.org installer)
- `curl.exe` (built into Windows since Win10 1803 — no install needed)

## Files

```
claude-usage-overlay/
├── overlay.py          ← main script
├── claude-cookies.txt  ← your auth cookies (you create this)
└── claude-overlay.vbs  ← launcher (optional, for background start)
```

## Step 1 — Get cookies

1. Open Chrome/Edge, go to `claude.ai`
2. Open DevTools → Network tab
3. Refresh the page, click any request to `claude.ai`
4. In Headers → Request Headers, find `cookie:` — copy the entire value
5. Paste into `claude-cookies.txt` (one line, no quotes)

## Step 2 — Set your Org ID

Open `overlay.py`, find line ~10:

```python
ORG_ID = 'b93a2be6-793b-46df-8775-dd1e9cb7e118'
```

To find your own:
- In DevTools Network tab, look for a request to `/api/organizations/XXXX/usage`
- The `XXXX` part is your ORG_ID

(If you're Noam — the ID above is already correct.)

## Step 3 — Run

**Option A — double-click:**
```
python overlay.py
```

**Option B — background (no console window):**

Create `claude-overlay.vbs` next to `overlay.py`:
```vbscript
Set sh = CreateObject("WScript.Shell")
sh.Run "pythonw.exe """ & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\overlay.py""", 0, False
```

Double-click the `.vbs` file. To stop: Task Manager → `pythonw.exe` → End Task.

## Usage

- **Drag** anywhere on screen (left-click drag)
- **Right-click** → Refresh now / Toggle always on top / Quit
- Polls every 30 seconds automatically

## Troubleshooting

Check `overlay-debug.log` (created next to `overlay.py`) for errors.

Common issues:
- `No cookies` — `claude-cookies.txt` missing or empty
- `curl exit=0 body[]=<html...` — cookies expired, re-grab from browser
- `session=None%` — ORG_ID wrong, check Network tab
