// The Electron fuse wire every PlexiiDesk binary ships with (applied by
// build/harden.cjs, before any signing).
//
// IT IS CASTLABS' SET, EXACTLY, AND THAT IS NOT A STYLE CHOICE.
//
// PlexiiDesk runs on castLabs' Electron for Content Security (ECS) so desk web
// pages can play Widevine video (Netflix and the rest). Commercial services
// also require a Verified Media Path (VMP) signature on the binary, issued by
// castLabs' EVS service (build/vmp.cjs). EVS signs a binary only when it is a
// castLabs release byte for byte, apart from the fuse wire, and the fuse wire
// may be one of exactly two things: the release's default, or this one fixed
// set (castLabs FAQ, "Can I use @electron/fuses with the free version of ECS
// and EVS?"; castlabs/electron-releases#152, supported from ECS 35). Any other
// combination is refused with "Binary signature denied".
//
// Before ECS this file's predecessor flipped three fuses (RunAsNode,
// NODE_OPTIONS, --inspect off). That wire is neither of the two, so EVS would
// refuse it and Netflix could never play. The default wire would undo that
// hardening. So the app takes castLabs' set, which keeps all three and adds
// three more that the old hook had held back pending a verified signed build:
//
//   EnableCookieEncryption — cookies on disk are encrypted with the "plexii
//     Safe Storage" keychain key (the one safeStorage already uses). ONE-WAY:
//     a build without this fuse cannot read cookies this build wrote, so
//     going back to an older build on the same profile signs the person out
//     of the sites whose cookies changed meanwhile. The old note here saw an
//     AD-HOC signed build hang at launch with it on (a keychain item it had
//     no identity for); a Developer ID build has a stable identity. Still to
//     be confirmed by a launch of a signed build — see docs/drm.md.
//   EnableEmbeddedAsarIntegrityValidation — the asar header hash must match
//     Info.plist's ElectronAsarIntegrity. @electron/universal writes it for the
//     universal build (and electron-builder for single-arch ones);
//     build/harden.cjs checks it is there before anything is signed.
//   OnlyLoadAppFromAsar — the app is only ever loaded from app.asar (no app/
//     folder, no default_app). Native modules still load from
//     app.asar.unpacked, which this fuse does not touch.
//
// Fuses NOT in the set (WasmTrapHandlers, and any added by later Electrons)
// must stay at their defaults, so they are not named here at all.
//
// tests/unit/fuses.test.ts pins this object to castLabs' published list.
const { FuseVersion, FuseV1Options } = require('@electron/fuses')

const FUSES = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: true
}

/** One line for the build log, in @electron/fuses' own names. */
function describeFuses(fuses = FUSES) {
  return Object.entries(fuses)
    .filter(([k]) => k !== 'version')
    .map(([k, v]) => `${FuseV1Options[k]}=${v ? 'on' : 'off'}`)
    .join(' ')
}

module.exports = { FUSES, describeFuses }
