#!/usr/bin/env bash
# Install the current build into /Applications for local testing.
#
# The bundle is named "PlexiDesk <version>.app" so several builds can sit side
# by side and be told apart in Finder.
#
# Renaming the BUNDLE is safe; renaming the app's IDENTITY is not. The userData
# path comes from app.getName(), which resolves from CFBundleName / the
# package.json name inside the bundle — none of which the directory name
# touches. This script asserts that identity is unchanged before it swaps
# anything in, because getting it wrong silently strands the user's database in
# a different Application Support folder.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

VERSION="$(node -p "require('./package.json').version")"
EXPECT_ID="app.haptyx.desktop"
TARGET="/Applications/PlexiDesk ${VERSION}.app"

BUILD=1
[ "${1:-}" = "--no-build" ] && BUILD=0

if [ "$BUILD" = "1" ]; then
  echo "[install-local] building ${VERSION}…"
  npm run dist >/dev/null
fi

# electron-builder writes to release/mac, release/mac-arm64 or
# release/mac-universal depending on the target.
SRC=""
for d in release/mac-universal release/mac-arm64 release/mac; do
  if [ -d "$d/PlexiDesk.app" ]; then SRC="$d/PlexiDesk.app"; break; fi
done
if [ -z "$SRC" ]; then
  echo "[install-local] no built PlexiDesk.app under release/ — build first." >&2
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
if [ "$GOT_VER" != "$VERSION" ]; then
  echo "[install-local] REFUSING: built bundle is $GOT_VER but package.json says $VERSION." >&2
  echo "               The build is stale — run without --no-build." >&2
  exit 1
fi

echo "[install-local] source     $SRC"
echo "[install-local] bundle id  $GOT_ID (unchanged)"
echo "[install-local] app name   $GOT_NAME (unchanged — userData path is safe)"
echo "[install-local] version    $GOT_VER"

# Retire every previously installed PlexiDesk, whatever it is called.
shopt -s nullglob
for old in /Applications/PlexiDesk.app /Applications/PlexiDesk\ *.app; do
  [ "$old" = "$TARGET" ] && continue
  echo "[install-local] removing   $old"
  rm -rf "$old"
done
shopt -u nullglob

rm -rf "$TARGET"
ditto "$SRC" "$TARGET"
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

echo "[install-local] installed  $TARGET"
