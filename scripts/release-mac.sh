#!/usr/bin/env bash
# Upload the COMPLETE set of mac auto-update assets to a GitHub release, then
# verify the whole release (mac + win) is updatable. Use this instead of a bare
# `gh release upload <zip>` — uploading only the zip is exactly the mistake that
# leaves clients unable to update because latest-mac.yml is absent.
#
# electron-builder writes three mac files into release/ for an arm64 zip target:
#   Haptyx-<v>-mac-arm64.zip            the app payload
#   Haptyx-<v>-mac-arm64.zip.blockmap  differential-update map
#   latest-mac.yml                     the update manifest the updater READS
# All three must be on the release. latest-mac.yml is the one whose absence
# silently breaks updates, so this script refuses to proceed without it.
#
# Usage:  scripts/release-mac.sh <version>     e.g. 2.5.25
# Env:    REPO (default saasmouth/focusbuddy), RELEASE_DIR (default release)
set -euo pipefail

HERE0="$(cd "$(dirname "$0")" && pwd)"
# Version defaults to package.json so it can't drift from what was built.
VERSION="${1:-$(node -p "require('${HERE0}/../package.json').version")}"
REPO="${REPO:-saasmouth/focusbuddy}"
DIR="${RELEASE_DIR:-release}"
TAG="v${VERSION}"

# Which mac slice this release ships. 4.3.1 onward is `universal`; older
# releases were `arm64`.
MAC_ARCH="${MAC_ARCH:-universal}"

ZIP="${DIR}/Haptyx-${VERSION}-mac-${MAC_ARCH}.zip"
BLOCKMAP="${ZIP}.blockmap"
DMG="${DIR}/Haptyx-${VERSION}-mac-${MAC_ARCH}.dmg"
YML="${DIR}/latest-mac.yml"
APP="${DIR}/mac-${MAC_ARCH}/PlexiDesk.app"

# Refuse to upload an incomplete set — missing latest-mac.yml is the root cause
# of the update 404s, so treat its absence as a hard error, not a warning. The
# dmg is required too: it is what the website's download button serves, and it
# used to be uploaded by hand outside this script, which is how a release could
# look complete while new users had nothing to download.
missing=0
for f in "$ZIP" "$BLOCKMAP" "$DMG" "$YML"; do
  if [ ! -f "$f" ]; then echo "MISSING build artifact: $f" >&2; missing=1; fi
done
if [ "$missing" -ne 0 ]; then
  echo "Build the mac artifacts first (npm run dist:mac:universal) so all of them exist in ${DIR}/." >&2
  exit 1
fi

# Assert the thing we are about to publish really does carry both architectures.
# An arm64-only build is refused by Intel Macs with "this application is not
# supported on the Mac" before any of our code runs, so the app cannot warn the
# user — 4.3.0 shipped exactly that. Checking the built .app here is cheap;
# discovering it from a user's bug report is not.
if [ "$MAC_ARCH" = "universal" ]; then
  if [ ! -d "$APP" ]; then
    echo "MISSING built app: $APP (needed to verify the binary is universal)" >&2
    exit 1
  fi
  BIN="${APP}/Contents/MacOS/PlexiDesk"
  ARCHS="$(lipo -archs "$BIN" 2>/dev/null || true)"
  case " $ARCHS " in
    *" x86_64 "*) ;;
    *) echo "NOT UNIVERSAL: ${BIN} is \"${ARCHS}\" — an Intel Mac cannot run this. Run: npm run natives:universal && npm run dist:mac:universal" >&2; exit 1 ;;
  esac
  case " $ARCHS " in
    *" arm64 "*) ;;
    *) echo "NOT UNIVERSAL: ${BIN} is \"${ARCHS}\" — Apple Silicon would run under Rosetta. Aborting." >&2; exit 1 ;;
  esac
  echo "Main binary is universal (${ARCHS})."
fi

# Sanity: the manifest must describe THIS version, otherwise we'd publish a
# manifest that points clients at a different/older zip.
if ! grep -q "version: ${VERSION}" "$YML"; then
  echo "latest-mac.yml does not declare version ${VERSION} — stale build artifact. Rebuild before uploading." >&2
  exit 1
fi

echo "Uploading mac update assets to ${TAG}…"
gh release upload "$TAG" "$ZIP" "$BLOCKMAP" "$DMG" "$YML" --repo "$REPO" --clobber

# Backwards compatibility for clients that predate the universal build.
#
# On macOS the one-click updater builds its own download URL rather than using
# latest-mac.yml, and every client up to 4.3.0 builds it from process.arch —
# so an installed 4.3.0 on Apple Silicon asks for Haptyx-<v>-mac-arm64.zip.
# Current code asks for -mac-universal.zip (see MAC_UPDATE_ARCH), but the old
# clients are already out there and cannot be changed retroactively. Without an
# asset under the name they expect, their update fails on a 404 and they have to
# find the download page themselves.
#
# The universal zip runs perfectly well on arm64, so publish a copy of it under
# the old name. Drop this once no supported client builds per-arch URLs.
if [ "$MAC_ARCH" = "universal" ]; then
  COMPAT_DIR="$(mktemp -d)"
  trap 'rm -rf "$COMPAT_DIR"' EXIT
  COMPAT_ZIP="${COMPAT_DIR}/Haptyx-${VERSION}-mac-arm64.zip"
  cp "$ZIP" "$COMPAT_ZIP"
  cp "$BLOCKMAP" "${COMPAT_ZIP}.blockmap"
  echo "Uploading arm64-named alias for pre-4.3.1 clients…"
  gh release upload "$TAG" "$COMPAT_ZIP" "${COMPAT_ZIP}.blockmap" --repo "$REPO" --clobber
fi

echo "Running the release completeness gate…"
exec "${HERE0}/verify-release-assets.sh" "$VERSION"
