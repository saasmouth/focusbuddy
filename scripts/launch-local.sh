#!/usr/bin/env bash
# Launch the installed app, and un-suspend it if macOS stops it on the way up.
#
# WHY THIS EXISTS. On this machine a freshly installed build is left in state
# `T` (stopped) immediately after launch, with ~32KB resident and no renderer
# helpers. A stopped process never draws a window, so the dock bounces until
# LaunchServices gives up and reports "PlexiiDesk is not responding" — which
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

APP=""
for a in "$@"; do
  case "$a" in
    --restart) ;;
    *) [ -z "$APP" ] && APP="$a" ;;
  esac
done
if [ -z "$APP" ]; then
  # Newest installed bundle, which is what install-local just wrote. Either
  # spelling: "PlexiiDesk …" from 4.3.33, "PlexiDesk …" before.
  APP=$(/bin/ls -dt /Applications/PlexiiDesk*.app /Applications/PlexiDesk*.app 2>/dev/null | head -1)
fi
if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "[launch] no PlexiiDesk app found in /Applications" >&2
  exit 1
fi

# The executable follows productName ("PlexiiDesk" from 4.3.33, "PlexiDesk"
# before), so read it from the bundle rather than assuming either.
EXE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist" 2>/dev/null || echo PlexiiDesk)"
BIN="$APP/Contents/MacOS/$EXE"
echo "[launch] $APP"

# A stopped process from an earlier attempt keeps the single-instance lock, so
# every later launch defers to something that will never draw a window. Clear
# those out first — they are the reason a second double-click does nothing.
# A RUNNING INSTANCE IS THE OLD BUILD after an install, and `open` would simply
# focus it — which is exactly what happened: the warm-up reported "up" against a
# process that had started 45 minutes before the bundle it was supposed to be
# testing, so a freshly installed build sat on disk while the previous one stayed
# on screen. --restart (which install-local passes) ends it first.
#
# A stopped instance is cleared regardless: it holds the single-instance lock, so
# every later launch defers to a window that will never draw.
RESTART=0
for a in "$@"; do [ "$a" = "--restart" ] && RESTART=1; done

STALE=$(pgrep -f "$BIN" 2>/dev/null || true)
if [ -n "$STALE" ]; then
  for p in $STALE; do
    state=$(ps -o stat= -p "$p" 2>/dev/null | tr -d ' ')
    case "$state" in
      T*) echo "[launch] resuming already-stopped pid $p"; kill -CONT "$p" 2>/dev/null || true ;;
    esac
  done
  if [ "$RESTART" = "1" ]; then
    echo "[launch] quitting the running instance so the NEW build is what starts"
    pkill -f "$BIN" 2>/dev/null || true
    # Give it a moment to release the single-instance lock, then insist.
    deadline=$(( $(date +%s) + 8 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      pgrep -f "$BIN" >/dev/null 2>&1 || break
    done
    pkill -9 -f "$BIN" 2>/dev/null || true
    rm -f "$HOME/Library/Application Support/plexii/SingletonLock" \
          "$HOME/Library/Application Support/plexii/SingletonCookie" \
          "$HOME/Library/Application Support/plexii/SingletonSocket" 2>/dev/null || true
  fi
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
      # Scoped to THIS bundle's path: a pattern matching any PlexiDesk bundle
      # counted an older, still-running build's helpers and reported the new
      # one "up" when it had in fact handed off to that older instance.
      helpers=$(ps axo args= | grep -F "$APP/Contents/Frameworks" | grep -vc grep || true)
      if [ "${helpers:-0}" -ge 1 ]; then
        rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')
        # Report the age of the process against the bundle, so a stale instance
        # can never again be reported as a successful launch.
        asar_age=$(( $(date +%s) - $(stat -f %m "$APP/Contents/Resources/app.asar" 2>/dev/null || date +%s) ))
        proc_age=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
        echo "[launch] up — pid $pid, ${rss}KB, $helpers helper process(es), running for ${proc_age:-?} (bundle installed ${asar_age}s ago)$([ "$resumed" = 1 ] && echo ' (had to resume it)')"
        exit 0
      fi
      ;;
  esac
done

pid=$(pgrep -f "$BIN" 2>/dev/null | head -1 || true)
echo "[launch] did NOT come up within 60s (pid=${pid:-none} state=$(ps -o stat= -p "${pid:-0}" 2>/dev/null | tr -d ' '))" >&2
echo "[launch] resume it by hand with:  kill -CONT \$(pgrep -f '$BIN')" >&2
exit 1
