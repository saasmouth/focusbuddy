import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { macAssetUrl, MAC_UPDATE_ARCH } from '../../src/main/updaterInstall'

// The in-app mac updater builds its own download URL instead of reading
// latest-mac.yml, so two things have to agree that nothing makes agree:
//
//   MAC_UPDATE_ARCH            — the slice the updater ASKS for
//   electron-builder.cjs mac   — the slice the build PRODUCES
//
// When they disagreed the update did not fail loudly. It 404'd on an asset name
// nobody had ever published, after the user had clicked update, with the release
// itself perfectly healthy — which is how 4.3.0 shipped an updater asking for
// `mac-arm64.zip` while the build was about to start producing `mac-universal`.
//
// This also pins the artifact name pattern, because the URL is assembled from it
// by hand rather than read from the manifest.

const ROOT = join(__dirname, '..', '..')
const BUILDER = readFileSync(join(ROOT, 'electron-builder.cjs'), 'utf-8')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { version: string }

/** The `arch: [...]` entries inside the mac target list. */
function macTargetArchs(): string[] {
  // Narrow to the mac block so the win target's x64 cannot be mistaken for one.
  const start = BUILDER.indexOf('\n  mac: {')
  expect(start, 'could not find the mac block in electron-builder.cjs').toBeGreaterThan(-1)
  const targetAt = BUILDER.indexOf('target: [', start)
  const end = BUILDER.indexOf('],', targetAt)
  const block = BUILDER.slice(targetAt, end)
  return [...block.matchAll(/arch: \['([a-z0-9]+)'\]/g)].map((m) => m[1])
}

describe('the updater asks for the slice the build actually produces', () => {
  it('every mac target is built for the arch the updater requests', () => {
    const archs = macTargetArchs()
    expect(archs.length).toBeGreaterThan(0)
    for (const a of archs) expect(a).toBe(MAC_UPDATE_ARCH)
  })

  it('both the zip and the dmg are built, since the updater needs one and the site the other', () => {
    const start = BUILDER.indexOf('\n  mac: {')
    const targetAt = BUILDER.indexOf('target: [', start)
    const block = BUILDER.slice(targetAt, BUILDER.indexOf('],', targetAt))
    expect(block).toContain("target: 'zip'")
    expect(block).toContain("target: 'dmg'")
  })

  it('the artifact name pattern still produces the filename the URL is built from', () => {
    // macAssetUrl hand-assembles Haptyx-<version>-mac-<arch>.zip. If artifactName
    // changed shape, the updater would ask for a file the build never wrote.
    expect(BUILDER).toContain("artifactName: 'Haptyx-${version}-${os}-${arch}.${ext}'")
    const url = macAssetUrl(PKG.version, MAC_UPDATE_ARCH)
    expect(url).toContain(`Haptyx-${PKG.version}-mac-${MAC_UPDATE_ARCH}.zip`)
  })

  it('names the version currently in package.json, so a release cannot point at the previous one', () => {
    expect(macAssetUrl(PKG.version, MAC_UPDATE_ARCH)).toContain(`/v${PKG.version}/`)
  })
})

describe('an already-installed client can still be updated', () => {
  // 4.3.1 and later ask for `universal`; anything older hand-built `mac-arm64`
  // from process.arch and cannot be changed retroactively. release-mac.sh
  // publishes an arm64-named copy of the universal zip for exactly those, so the
  // name they ask for has to keep resolving.
  it('release-mac.sh still publishes the arm64-named compatibility alias', () => {
    const script = readFileSync(join(ROOT, 'scripts/release-mac.sh'), 'utf-8')
    expect(script).toContain('mac-arm64.zip')
    expect(script).toMatch(/COMPAT_ZIP/)
  })

  it('the release gate requires the zip the updater downloads', () => {
    const gate = readFileSync(join(ROOT, 'scripts/verify-release-assets.sh'), 'utf-8')
    // The updater's own asset, its blockmap, and the manifest electron-updater reads.
    expect(gate).toContain('mac-${MAC_ARCH}.zip"')
    expect(gate).toContain('latest-mac.yml')
    // And the dmg, which is what a NEW user downloads from the site.
    expect(gate).toContain('mac-${MAC_ARCH}.dmg"')
  })
})
