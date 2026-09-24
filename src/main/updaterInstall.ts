// Pure pieces of the macOS one-click updater, split out so they can be unit
// tested without importing electron. autoUpdate.ts imports these.

const REPO = 'saasmouth/focusbuddy'

// The mac slice named in release assets. From 4.3.1 the mac build is a single
// universal artifact, so there is no longer a per-arch asset to choose between
// and process.arch must NOT be used to build the URL: an arm64 machine asking
// for Haptyx-<v>-mac-arm64.zip would 404 on every release from 4.3.1 onward and
// the one-click update would fail with nothing wrong on the release itself.
//
// Releases up to 4.3.0 shipped Haptyx-<v>-mac-arm64.zip and nothing else, which
// is also why 4.3.1's release carries an arm64-named copy of the universal zip:
// clients already running 4.3.0 build their URL with the old code and cannot be
// changed retroactively.
export const MAC_UPDATE_ARCH = 'universal'

// The release asset URL for a given version and mac slice.
export function macAssetUrl(version: string, arch: string): string {
  return `https://github.com/${REPO}/releases/download/v${version}/Haptyx-${version}-mac-${arch}.zip`
}

// The .app bundle path from the running executable path, or null if we are not
// running from a bundle (dev, or an odd layout).
export function appBundlePath(execPath: string): string | null {
  const m = /^(.*\.app)\//.exec(execPath)
  return m?.[1] ?? null
}

// True when the app is running App-Translocated: Gatekeeper runs a quarantined
// app from a randomised, READ-ONLY path under /private/var/folders (or an
// AppTranslocation mount) instead of where it lives. An in-place self-replace is
// impossible from there — the "target" is the read-only translocated copy, so
// the swap always fails and the app relaunches the same old build, which is the
// update loop. We detect it and route the user to a manual install instead.
export function isTranslocated(execPath: string): boolean {
  return (
    /\/AppTranslocation\//.test(execPath) ||
    /^\/private\/var\/folders\//.test(execPath) ||
    /^\/var\/folders\//.test(execPath)
  )
}

// The swap-and-relaunch helper. Waits for this app (PID) to quit, then tries an
// unprivileged in-place swap; if that is denied (e.g. /Applications needs
// admin, or macOS App Management gates modifying another app), it retries the
// copy ONCE behind an administrator-password prompt. The user-level `open`
// always runs unprivileged so the relaunched app is not owned by root. If every
// attempt fails it restores the previous app and opens the releases page so the
// user can install manually, instead of silently relaunching the old build and
// looping. Arguments: $1=pid $2=new app $3=target app $4=releases URL.
export const MAC_INSTALL_SCRIPT = `#!/bin/bash
PID="$1"
NEW_APP="$2"
TARGET_APP="$3"
RELEASES_URL="$4"
BACKUP="\${TARGET_APP}.bak"

for i in $(seq 1 200); do
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 0.3
done

xattr -cr "$NEW_APP" 2>/dev/null || true
rm -rf "$BACKUP" 2>/dev/null || true

OK=0
# 1) Unprivileged swap: move the old aside, copy the new in.
if [ -d "$TARGET_APP" ] && mv "$TARGET_APP" "$BACKUP" 2>/dev/null && ditto "$NEW_APP" "$TARGET_APP" 2>/dev/null; then
  OK=1
elif [ ! -d "$TARGET_APP" ] && ditto "$NEW_APP" "$TARGET_APP" 2>/dev/null; then
  OK=1
else
  # Clean up any partial copy, restore the old app so nothing is lost.
  rm -rf "$TARGET_APP" 2>/dev/null || true
  if [ -d "$BACKUP" ] && [ ! -d "$TARGET_APP" ]; then mv "$BACKUP" "$TARGET_APP" 2>/dev/null || true; fi
  # 2) Privileged retry: prompt for the admin password and replace as root.
  if osascript -e "do shell script \\"rm -rf '\${TARGET_APP}' && ditto '\${NEW_APP}' '\${TARGET_APP}'\\" with administrator privileges" 2>/dev/null; then
    OK=1
    rm -rf "$BACKUP" 2>/dev/null || true
  fi
fi

if [ "$OK" = "1" ]; then
  xattr -cr "$TARGET_APP" 2>/dev/null || true
  rm -rf "$BACKUP" 2>/dev/null || true
  open "$TARGET_APP"
else
  # Could not self-update. Make sure the old app is back in place, reopen it,
  # and send the user to the download page rather than silently looping.
  if [ -d "$BACKUP" ] && [ ! -d "$TARGET_APP" ]; then mv "$BACKUP" "$TARGET_APP" 2>/dev/null || true; fi
  open "$TARGET_APP" 2>/dev/null || true
  if [ -n "$RELEASES_URL" ]; then open "$RELEASES_URL" 2>/dev/null || true; fi
fi
`
