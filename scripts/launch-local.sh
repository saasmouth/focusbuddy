#!/usr/bin/env bash
# Launch the installed app, and un-suspend it if macOS stops it on the way up.
#
# WHY THIS EXISTS. On this machine a freshly installed build is left in state
# `T` (stopped) immediately after launch, with ~32KB resident and no renderer
# helpers. A stopped process never draws a window, so the dock bounces until
# LaunchServices gives up and reports "PlexiDesk is not responding" — which
# reads exactly like a crash, and sent one bug report chasing a white screen
# that was never the problem.
#
# It is not a crash: there is no crash report, and the process is healthy the
# instant it is resumed (32KB -> ~217MB, four renderer helpers, window up). The
# suspension lasts well past a minute, and `xprotectd` is running, so the most
# likely suspender is macOS scanning a newly-signed 982MB bundle. Whatever the
# cause, SIGCONT is the remedy, and doing it by hand is not a remedy at all.
#
# So: open the app, watch briefly, and resume it if it is stopped.
set -uo pipefail

APP="${1:-}"
if [ -z "$APP" ]; then
  # Newest installed PlexiDesk bundle, which is what install-local just wrote.
  APP=$(/bin/ls -dt /Applications/PlexiDesk*.app 2>/dev/null | head -1)
fi
if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "[launch] no PlexiDesk app found in /Applications" >&2
  exit 1
fi

BIN="$APP/Contents/MacOS/PlexiDesk"
echo "[launch] $APP"

# A stopped process from an earlier attempt keeps the single-instance lock, so
# every later launch defers to something that will never draw a window. Clear
# those out first — they are the reason a second double-click does nothing.
STALE=$(pgrep -f "$BIN" 2>/dev/null || true)
if [ -n "$STALE" ]; then
  for p in $STALE; do
    state=$(ps -o stat= -p "$p" 2>/dev/null | tr -d ' ')
    case "$state" in
      T*) echo "[launch] resuming already-stopped pid $p"; kill -CONT "$p" 2>/dev/null || true ;;
    esac
  done
fi

open -a "$APP" 2>/dev/null || true

# Watch for up to 60s. Resume on sight; report honestly if it never settles.
deadline=$(( $(date +%s) + 60 ))
resumed=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  pid=$(pgrep -f "$BIN" 2>/dev/null | head -1 || true)
  [ -z "$pid" ] && continue
  state=$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ')
  case "$state" in
    T*)
      kill -CONT "$pid" 2>/dev/null || true
      resumed=1
      ;;
    S*|R*)
      # Running is not the same as drawing: wait for a renderer helper, which
      # is the first point at which there is actually a window to look at.
      # ps|grep rather than pgrep: the bundle path contains spaces and a
      # version with dots, and pgrep -fc matched nothing for it even while
      # four helpers were plainly running — which made this script report a
      # healthy app as a failure.
      helpers=$(ps aux | grep -c "[P]lexiDesk.*\.app/Contents/Frameworks" || true)
      if [ "${helpers:-0}" -ge 1 ]; then
        rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')
        echo "[launch] up — pid $pid, ${rss}KB, $helpers helper process(es)$([ "$resumed" = 1 ] && echo ' (had to resume it)')"
        exit 0
      fi
      ;;
  esac
done

pid=$(pgrep -f "$BIN" 2>/dev/null | head -1 || true)
echo "[launch] did NOT come up within 60s (pid=${pid:-none} state=$(ps -o stat= -p "${pid:-0}" 2>/dev/null | tr -d ' '))" >&2
echo "[launch] resume it by hand with:  kill -CONT \$(pgrep -f 'PlexiDesk.app/Contents/MacOS')" >&2
exit 1
