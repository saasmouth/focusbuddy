# The feed-flip lock: one release at a time may change the live update feeds.
#
# Sourced by scripts/release-mac.sh (bash 3.2 compatible: macOS's /bin/bash).
#
# The R2 upload in a release flips the LIVE update feed (dl.plexiidesk.com).
# Anything that reads the live feeds while they move sees a half-changed
# world: on 2026-11-18 a site publish failed twice because a feed flipped
# between its compose and its tests (two releases ran in parallel). So the flip
# holds a machine-wide lock:
#
#   path    ${FEED_FLIP_LOCK:-$HOME/plexii-work/.feed-flip.lock}
#   form    a DIRECTORY (mkdir is atomic), holding a file `owner`:
#             pid=<pid of the release script>
#             version=<version being flipped>
#             started=<UTC ISO time>
#             host=<short hostname>
#             by=release-mac.sh
#   held    from just before the R2 upload until the upload ends, success or
#           failure (an EXIT trap releases it; a crash leaves it, see stale).
#
# For a READER (a site publish, the Insights crawler, anything that reads
# dl.plexiidesk.com and must not see it move): if the directory exists and its
# owner pid is alive, a flip is in progress; wait and check again. A lock whose
# pid is dead is stale: the release died mid-flip, so tell the person releasing
# rather than trusting the feed.
#
# Same pattern as the Apple signing lock (/Users/mymac/plexii-work/.apple-signing.lock),
# plus the owner file, so a stale lock can be told from a live one.

FEED_FLIP_LOCK="${FEED_FLIP_LOCK:-$HOME/plexii-work/.feed-flip.lock}"
FEED_LOCK_HELD=0

# The pid in the lock's owner file, or nothing.
feed_lock_owner_pid() {
  sed -n 's/^pid=//p' "$FEED_FLIP_LOCK/owner" 2>/dev/null | head -n 1
}

# True when the lock is held by a live process.
feed_lock_held_by_live_owner() {
  [ -d "$FEED_FLIP_LOCK" ] || return 1
  local pid
  pid="$(feed_lock_owner_pid)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# Refuse to go on while another release is flipping the feed.
feed_lock_refuse_if_busy() {
  if feed_lock_held_by_live_owner; then
    echo "The update feed is being flipped by another release (lock $FEED_FLIP_LOCK):" >&2
    cat "$FEED_FLIP_LOCK/owner" >&2 2>/dev/null || true
    echo "Wait for it to finish, then run this again." >&2
    exit 75
  fi
}

# Take the lock for <version>. Exits 75 when a live owner holds it; takes over
# a stale one (its owner is gone) and says so.
feed_lock_take() {
  local version="$1"
  mkdir -p "$(dirname "$FEED_FLIP_LOCK")"
  if ! mkdir "$FEED_FLIP_LOCK" 2>/dev/null; then
    feed_lock_refuse_if_busy
    echo "Taking over a stale feed-flip lock (its owner $(feed_lock_owner_pid) is gone):" >&2
    cat "$FEED_FLIP_LOCK/owner" >&2 2>/dev/null || true
    rm -rf "$FEED_FLIP_LOCK"
    if ! mkdir "$FEED_FLIP_LOCK" 2>/dev/null; then
      echo "Could not take the feed-flip lock $FEED_FLIP_LOCK (another release took it first)." >&2
      exit 75
    fi
  fi
  FEED_LOCK_HELD=1
  printf 'pid=%s\nversion=%s\nstarted=%s\nhost=%s\nby=release-mac.sh\n' \
    "$$" "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname -s 2>/dev/null || echo unknown)" \
    > "$FEED_FLIP_LOCK/owner"
}

# Release the lock if this process holds it. Safe to call more than once.
feed_lock_release() {
  if [ "$FEED_LOCK_HELD" = 1 ]; then
    rm -rf "$FEED_FLIP_LOCK"
    FEED_LOCK_HELD=0
  fi
}
