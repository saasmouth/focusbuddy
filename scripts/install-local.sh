#!/usr/bin/env bash
# Install the current build into /Applications for local testing.
#
# The bundle is named "PlexiiDesk <version>.app" so several builds can sit side
# by side and be told apart in Finder. (4.3.32 and earlier were "PlexiDesk
# <version>.app"; both spellings are retired below.)
#
# Renaming the BUNDLE is safe; renaming the app's IDENTITY is not. The identity
# is three things, none of which the directory name touches, and this script
# asserts all three before it swaps anything in:
#   - CFBundleIdentifier (app.haptyx.desktop): TCC grants, LaunchServices.
#   - package.json `name` inside app.asar ("plexii"): app.getName(), which
#     names the safeStorage keychain item ("plexii Safe Storage").
#   - the userData directory, pinned in src/main/userDataMigration.ts to
#     Application Support/plexii. It no longer follows any name, but it did
#     once, and that move stranded a five-month workspace.
# CFBundleName is NOT identity: it is productName ("PlexiiDesk"), the name a
# person sees.
#
# SIGNING. This builds through scripts/release-env.mjs, the same credential
# loader the release uses, and then REFUSES to install a bundle that is not
# Developer ID signed and notarised.
#
# It did neither until 2026-10-10, and both halves of that mattered:
#   - it ran `npm run dist` bare, so APPLE_TEAM_ID / APPLE_ID were not in the
#     environment. electron-builder.cjs gates on those: without them it sets
#     `identity: null` and the afterPack hook ad-hoc signs instead. The 4.3.25
#     install came out ad-hoc, unnotarised, `spctl: rejected`.
#   - it sent the build to /dev/null, so release-env's own
#     "WARNING: no Apple credentials found" never reached anyone.
# An ad-hoc build still launches here (the quarantine strip below is why), so
# nothing looks wrong locally — it is the next machine that refuses it. Testing
# a bundle that differs from the released one in its hardened runtime and
# entitlements is testing the wrong app.
#
# --allow-adhoc builds and installs anyway, for an unprovisioned machine. It
# says so loudly; it is not the default.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

VERSION="$(node -p "require('./package.json').version")"
EXPECT_ID="app.haptyx.desktop"
EXPECT_PKG_NAME="plexii"
TARGET="/Applications/PlexiiDesk ${VERSION}.app"

BUILD=1
ALLOW_ADHOC=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --allow-adhoc) ALLOW_ADHOC=1 ;;
    *) echo "[install-local] unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ "$BUILD" = "1" ]; then
  LOG="release/install-local-build.log"
  mkdir -p release
  echo "[install-local] building ${VERSION} (signed + notarised) → ${LOG}"
  # Never /dev/null: a build that skips notarisation still produces an app, and
  # the only notice you get is in the output.
  if ! node scripts/release-env.mjs npm run dist > "$LOG" 2>&1; then
    echo "[install-local] BUILD FAILED — last 40 lines of ${LOG}:" >&2
    tail -40 "$LOG" >&2
    exit 1
  fi
  grep -E "no Apple credentials|notarization|signing " "$LOG" | tail -5 || true
fi

# electron-builder writes to release/mac, release/mac-arm64 or
# release/mac-universal depending on the target.
SRC=""
# The bundle is named after productName: PlexiiDesk.app from 4.3.33.
for d in release/mac-universal release/mac-arm64 release/mac; do
  if [ -d "$d/PlexiiDesk.app" ]; then SRC="$d/PlexiiDesk.app"; break; fi
done
if [ -z "$SRC" ]; then
  echo "[install-local] no built PlexiiDesk.app under release/ — build first." >&2
  exit 1
fi

PLIST="$SRC/Contents/Info.plist"
read_plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$PLIST" 2>/dev/null || echo ""; }
GOT_ID="$(read_plist CFBundleIdentifier)"
GOT_NAME="$(read_plist CFBundleName)"
GOT_VER="$(read_plist CFBundleShortVersionString)"

