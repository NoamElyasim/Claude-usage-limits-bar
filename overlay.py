import tkinter as tk
import json
import os
import subprocess
import threading
import datetime
import time

# ─── Config ───────────────────────────────────────────────────────────────────

ORG_ID     = 'b93a2be6-793b-46df-8775-dd1e9cb7e118'
USAGE_URL  = f'https://claude.ai/api/organizations/{ORG_ID}/usage'
CURL_EXE   = r'C:\Windows\System32\curl.exe'

HERE         = os.path.dirname(os.path.abspath(__file__))
COOKIES_FILE = os.path.join(HERE, 'claude-cookies.txt')
LOG_FILE     = os.path.join(HERE, 'overlay-debug.log')

POLL_MS = 30_000

# ─── Claude Code session status (state files written by WSL hooks) ────────────

STATUS_DIR     = r'\\wsl.localhost\Ubuntu\tmp\claude-status'
STATUS_POLL_MS = 1_000
STATUS_STALE_S = 12 * 3600   # ignore files from crashed/abandoned sessions

# ─── Layout ───────────────────────────────────────────────────────────────────
# [● status] [5h ████░░ 27%] | [7d ████████ 55%]

WIN_W    = 400
WIN_H    = 62
BAR_H    = 7
STATUS_W = 18   # space reserved for the status dot

# ─── Colors ───────────────────────────────────────────────────────────────────

C_WHITE  = '#ffffff'
C_YELLOW = '#FFD700'
C_RED    = '#FF4444'
C_DIM    = '#666666'
C_BG     = '#1e1e1e'
C_TRACK  = '#383838'

C_ST_WORKING  = '#3B82F6'
C_ST_INPUT    = '#FFD700'
C_ST_INPUT_LO = '#8a7500'   # dim phase of the input blink
C_ST_DONE     = '#4CAF50'
C_ST_NONE     = '#555555'

# ─── Logging ──────────────────────────────────────────────────────────────────

_log_lock = threading.Lock()

def _log(msg):
    try:
        ts = datetime.datetime.now().strftime('%H:%M:%S')
        with _log_lock:
            with open(LOG_FILE, 'a', encoding='utf-8') as f:
                f.write(f'[{ts}] {msg}\n')
    except Exception:
        pass

def _fmt_reset(reset_dt):
    if reset_dt is None:
        return '—'
    now = datetime.datetime.now(datetime.timezone.utc)
    remaining = (reset_dt - now).total_seconds()
    if remaining <= 0:
        return 'resetting…'
    h, rem = divmod(int(remaining), 3600)
    m = rem // 60
    if h:
        return f'resets in {h}h {m:02d}m'
    return f'resets in {m}m'

# ─── Cookies ──────────────────────────────────────────────────────────────────

def get_cookies():
    if not os.path.exists(COOKIES_FILE):
        return None
    with open(COOKIES_FILE, encoding='utf-8') as f:
        val = f.read().strip()
    return val or None

# ─── Fetch ────────────────────────────────────────────────────────────────────

