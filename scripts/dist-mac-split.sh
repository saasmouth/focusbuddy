#!/usr/bin/env bash
# Build the two mac artifacts for a release that bundles the local AI model.
#
# One version, two different bundles, on purpose:
#
#   .dmg   fresh install   WITH Contents/Resources/models/
#   .zip   update payload  WITHOUT it
#
# Why two builds rather than one build and a strip: electron-builder packages
# the app once per platform and writes every target from that one directory, so
# a single invocation cannot vary bundle contents per target. And removing the
# model from a signed bundle afterwards breaks the code signature and voids
# notarisation, so the omission has to happen BEFORE signing. Each pass is
# therefore signed and notarised in its own right.
#
# Why the zip must not carry the model: the mac updater is custom (macOS does
# not use electron-updater's feed) and downloadFile() in src/main/autoUpdate.ts
# is a plain https.get of the whole asset — no Range header, no blockmap, no
# delta. A model in the update zip is re-downloaded in full by every user at
# every release: ~388MB becomes ~2.9GB, paid again each time, including by
# users who never touch AI.
#
# PASS ORDER IS LOAD-BEARING. Both passes write latest-mac.yml, and whichever
# runs last wins. The update feed must describe the ZIP, so the zip pass runs
# SECOND. Running the dmg last leaves a latest-mac.yml pointing at a 2.9GB dmg
# that the updater cannot install, and nothing downstream would catch it.
#
# Usage:  scripts/dist-mac-split.sh            signed + notarised (needs creds)
#         SKIP_SIGNING_CHECK=1 scripts/dist-mac-split.sh    local unsigned test
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('${ROOT}/package.json').version")"
DIR="${RELEASE_DIR:-release}"
MAC_ARCH="${MAC_ARCH:-universal}"

if [ ! -d "resources/models" ]; then
  echo "resources/models is absent, so there is no model to split." >&2
  echo "Use the normal 'npm run dist:mac:universal' — this script is only for" >&2
  echo "releases that bundle the local AI model." >&2
  exit 1
fi

# Same refusal as dist:mac:signed: a pass that silently skips signing produces
# artifacts of the right name and size that Gatekeeper rejects on the user's
# machine, which is the worst place to find out.
node scripts/require-signing-env.mjs

# Prerequisites, ONCE for both passes.
#
# Two things the first version of this script got wrong, both caught by
# running it rather than reading it:
#
#  - it skipped natives:x64 and natives:universal. electron-builder.cjs says so
#    in its own comment next to the mac targets: the universal merge needs the
#    x64 prebuilds fetched and merged first, which is why dist:mac:universal
#    runs both before building.
#  - it ran `electron-builder --mac dmg`, and naming a target on the command
#    line DISCARDS the arch list in the config. The config asks for
#    arch:['universal']; the CLI silently substituted the host arch, so pass 1
#    produced PlexiDesk-<v>-mac-arm64.dmg and the script then failed looking
#    for the universal name. Both passes now pass --universal explicitly.
#
# `npm run build` also runs once, deliberately. PLEXII_OMIT_MODEL changes only
# extraResources, not the compiled JS, so building once and packaging twice
# makes app.asar identical in both artifacts BY CONSTRUCTION rather than by
# luck — which is the property verify-model-split.mjs then asserts.
npm run natives:x64
npm run natives:universal
npm run build

echo "=============================================================="
echo " PASS 1 of 2: fresh-install dmg, WITH the model"
echo "=============================================================="
npx electron-builder --mac dmg --universal --publish never

DMG="${DIR}/PlexiDesk-${VERSION}-mac-${MAC_ARCH}.dmg"
[ -f "$DMG" ] || { echo "pass 1 produced no dmg at ${DMG}" >&2; exit 1; }
# Keep it out of the way: pass 2 repackages the app directory in place, and a
# half-overwritten dmg is worse than an absent one.
mv "$DMG" "${DMG}.pass1"

echo
echo "=============================================================="
echo " PASS 2 of 2: update zip, WITHOUT the model"
echo "=============================================================="
# PLEXII_OMIT_MODEL is read by extraResourcesFor() in electron-builder.cjs.
# --universal for the same reason as pass 1: naming a target on the command
# line drops the config's arch list, and an arm64-only update zip would be
# refused by every Intel Mac before any of our code runs.
PLEXII_OMIT_MODEL=1 npx electron-builder --mac zip --universal --publish never

mv "${DMG}.pass1" "$DMG"

echo
echo "=============================================================="
echo " Gate"
echo "=============================================================="
# Proves the two passes produced the same application, that only the dmg has
# the model, and that the zip has none. Refuses the upload if not.
node scripts/verify-model-split.mjs "$VERSION" --release-dir="$DIR"

echo
echo "Both artifacts built and verified:"
ls -lh "${DIR}/PlexiDesk-${VERSION}-mac-${MAC_ARCH}".{dmg,zip} | awk '{print "  " $5 "\t" $9}'
echo
echo "latest-mac.yml now describes the zip (written by pass 2):"
grep -E '^(version|path):' "${DIR}/latest-mac.yml" | sed 's/^/  /'