if [ "$GOT_ID" != "$EXPECT_ID" ]; then
  echo "[install-local] REFUSING: bundle id is '$GOT_ID', expected '$EXPECT_ID'." >&2
  echo "               Changing it moves the user's data directory." >&2
  exit 1
fi
# app.getName() comes from package.json `name` inside the asar, and it names
# the keychain item every stored API key is encrypted under. productName must
# never leak into it.
GOT_PKG_NAME="$(node -e '
  const asar = require("@electron/asar")
  process.stdout.write(String(JSON.parse(asar.extractFile(process.argv[1], "package.json")).name))
' "$SRC/Contents/Resources/app.asar" 2>/dev/null || echo "")"
if [ "$GOT_PKG_NAME" != "$EXPECT_PKG_NAME" ]; then
  echo "[install-local] REFUSING: packaged package.json name is '$GOT_PKG_NAME', expected '$EXPECT_PKG_NAME'." >&2
  echo "               It is app.getName(), which names the keychain item stored keys are encrypted with." >&2
  exit 1
fi
if [ "$GOT_VER" != "$VERSION" ]; then
  echo "[install-local] REFUSING: built bundle is $GOT_VER but package.json says $VERSION." >&2
  echo "               The build is stale — run without --no-build." >&2
  exit 1
fi

# ── Is the PACKAGE actually built from the current code? ────────────────────
#
# The version check above is necessary and nowhere near sufficient: the version
# only moves on a release, so between two builds of the same version it says
# nothing at all. On 2026-10-10 that let `--no-build` install a package 21
# minutes older than the `out/` the tests had just exercised — same version
# string, different code, guard silent. The operator got a build nobody had run.
#
# So compare content freshness: if anything in out/ is newer than the packaged
# asar, the package predates the code and installing it would ship something
# untested.
ASAR="$SRC/Contents/Resources/app.asar"
# Compare only what is actually PACKAGED. out/web is the browser build and
# never enters the desktop asar, and electron-vite rewrites the HTML entry
# files late enough to land a second or two after packaging — so comparing all
# of out/ reported a stale package on a perfectly current build, which would
# have blocked every legitimate install from here on. A guard that cries wolf
# gets deleted, and then the real case walks through.
#
# The entry HTML files are excluded for the same reason: they are rewritten by
# the build, carry no logic, and cannot be the thing that makes a package stale.
if [ -d out/main ] && [ -f "$ASAR" ]; then
  NEWER="$(find out/main out/preload out/renderer -type f             ! -name '*.html' -newer "$ASAR" -print 2>/dev/null | head -1 || true)"
  if [ -n "$NEWER" ]; then
    echo "[install-local] REFUSING: the packaged app is older than the built code." >&2
    echo "               $NEWER is newer than the package." >&2
    echo "               The version string matches, so only this check catches it." >&2
    echo "               Run without --no-build to package the current code." >&2
    exit 1
  fi
fi

# ── Signing gate ────────────────────────────────────────────────────────────
# Three separate things, each of which can be absent on its own:
#   the signature's authority chain, the stapled notarisation ticket, and what
#   Gatekeeper makes of the pair. An ad-hoc signature verifies happily, so
#   `codesign --verify` alone proves nothing about distributability.
AUTHORITY="$(codesign -dv --verbose=2 "$SRC" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
STAPLED=0
xcrun stapler validate "$SRC" >/dev/null 2>&1 && STAPLED=1
GATEKEEPER="rejected"
spctl -a -t exec "$SRC" >/dev/null 2>&1 && GATEKEEPER="accepted"

echo "[install-local] authority  ${AUTHORITY:-<none — ad-hoc>}"
echo "[install-local] notarised  $([ "$STAPLED" = 1 ] && echo "yes (ticket stapled)" || echo "NO")"
echo "[install-local] gatekeeper ${GATEKEEPER}"

