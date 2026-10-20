// Electron-builder config for the standalone PlexiOffice app — the second product
// of the lean split. It packages the SAME built bundle (out/**) as PlexiDesk; the
// main process branches on app.getName() ('PlexiOffice') to load plexioffice.html
// instead of index.html.
//
// Distinct identity from PlexiDesk:
//  - appId app.plexioffice.desktop → its OWN LaunchServices identity + userData
//    dir, so it installs alongside PlexiDesk rather than upgrading it. Documents
//    are shared via the cloud-documents API, not a shared local DB.
//  - productName PlexiiOffice → the bundle and executable name (PlexiiOffice.app),
//    which is how the main process knows to boot the office renderer: it
//    detects the office build from the executable path (appMode.ts), NOT from
//    app.getName(), which is "plexii" in the packaged bundle until index.ts
//    calls app.setName('PlexiOffice'). That setName string keeps the old
//    spelling on purpose: it names the safeStorage keychain item.
//  - artifactName stays "PlexiOffice-…": office-mac.yml names those files and
//    release:verify:office checks for them.
//
// Was electron-builder.plexioffice.yml. YAML cannot branch on the environment, so
// it hard-coded `identity: null` and every PlexiOffice build shipped ad-hoc signed
// — a first-launch Gatekeeper warning for every user, while PlexiDesk (whose
// config is JS and *can* branch) shipped notarised. This file is the same config
// expressed as JS so PlexiOffice makes the identical decision PlexiDesk does:
// notarise when credentials are present, fall back to ad-hoc when they are not.
// Keep the two signing blocks in step — they are deliberately identical.

// Same credential probe as electron-builder.cjs. APPLE_TEAM_ID plus either an
// App Store Connect API key or an Apple ID + app-specific password.
const hasNotaryCreds =
  !!process.env.APPLE_TEAM_ID &&
  ((!!process.env.APPLE_API_KEY && !!process.env.APPLE_API_KEY_ID && !!process.env.APPLE_API_ISSUER) ||
    (!!process.env.APPLE_ID && !!process.env.APPLE_APP_SPECIFIC_PASSWORD))

const macSigning = hasNotaryCreds
  ? {
      hardenedRuntime: true,
      gatekeeperAssess: false,
      identity: process.env.CSC_NAME || undefined,
      // Shared with PlexiDesk on purpose: both are the same Electron bundle, so
      // they need the same hardened-runtime exceptions. An edit here changes
      // BOTH products — check the other before changing it.
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.plist',
      // `notarize: true`, not `{ teamId }`: electron-builder 26 accepts only a
      // boolean and reads the team from APPLE_TEAM_ID (as electron-builder.cjs).
      notarize: true
    }
  : {
      hardenedRuntime: false,
      gatekeeperAssess: false,
      identity: null
    }

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'app.plexioffice.desktop',
  productName: 'PlexiiOffice',
  copyright: 'Copyright © 2026 PlexiiOffice',
  artifactName: 'PlexiOffice-${version}-${os}-${arch}.${ext}',

  // PlexiOffice can ship from the SAME GitHub repo as PlexiDesk because two things
  // keep the two products from stepping on each other: the artifactName above is
  // PlexiOffice-prefixed (PlexiDesk's is Haptyx-prefixed), and the channel below is
  // 'office', so electron-builder writes office-mac.yml / office.yml instead of the
  // latest-mac.yml / latest.yml PlexiDesk owns. The PlexiOffice app's autoUpdater
  // must request the 'office' channel to read these.
  publish: {
    provider: 'github',
    owner: 'saasmouth',
    repo: 'plexii',
    releaseType: 'release',
    channel: 'office'
  },

  directories: { output: 'release-office', buildResources: 'build' },

  files: [
    'out/**/*',
    'package.json',
    '!**/node_modules/*/{CHANGELOG.md,README.md,readme.md}',
    '!**/*.{ts,tsx,map}',
    // node-llama-cpp ships the llama.cpp SOURCE (34 MB) so it can compile when no
    // prebuilt binary fits. The app never compiles (build: 'never'), so the
    // source and the CLI templates stay out. Windows ships the CPU and Vulkan
    // binaries; the CUDA packages (544 MB) are left out of every installer.
    '!**/node_modules/node-llama-cpp/llama/gitRelease.bundle',
    '!**/node_modules/node-llama-cpp/templates/**',
    '!**/node_modules/@node-llama-cpp/*-cuda/**',
    '!**/node_modules/@node-llama-cpp/*-cuda-ext/**',
    // @reflink is a per-arch native addon that node-llama-cpp's own model
    // downloader (ipull) imports lazily to clone files. The app never uses that
    // downloader (src/main/ai/local/downloadManager.ts does the downloading),
    // and an arm64-only .node breaks the universal merge.
    '!**/node_modules/@reflink/**'
  ],

  asarUnpack: [
    'node_modules/better-sqlite3/**/*',
    'node_modules/node-mac-haptics/**/*',
    // PDF text extraction (pdf-parse) + offline OCR for scanned PDFs (tesseract.js
    // worker/WASM, pdf-to-png-converter, and the @napi-rs/canvas native addon) all
    // break inside an asar, so keep them unpacked here too.
    'node_modules/pdf-parse/**/*',
    'node_modules/tesseract.js/**/*',
    'node_modules/tesseract.js-core/**/*',
    'node_modules/pdf-to-png-converter/**/*',
    'node_modules/@napi-rs/**/*',
    // The on-device model runtime (src/main/ai/local): the addon, its llama.cpp
    // dylibs and the Metal library load from disk by path.
    'node_modules/node-llama-cpp/**/*',
    'node_modules/@node-llama-cpp/**/*'
  ],

  // Bundle the offline OCR training data (no CDN fetch).
  extraResources: [{ from: 'resources/tessdata', to: 'tessdata' }],

  protocols: [{ name: 'PlexiiOffice Protocol', schemes: ['plexioffice'], role: 'Viewer' }],

  mac: {
    category: 'public.app-category.productivity',
    target: [{ target: 'zip', arch: ['arm64'] }],
    ...macSigning,
    extendInfo: {
      NSMicrophoneUsageDescription:
        'PlexiiOffice records voice notes you choose to capture. Audio is processed locally or via your configured transcription provider.',
      NSCameraUsageDescription:
        'PlexiiOffice records video notes when you choose to capture them, stored locally and transcribed only via your configured provider.'
    }
  },

  // Ad-hoc signing is the FALLBACK only. With credentials present electron-builder
  // does the real Developer ID signing itself, and running the ad-hoc hook after
  // it would overwrite that signature with `codesign --sign -`.
  // Always runs: fuses harden the binary and MUST be flipped before signing,
  // because flipping one rewrites bytes and invalidates a prior signature. The
  // hook itself decides whether an ad-hoc signature is needed afterwards.
  afterPack: 'build/harden.cjs',

  win: { target: [{ target: 'nsis', arch: ['x64'] }] },

  // Same reason electron-builder.cjs sets this: the in-builder native rebuild
  // hangs. It stalls in @electron/rebuild's node-gyp worker at
  // "preparing moduleName=better-sqlite3" with the process asleep at 0% CPU and
  // no compiler child, and sits there indefinitely — the main config turned this
  // off long ago but this one was left on, so every office build hung until it
  // was killed by hand. Rebuild natives beforehand instead:
  //   npm run natives:universal   (or: npx @electron/rebuild -f -a arm64 -v <electron>)
  npmRebuild: false,

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true
  }
}