def fetch_usage():
    cookies = get_cookies()
    if not cookies:
        _log('No cookies')
        return None, None, None

    cmd = [
        CURL_EXE, '-s', '--max-time', '10',
        '-H', f'Cookie: {cookies}',
        '-H', 'Accept: application/json',
        '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        '-H', 'Referer: https://claude.ai/settings',
        '-H', 'sec-fetch-dest: empty',
        '-H', 'sec-fetch-mode: cors',
        '-H', 'sec-fetch-site: same-origin',
        USAGE_URL,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        body = result.stdout.strip()
        _log(f'curl exit={result.returncode} body[:200]={body[:200]}')
        if not body or body.startswith('<'):
            return None, None, None

        data = json.loads(body)
        limits = data.get('limits') or []

        session_pct = weekly_pct = None
        for lim in limits:
            pct = lim.get('percent')
            if pct is None:
                continue
            group = lim.get('group', '')
            kind  = lim.get('kind', '')
            if group == 'session' or kind == 'session':
                session_pct = int(pct)
            elif group == 'weekly' or 'weekly' in kind:
                weekly_pct = int(pct)

        if session_pct is None:
            v = (data.get('five_hour') or {}).get('utilization')
            if isinstance(v, (int, float)):
                session_pct = int(v)
        if weekly_pct is None:
            v = (data.get('seven_day') or {}).get('utilization')
            if isinstance(v, (int, float)):
                weekly_pct = int(v)

        # Parse reset time directly from API response
        reset_dt = None
        raw_reset = (data.get('five_hour') or {}).get('resets_at')
        if raw_reset:
            try:
                reset_dt = datetime.datetime.fromisoformat(raw_reset)
            except Exception:
                pass

        _log(f'session={session_pct}% weekly={weekly_pct}% resets_at={raw_reset}')
        return session_pct, weekly_pct, reset_dt

    except subprocess.TimeoutExpired:
        _log('curl timeout')
        return None, None, None
    except Exception as e:
        _log(f'fetch error: {e}')
        return None, None, None

def _live_session_ids():
    """cmdline text of live WSL processes, or None if the check itself failed
    (e.g. WSL down) — callers must not treat None as "nothing is live"."""
    try:
        result = subprocess.run(
            ['wsl.exe', '-e', 'pgrep', '-af', 'session-id'],
            capture_output=True, text=True, timeout=3,
            creationflags=subprocess.CREATE_NO_WINDOW)
        return result.stdout
    except Exception:
        return None


def read_claude_status():
    """Aggregate Claude Code state across sessions: input > working > done.

    A closed/killed window leaves its status file behind (no SessionEnd
    hook fires), so liveness is checked directly here instead of waiting
    on STATUS_STALE_S or another session's hook to prune it."""
    try:
        states = set()
        now = time.time()
        live = _live_session_ids()
        with os.scandir(STATUS_DIR) as it:
            for e in it:
                try:
                    if not e.is_file() or now - e.stat().st_mtime > STATUS_STALE_S:
                        continue
                    if live is not None and e.name not in live:
                        continue
                    with open(e.path, encoding='utf-8') as f:
                        states.add(f.read().strip())
                except OSError:
                    continue
        for s in ('input', 'working', 'done'):
            if s in states:
                return s
        return None
    except OSError:
        return None

# ─── Poller ───────────────────────────────────────────────────────────────────

class Poller:
    def __init__(self, callback):
        self.callback = callback

    def poll(self):
        def _run():
            session_pct, weekly_pct, reset_dt = fetch_usage()
            self.callback(session_pct, weekly_pct, reset_dt)
        threading.Thread(target=_run, daemon=True).start()

# ─── UI ───────────────────────────────────────────────────────────────────────

def _color(pct):
    if pct is None:
        return C_DIM
    return C_RED if pct >= 90 else (C_YELLOW if pct >= 75 else C_WHITE)


class Overlay:
    def __init__(self):
        self.root = tk.Tk()
        self.root.overrideredirect(True)
        self.root.attributes('-topmost', True)
        self.root.attributes('-alpha', 0.92)
        self.root.configure(bg=C_BG)
        self.root.resizable(False, False)

        sw = self.root.winfo_screenwidth()
        self.root.geometry(f'{WIN_W}x{WIN_H}+{(sw - WIN_W) // 2}+0')

        self.canvas = tk.Canvas(
            self.root, width=WIN_W, height=WIN_H,
            bg=C_BG, highlightthickness=0)
        self.canvas.pack()

        self._build_ui()
        self._bind_drag()
        self._bind_menu()

        self.poller = Poller(self._on_result)
        self._schedule()

        self._status_thread = None
        self._blink = False
        self._schedule_status()

    def _build_ui(self):
        mid   = WIN_H // 2
        # Left section: x 10..175   Right section: x 205..370
        # Separator "|" at x 190

        # ── status dot ─────────────────────────────────────────
        self._status_dot = self.canvas.create_oval(
            8, mid - 5, 18, mid + 5, fill=C_ST_NONE, outline=C_ST_NONE)

        # ── left (5h) ──────────────────────────────────────────
        LBL_W   = 18   # "5h" text
        PCT_W   = 36   # "27%" text
        PAD     = 10
        SEP_X   = WIN_W // 2
        BAR_W_L = SEP_X - PAD - STATUS_W - LBL_W - 4 - PCT_W - 8 - PAD   # bar width

        lx1 = PAD + STATUS_W
        lx2 = lx1 + LBL_W
        bx1 = lx2 + 4
        bx2 = bx1 + BAR_W_L
        px  = bx2 + 6

        by1 = mid - BAR_H // 2
        by2 = by1 + BAR_H

        self.canvas.create_text(lx1, mid, text='5h', anchor='w',
                                fill=C_DIM, font=('Segoe UI', 8))
        self.canvas.create_rectangle(bx1, by1, bx2, by2, fill=C_TRACK, outline='')
        self._bar_l = self.canvas.create_rectangle(bx1, by1, bx1, by2, fill=C_WHITE, outline='')
        self._lbl_l = self.canvas.create_text(px, mid, text='…', anchor='w',
                                              fill=C_DIM, font=('Segoe UI', 9, 'bold'))
        self._bx1_l, self._bx2_l = bx1, bx2
        self._by1_l, self._by2_l = by1, by2

        # separator
        self.canvas.create_text(SEP_X, mid, text='|',
                                fill=C_DIM, font=('Segoe UI', 11))

        # ── right (7d) ─────────────────────────────────────────
        rx1 = SEP_X + 10
        rx2 = rx1 + LBL_W
        rbx1 = rx2 + 4
        rbx2 = WIN_W - PAD - PCT_W - 6
        rpx  = rbx2 + 6

        self.canvas.create_text(rx1, mid, text='7d', anchor='w',
                                fill=C_DIM, font=('Segoe UI', 8))
        self.canvas.create_rectangle(rbx1, by1, rbx2, by2, fill=C_TRACK, outline='')
        self._bar_r = self.canvas.create_rectangle(rbx1, by1, rbx1, by2, fill=C_WHITE, outline='')
        self._lbl_r = self.canvas.create_text(rpx, mid, text='…', anchor='w',
                                              fill=C_DIM, font=('Segoe UI', 9, 'bold'))
        self._bx1_r, self._bx2_r = rbx1, rbx2
        self._by1_r, self._by2_r = by1, by2

        # ── reset countdown ────────────────────────────────────
        self._reset_txt = self.canvas.create_text(
            WIN_W // 2, mid + 18, text='—',
            anchor='center', fill='#777777', font=('Segoe UI', 7))

    def _draw_bar(self, bar_id, lbl_id, bx1, bx2, by1, by2, pct):
        if pct is None:
            self.canvas.coords(bar_id, bx1, by1, bx1, by2)
            self.canvas.itemconfig(bar_id, fill=C_TRACK)
            self.canvas.itemconfig(lbl_id, text='—', fill=C_DIM)
            return
        pct = max(0, min(100, pct))
        c   = _color(pct)
        fx2 = bx1 + int((bx2 - bx1) * pct / 100)
        self.canvas.coords(bar_id, bx1, by1, fx2, by2)
        self.canvas.itemconfig(bar_id, fill=c)
        self.canvas.itemconfig(lbl_id, text=f'{pct}%', fill=c)

    def _on_result(self, session_pct, weekly_pct, reset_dt=None):
        self.root.after(0, lambda: self._draw(session_pct, weekly_pct, reset_dt))

    def _draw(self, session_pct, weekly_pct, reset_dt=None):
        self._draw_bar(self._bar_l, self._lbl_l,
                       self._bx1_l, self._bx2_l,
                       self._by1_l, self._by2_l, session_pct)
        self._draw_bar(self._bar_r, self._lbl_r,
                       self._bx1_r, self._bx2_r,
                       self._by1_r, self._by2_r, weekly_pct)
        self.canvas.itemconfig(self._reset_txt, text=_fmt_reset(reset_dt))

    def _schedule(self):
        self.poller.poll()
        self.root.after(POLL_MS, self._schedule)

    def _schedule_status(self):
        # UNC reads can hang if WSL is down — keep them off the UI thread and
        # never stack a second reader on top of a stuck one.
        if self._status_thread is None or not self._status_thread.is_alive():
            t = threading.Thread(target=self._status_worker, daemon=True)
            self._status_thread = t
            t.start()
        self.root.after(STATUS_POLL_MS, self._schedule_status)

    def _status_worker(self):
        st = read_claude_status()
        self.root.after(0, lambda: self._draw_status(st))

    def _draw_status(self, st):
        color = {'working': C_ST_WORKING,
                 'input':   C_ST_INPUT,
                 'done':    C_ST_DONE}.get(st, C_ST_NONE)
        if st == 'input':
            self._blink = not self._blink
            if self._blink:
                color = C_ST_INPUT_LO
        self.canvas.itemconfig(self._status_dot, fill=color, outline=color)

    def _bind_drag(self):
        self._dx = self._dy = 0
        def press(e): self._dx, self._dy = e.x, e.y
        def drag(e):
            x = self.root.winfo_x() + e.x - self._dx
            y = self.root.winfo_y() + e.y - self._dy
            self.root.geometry(f'+{x}+{y}')
        self.canvas.bind('<ButtonPress-1>', press)
        self.canvas.bind('<B1-Motion>', drag)

    def _bind_menu(self):
        self._aot = True
        menu = tk.Menu(self.root, tearoff=0)
        menu.add_command(label='Refresh now', command=lambda: self.poller.poll())
        menu.add_command(label='Toggle always on top', command=self._toggle_aot)
        menu.add_separator()
        menu.add_command(label='Quit', command=self.root.destroy)
        def show(e):
            try: menu.tk_popup(e.x_root, e.y_root)
            finally: menu.grab_release()
        self.canvas.bind('<Button-3>', show)

    def _toggle_aot(self):
        self._aot = not self._aot
        self.root.attributes('-topmost', self._aot)

    def run(self):
        self.root.mainloop()


if __name__ == '__main__':
    _log('=== Overlay started ===')
    Overlay().run()
