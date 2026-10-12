# PlexiDesk desktop — release workflow

The desktop app auto-updates from **GitHub Releases**. electron-updater on each
client fetches the update manifest from the newest release and, if it names a
higher version, downloads the payload and offers an **Install** button in the
footer. Mac reads `latest-mac.yml`; Windows reads `latest.yml`.

## THE RULE (non-negotiable)

A release is **not done** until `npm run release:verify` exits 0.

Two things it enforces, both of which used to be forgotten:

1. The complete auto-update asset set is published (see below). A missing
   `latest-mac.yml` silently breaks updates.
2. The in-app **What's New** is updated for this release. The newest versioned
   entry in `src/renderer/src/lib/changelog.ts` must equal the released version,
   with a `summary` and `links` so the first-run "What's new in vX.Y.Z" modal has
   something to show. So every release, before building, add or refresh the top
   changelog entry and set its `version` to the new package.json version.

The recurring failure this prevents: uploading only the installer (the `.zip` /
`.exe`) and forgetting the per-platform update manifest. When `latest-mac.yml`
is missing, every Mac client's update check 404s and silently fails — the app
looks fine but can never update itself. The manifest, not the installer, is what
the updater reads, so the installer alone is a broken release.

Therefore:

- Never hand-upload release assets with a bare `gh release upload <zip>`. Use
  `npm run release:mac`, which uploads the **complete** mac set and then runs the
  gate.
- Every release must ship, per platform, all of: the installer, its `.blockmap`,
  and the manifest `.yml`. The gate enforces the full set for mac **and** win.
- The final step of any release, by a human or an agent, is `npm run
  release:verify`. If it is red, the release is not finished — fix the assets and
  re-run until it is green. "It built" and "the zip uploaded" are not "it can
  update."

## Cut a release

```bash
cd projects/focusbuddy

# 1. Bump version in package.json, commit, tag, push the branch.
# 2. Build the signed and notarised UNIVERSAL mac artifacts (zip + dmg + blockmaps +
#    latest-mac.yml in release/). This also rebuilds every compiled native
#    addon for both architectures and lipos them into fat binaries, which is
#    what makes a universal app possible at all — see the long note on
#    `mergeASARs` in electron-builder.cjs.
VITE_USE_REMOTE_SIGNAL=true \
VITE_SIGNAL_HTTP_URL=https://api.plexiidesk.com \
VITE_SIGNAL_WS_URL=wss://api.plexiidesk.com/ws \
VITE_VIEWER_URL=https://view.plexiidesk.com \
  node scripts/release-env.mjs npm run dist:mac:universal:signed

# 3. Build Windows via CI and wait for it, then create the release with the mac zip:
gh workflow run build-windows.yml --ref main
gh release create vX.Y.Z release/PlexiDesk-X.Y.Z-mac-universal.zip --title "PlexiDesk X.Y.Z" --notes "..."

# 4. Attach the COMPLETE mac update set + run the gate (this is the step that
#    used to be skipped). Defaults the version from package.json:
npm run release:mac

# 5. Attach the Windows installer + its manifest from the CI artifact:
gh run download <run-id> -n plexidesk-windows-installer -D /tmp/win
gh release upload vX.Y.Z \
  /tmp/win/PlexiDesk-X.Y.Z-win-x64.exe \
  /tmp/win/PlexiDesk-X.Y.Z-win-x64.exe.blockmap \
  /tmp/win/latest.yml --clobber

# 6. FINAL GATE — the release is not done until this is green:
npm run release:verify

# 7. PlexiOffice ships from this same repo on a separate update channel
#    ('office'), so it MUST get its assets on the SAME (now latest) release tag,
#    or its updater 404s — electron-updater reads the channel manifest from the
#    newest release, and a PlexiDesk-only release leaves office-mac.yml behind on
#    the previous tag. Build the office app (mac arm64) and attach its set:
npm run dist:office:zip   # produces release-office/PlexiOffice-X.Y.Z-mac-arm64.zip + .blockmap + office-mac.yml
gh release upload vX.Y.Z \
  release-office/PlexiOffice-X.Y.Z-mac-arm64.zip \
  release-office/PlexiOffice-X.Y.Z-mac-arm64.zip.blockmap \
  release-office/office-mac.yml --clobber

# 8. OFFICE GATE — the office channel is not done until this is green:
npm run release:verify:office
```

## The office channel (do not forget it)

PlexiOffice is the standalone second app. It is built from this same codebase and
published to the **same GitHub releases**, but on the `office` channel: its bundled
`app-update.yml` carries `channel: office`, so electron-updater reads
`office-mac.yml` (not `latest-mac.yml`). The recurring trap: cutting a PlexiDesk
release creates a new *latest* release, and electron-updater always reads the
channel manifest from the latest release. If that release has no `office-mac.yml`,
every PlexiOffice client's update check 404s — the exact same silent-break the main
gate prevents for mac/win. So every release that bumps the version MUST also attach
the office set to the same tag and pass `npm run release:verify:office`. Office is
mac arm64 only today (no Windows office build in CI yet).

`npm run release:mac` uploads the current `PlexiDesk-X.Y.Z-mac-universal`
artifacts and `latest-mac.yml` (with `--clobber`, so re-running is safe). It also
publishes arm64-named and legacy `Haptyx-` aliases for already-installed clients;
those aliases are update compatibility assets, not the customer-facing release
name. The script refuses to upload unless the built binary is universal, mirrors
the feed to R2, and runs the gate.
`npm run release:verify` independently re-checks the whole release for both
platforms: every asset reachable (HTTP 200) and the sha512 inside each manifest
matching the binary GitHub actually serves.

