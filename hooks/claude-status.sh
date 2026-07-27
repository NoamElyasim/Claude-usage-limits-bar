#!/bin/bash
# Emits session status to the terminal (tab title + OSC 9;4 taskbar state)
# and records it for the statusline. Must never write to stdout — hook stdout
# is captured by Claude Code (UserPromptSubmit stdout gets injected as context).
state="${1:-done}"
input=$(cat 2>/dev/null)
sid=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
msg=$(echo "$input" | jq -r '.message // empty' 2>/dev/null)

mkdir -p /tmp/claude-status
suppress=0
if [ -n "$sid" ]; then
  f="/tmp/claude-status/$sid"
  if [ "$state" = clear ]; then
    rm -f "$f"
  else
    # Notification fires for real permission prompts AND for the idle "Claude is
    # waiting for your input" nudge. Once Stop has run nothing is executing, so
    # nothing can genuinely be waiting on the user — the turn simply finished.
    # Letting that nudge through turned a completed task yellow, which read as
    # "blocked, needs you" when it was actually done.
    prev=$(cat "$f" 2>/dev/null)
    idle=0
    case "$msg" in *'waiting for your input'*) idle=1 ;; esac
    if [ "$state" = input ] && { [ "$prev" = done ] || [ "$idle" = 1 ]; }; then
      suppress=1
    else
      printf '%s' "$state" > "$f"
    fi
  fi
fi

# SessionEnd doesn't fire for killed/crashed sessions, which leaves stale
# "input" files that make the overlay dot blink yellow forever. Prune any
# status file whose session has no live claude process, on every run.
for f in /tmp/claude-status/*; do
  bn=$(basename "$f")
  case "$bn" in *-*-*-*-*) ;; *) continue ;; esac
  [ "$bn" = "$sid" ] && continue
  pgrep -f "session-id $bn" >/dev/null 2>&1 && continue
  # Background-job sessions never match that pgrep — their id lives only in the
  # hook payload, never in a process command line — so a live bg job would get
  # its own status file deleted here. Only prune once it has also gone quiet.
  [ -n "$(find "$f" -mmin +15 2>/dev/null)" ] && rm -f "$f"
done

# Suppressed idle nudge: leave the tab title and taskbar badge on whatever the
# finished turn already set (green/done) rather than repainting them yellow.
[ "$suppress" = 1 ] && exit 0

# Hooks have no controlling terminal (/dev/tty fails), so walk up the process
# tree to the nearest ancestor (the claude TUI) whose stdout is the real pts.
pts=""
p=$PPID
for _ in 1 2 3 4 5 6; do
  [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null || break
  link=$(readlink "/proc/$p/fd/1" 2>/dev/null)
  case "$link" in /dev/pts/*) pts="$link"; break ;; esac
  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
done
[ -n "$pts" ] && [ -w "$pts" ] || exit 0

case "$state" in
  working) title='⚙️ Claude — working';      osc='3;0'   ;;
  input)   title='🟡 Claude — INPUT NEEDED'; osc='4;100' ;;
  done)    title='🟢 Claude — done';         osc='1;100' ;;
  clear)   title='Claude';                   osc='0;0'   ;;
  *) exit 0 ;;
esac
{ printf '\033]0;%s\007' "$title"; printf '\033]9;4;%s\007' "$osc"; } > "$pts" 2>/dev/null
exit 0