SIGNED_OK=0
case "$AUTHORITY" in
  "Developer ID Application:"*) [ "$STAPLED" = 1 ] && [ "$GATEKEEPER" = "accepted" ] && SIGNED_OK=1 ;;
esac

if [ "$SIGNED_OK" != "1" ]; then
  if [ "$ALLOW_ADHOC" = "1" ]; then
    echo "[install-local] WARNING: installing a bundle that is NOT distributable." >&2
    echo "               It launches here only because the quarantine flag is stripped" >&2
    echo "               below. Another Mac will refuse it, and its hardened runtime and" >&2
    echo "               entitlements differ from the released app. --allow-adhoc was given." >&2
  else
    echo "[install-local] REFUSING: this bundle is not Developer ID signed and notarised." >&2
    echo "               Apple credentials come from .env via scripts/release-env.mjs:" >&2
    echo "               APPLE_TEAM_ID plus either APPLE_API_KEY/_ID/_ISSUER or" >&2
    echo "               APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD. The Developer ID" >&2
    echo "               Application identity must be in the login keychain, and the" >&2
    echo "               keychain unlocked." >&2
    echo "               Pass --allow-adhoc to install it anyway on an unprovisioned machine." >&2
    exit 1
  fi
fi

echo "[install-local] source     $SRC"
echo "[install-local] bundle id  $GOT_ID (unchanged)"
echo "[install-local] app name   $GOT_NAME (displayed name only — app.getName() is '$GOT_PKG_NAME', userData is pinned to Application Support/plexii)"
echo "[install-local] version    $GOT_VER"

# Retire previously installed bundles, in either spelling. Bundles that carry a
# DIFFERENT version in their name are kept: they are how you go back to the
# previous build at the moment the new one misbehaves, and other sessions park
# their own test builds there. What goes is the unversioned name (it hides
# which build is which) and other copies of THIS version ("PlexiiDesk 4.3.34
# (sidebar).app"). PRUNE_OLD=1 restores the old behaviour of removing every
# PlexiiDesk bundle. This only removes bundles from /Applications; a copy that
# is still RUNNING keeps running from memory until it quits.
shopt -s nullglob
for old in /Applications/PlexiiDesk.app /Applications/PlexiiDesk\ *.app /Applications/PlexiDesk.app /Applications/PlexiDesk\ *.app; do
  [ "$old" = "$TARGET" ] && continue
  [ -d "$old" ] || continue
  case "$old" in
    /Applications/PlexiiDesk.app|/Applications/PlexiDesk.app) ;;
    *" ${VERSION}.app"|*" ${VERSION} ("*) ;;
    *) if [ "${PRUNE_OLD:-0}" != "1" ]; then
         echo "[install-local] keeping    $old (another version)"
         continue
       fi ;;
  esac
  echo "[install-local] removing   $old"
  rm -rf "$old"
done
shopt -u nullglob

rm -rf "$TARGET"
ditto "$SRC" "$TARGET"
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

echo "[install-local] installed  $TARGET"

# Warm the app up before handing it over.
#
# A freshly installed build gets suspended on its first launch on this machine
# (state T, no renderer, dock bouncing until LaunchServices reports "not
# responding"). It is not a crash and SIGCONT clears it — see
# scripts/launch-local.sh — but discovering that by double-clicking and waiting
# is a bad first experience of a new build. Do it here, once, so the first real
# launch is an ordinary one. Non-fatal: a failed warm-up must not fail an
# install that otherwise succeeded.
if [ "${SKIP_WARMUP:-0}" != "1" ]; then
  echo "[install-local] warming up (first launch is the slow one)…"
  rc=0
  bash "$(dirname "$0")/launch-local.sh" "$TARGET" --restart || rc=$?
  if [ "$rc" = "0" ]; then
    echo "[install-local] warm-up ok — it will open normally from now on"
  elif [ "$rc" = "3" ]; then
    echo "[install-local] installed, but an already-running instance kept the window (see above)." >&2
  else
    echo "[install-local] warm-up did not settle; open it with: npm run app" >&2
  fi
fi
