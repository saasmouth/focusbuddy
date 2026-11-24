// electron-builder afterPack hook: harden the packaged binary, then sign it.
//
// ORDER IS THE WHOLE POINT. Flipping a fuse rewrites bytes inside the Electron
// binary, which invalidates any signature already applied to it. So fuses go
// first and signing second — and because electron-builder runs its own signing
// AFTER afterPack, both the Developer-ID path and the ad-hoc fallback end up
// signing an already-hardened binary.
//
// This replaces the old build/adhoc-sign.cjs hook, which is still used for
// nothing else and can be deleted once no config references it.

const { execSync, execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { join } = require('node:path')
const { flipFuses } = require('@electron/fuses')
const { FUSES, describeFuses } = require('./fuses.cjs')
const { removeDevelopmentSig, vmpSignPackage } = require('./vmp.cjs')

// WHICH FUSES, AND WHY THESE: build/fuses.cjs. Since the move to castLabs'
// Electron for Content Security (Widevine in desk web pages) the wire is
// castLabs' fixed set, the only non-default wire their VMP signing service
// will sign. It keeps every fuse this hook used to flip (RunAsNode, NODE_OPTIONS
// and --inspect off: plexii-probe attaches to a packaged build through exactly
// those, which is fine on a developer's machine and not in a customer's build)
// and adds cookie encryption, embedded asar integrity and asar-only loading.

async function harden(appPath, platform, { adHocSign = true } = {}) {
  // eslint-disable-next-line no-console
  console.log(`[harden] flipping fuses on ${appPath}`)
  await flipFuses(appPath, {
    ...FUSES,
    // NOTE: true means the fuse tool DOES run `codesign --sign - --force --deep`
    // itself (see @electron/fuses dist/index.js). An earlier comment here had it
    // backwards. It is wanted for a single-arch mac build — flipping a fuse
    // invalidates whatever signature was on the binary, and Apple Silicon will
    // not execute a wholly unsigned one — but it must be OFF for a universal
    // slice, because a --deep signature makes the two slices' CodeResources
    // differ and @electron/universal then refuses to merge them.
    resetAdHocDarwinSignature: platform === 'darwin' && adHocSign
  })
  // eslint-disable-next-line no-console
  console.log(`[harden] fuses set: ${describeFuses()}`)
}

// EnableEmbeddedAsarIntegrityValidation (build/fuses.cjs) makes Electron refuse
// to load an app.asar whose header hash differs from Info.plist's
// ElectronAsarIntegrity, and the refusal is a silent non-launch. Check it here,
// on the app that is about to be signed, so a mismatch fails the BUILD instead.
// The hash is SHA-256 of the asar's raw header string, as @electron/asar and
// @electron/universal compute it.
function assertAsarIntegrity(appPath) {
  const plist = join(appPath, 'Contents', 'Info.plist')
  let recorded
  try {
    recorded = JSON.parse(
      execFileSync('plutil', ['-extract', 'ElectronAsarIntegrity', 'json', '-o', '-', plist], { encoding: 'utf8' })
    )
  } catch {
    throw new Error(
      `[harden] ${plist} has no ElectronAsarIntegrity, but the asar-integrity fuse is on: the app would refuse to start`
    )
  }
  const asar = require('@electron/asar')
  for (const [rel, entry] of Object.entries(recorded)) {
    const actual = createHash('sha256')
      .update(asar.getRawHeader(join(appPath, 'Contents', rel)).headerString)
      .digest('hex')
    if (String(entry.algorithm).toUpperCase() !== 'SHA256' || entry.hash !== actual) {
      throw new Error(`[harden] asar integrity mismatch for ${rel}: Info.plist ${entry.hash}, actual ${actual}`)
    }
    // eslint-disable-next-line no-console
    console.log(`[harden] asar integrity ok: ${rel} ${actual.slice(0, 12)}…`)
  }
}

// A universal mac build packs each architecture into its own temp directory and
// then merges the two with @electron/universal. That merge requires every
// non-binary file to be byte-identical in both slices, and signing is what
// breaks that: `codesign --deep` writes
// Frameworks/Electron Framework.framework/.../_CodeSignature/CodeResources
// containing hashes of that slice's binaries, so the two copies necessarily
// differ and the merge aborts with "Expected all non-binary files to have
// identical SHAs".
//
// So the work is split across the two stages. Fuses are flipped per slice,
// before the merge, because flipping rewrites bytes inside the Electron binary
// and the merged binary is a lipo of the two slices — each slice must already
// be hardened. Signing then happens once, on the merged app, which is also the
// order electron-builder's own Developer ID path uses.
const universalStageOf = (appOutDir) => {
  if (/mac-universal-(x64|arm64)-temp\/?$/.test(appOutDir)) return 'slice'
  if (/mac-universal\/?$/.test(appOutDir)) return 'merged'
  return null
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName
  const productFilename = context.packager.appInfo.productFilename

  const binary =
    platform === 'darwin'
      ? join(context.appOutDir, `${productFilename}.app`)
      : platform === 'win32'
        ? join(context.appOutDir, `${productFilename}.exe`)
        : join(context.appOutDir, productFilename)

  const stage = platform === 'darwin' ? universalStageOf(context.appOutDir) : null

  if (stage === 'slice') {
    // Harden this slice and stop. Signing it would defeat the merge.
    await harden(binary, platform, { adHocSign: false })
    // castLabs' DEVELOPMENT VMP signature (Electron Framework.sig) has to go:
    // the fuses just changed the bytes it covers, and the two slices' copies
    // differ, which @electron/universal refuses to merge ("Expected all
    // non-binary files to have identical SHAs"; castLabs FAQ, universal
    // builds). The merged app is VMP-signed once, below.
    if (removeDevelopmentSig(binary)) {
      // eslint-disable-next-line no-console
      console.log('[harden] removed the development VMP signature from this slice')
    }
    // eslint-disable-next-line no-console
    console.log('[harden] universal slice — leaving it unsigned so the merge can proceed')
    return
  }

  if (stage === 'merged') {
    // Fuses were already flipped in each slice and survive the lipo, so
    // re-flipping here would rewrite the merged binary for no reason.
    // eslint-disable-next-line no-console
    console.log('[harden] merged universal app — fuses already set in each slice')
  } else {
    await harden(binary, platform)
    if (platform === 'darwin' && removeDevelopmentSig(binary)) {
      // eslint-disable-next-line no-console
      console.log('[harden] removed the development VMP signature (the fuses invalidated it)')
    }
  }

  // Windows is VMP-signed after Authenticode signing (build/vmp-after-sign.cjs).
  if (platform !== 'darwin') return

  assertAsarIntegrity(binary)

  // VMP (Widevine's Verified Media Path), on the final binary and BEFORE any
  // Apple signature (build/vmp.cjs): the signature file sits inside the
  // framework, so it has to exist before the code signature seals the bundle.
  // For a universal build this is the merged, fat binary, which EVS signs as
  // one. Without an EVS account it skips with one clear log line.
  vmpSignPackage({
    platform: 'darwin',
    pkgDir: context.appOutDir,
    nameHint: productFilename,
    resourcesDir: join(binary, 'Contents', 'Resources')
  })

  // Ad-hoc signature only in the no-credentials fallback. With real Developer ID
  // credentials electron-builder signs properly after this hook, and ad-hoc
  // signing here would stomp that signature and break notarisation — the same
  // reasoning the old hook carried, preserved.
  // Decided by scripts/notary-auth.cjs, the same as electron-builder.cjs: by the
  // time this hook runs the config has already applied it (a keychain profile,
  // no password), so an inline APPLE_ID check here would read "no credentials"
  // and ad-hoc sign a build that is about to be notarised.
  const hasNotaryCreds = require('../scripts/notary-auth.cjs').resolveNotaryAuth(process.env).mode !== 'none'
  if (hasNotaryCreds) {
    // eslint-disable-next-line no-console
    console.log('[harden] Developer ID credentials present — leaving signing to electron-builder')
    return
  }

  // macOS on Apple Silicon refuses to execute an entirely unsigned binary
  // ("damaged and can\'t be opened"), and flipping a fuse invalidates whatever
  // signature was there. Re-sign ad-hoc so the build still launches.
  // eslint-disable-next-line no-console
  console.log(`[harden] ad-hoc signing ${binary}`)
  try {
    execSync(`codesign --force --deep --sign - "${binary}"`, { stdio: 'inherit' })
    execSync(`codesign --verify --deep "${binary}"`, { stdio: 'inherit' })
    // eslint-disable-next-line no-console
    console.log('[harden] ad-hoc signature applied')
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[harden] signing failed:', err.message)
    throw err
  }
}