## What gets published (the complete set)

The mac build is UNIVERSAL (x86_64 + arm64) from 4.3.1 onward. Up to 4.3.0 it was
arm64-only, which an Intel Mac refuses to open at all — macOS rejects the
architecture before any app code runs, so the user sees only "this application is
not supported on the Mac" and the app cannot explain itself. Everything below
must reach the release:

- `PlexiDesk-X.Y.Z-mac-universal.zip` — the app bundle the updater installs
- `PlexiDesk-X.Y.Z-mac-universal.zip.blockmap` — differential-update map
- `PlexiDesk-X.Y.Z-mac-universal.dmg` — **what the website's download button serves**;
  it used to be uploaded by hand and checked by nothing
- `PlexiDesk-X.Y.Z-mac-arm64.zip` (+ `.blockmap`) — a copy of the universal zip
  under the architecture name pre-4.3.1 clients ask for
- matching legacy `Haptyx-` zip aliases — retained only for installed clients
  that predate the product rename
- `latest-mac.yml` — the manifest electron-updater reads; **its absence is the
  bug that breaks updates**

Windows (built in CI) contributes:

- `PlexiDesk-X.Y.Z-win-x64.exe` — the installer
- `PlexiDesk-X.Y.Z-win-x64.exe.blockmap` — differential-update map
- `latest.yml` — the Windows update manifest

## How the in-app side works

- On boot, `installAutoUpdater()` calls `checkForUpdates()`, then repeats on an
  interval. The footer version pill is also a manual "check now" button.
- State transitions broadcast via `update:state` IPC; the renderer's
  `UpdaterBanner` shows checking / available / downloading / **Install** / error.
- `quitAndInstall(true, true)` relaunches into the new version.

## Signing

Public macOS releases must be signed with the PlexiDesk Developer ID certificate
and notarised by Apple. Ad-hoc signing is for local development only and must
never be uploaded as a customer download. `scripts/require-signing-env.mjs`
blocks the release build when the required credentials are absent; the asset
gate separately verifies the updater checksum and manifest.

## Scripts

- `scripts/release-mac.sh [version]` — upload the full mac set, then gate. Refuses
  to proceed if `latest-mac.yml` is missing or names a different version.
- `scripts/verify-release-assets.sh [version]` — the standalone completeness gate
  used by `npm run release:verify`. Runs on macOS and Linux/CI (uses `openssl`).
  Version defaults to `package.json`.

## Notarised macOS builds (Developer ID)

An ad-hoc-signed app is rejected by Gatekeeper on modern macOS. Release builds
therefore sign with an Apple **Developer ID Application** certificate and
**notarise** with Apple. The build is wired for this in `electron-builder.cjs`,
and the release command refuses to continue without credentials.

Credentials required (from the Apple Developer account):
- A "Developer ID Application" certificate installed in the login keychain (or
  passed as a base64 `.p12` via `CSC_LINK` + `CSC_KEY_PASSWORD`).
- `APPLE_ID` — the Apple account email.
- `APPLE_APP_SPECIFIC_PASSWORD` — an app-specific password (appleid.apple.com →
  Sign-In and Security → App-Specific Passwords), NOT the account password.
- `APPLE_TEAM_ID` — the 10-char team id.

Cut a notarised mac build (produces a notarised `.zip` for auto-update AND a
`.dmg` for first-download install):

Run it through `release-env.mjs`, which loads the Apple credentials from `.env`.
npm does NOT load `.env`, and electron-builder's two modes mean a build without
those variables sets `identity: null` and produces an ad-hoc signed app —
exit 0, right filenames, right sizes, rejected by Gatekeeper on the user's
machine. `scripts/require-signing-env.mjs` now refuses that build rather than
letting it happen quietly, but the wrapper is still how you get the creds in.

```bash
VITE_USE_REMOTE_SIGNAL=true \
VITE_SIGNAL_HTTP_URL=https://api.plexiidesk.com \
VITE_SIGNAL_WS_URL=wss://api.plexiidesk.com/ws \
VITE_VIEWER_URL=https://view.plexiidesk.com \
  node scripts/release-env.mjs npm run dist:mac:universal:signed
# zip + blockmap + latest-mac.yml + dmg, all notarised
```

Then CHECK it, because the build reports success either way:

```bash
spctl -a -vvv -t install release/mac-universal/PlexiDesk.app   # must say: accepted
xcrun stapler validate release/PlexiDesk-*-mac-universal.dmg   # must say: validated
codesign -dv --verbose=2 release/mac-universal/PlexiDesk.app 2>&1 | grep TeamIdentifier
# must print TeamIdentifier=AHU8G4V9HD, not "not set"
```

Then attach the full mac set as usual (`npm run release:mac`) AND upload the dmg
to the same release so new users can download-and-double-click:

```bash
gh release upload vX.Y.Z release/PlexiDesk-X.Y.Z-mac-universal.dmg --clobber
```

Verify it actually notarised before shipping (this is the equivalent of the
release gate for signing — do not skip):

```bash
spctl -a -vvv "release/mac-universal/PlexiDesk.app"   # must say: accepted, source=Notarized Developer ID
codesign -dvv "release/mac-universal/PlexiDesk.app" 2>&1 | grep -i Signature   # must NOT say adhoc
```

Distribute the **.dmg** as the download link on the landing page. The .zip stays
the auto-update artifact (electron-updater reads it via latest-mac.yml); the .dmg
is the human install. Shipping a raw `.app`-in-`.zip` as the download is what
corrupts the signature on browser download + Archive Utility unzip — the dmg
avoids that.
