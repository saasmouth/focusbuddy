// @vitest-environment node
//
// The bridge off GitHub.
//
// The download URL is compiled into every installer, so a client running today
// asks GitHub for its update forever. R2 therefore cannot replace GitHub by
// being switched on: both have to serve until every client still expected to
// update in place has taken a build pointing at R2. Getting this order wrong
// strands trial users permanently — their updater has nowhere else to look.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PRODUCTION, releaseAssetUrl } from '../../src/shared/productDomains'

const root = join(__dirname, '..', '..')
const uploader = readFileSync(join(root, 'scripts/upload-release-assets.mjs'), 'utf8')

describe('the R2 mirror', () => {
  it('writes to the same path the updater will ask for', () => {
    // The uploader's remote key and releaseAssetUrl's object-store shape have to
    // agree, or the updater requests a path nothing was ever written to — a 404
    // that only appears after the cutover, on other people's machines.
    expect(uploader).toContain('`v${VERSION}/${name}`')
    expect(releaseAssetUrl(PRODUCTION.downloads, '9.9.9', 'x.zip')).toBe(
      'https://dl.plexiidesk.com/v9.9.9/x.zip'
    )
  })

  it('mirrors every asset a client could ask for', () => {
    // Both platforms and both manifests. A mac-only mirror would strand Windows
    // at the moment GitHub goes private.
    for (const needed of ['latest-mac.yml', 'latest.yml', 'win-x64.exe', 'mac-arm64.zip']) {
      expect(uploader, `${needed} missing from the mirror list`).toContain(needed)
    }
  })

  it('does nothing until R2 is configured', () => {
    // It has to be inert while the bucket does not exist, or every release
    // between now and then fails on an absent credential.
    expect(uploader).toMatch(/skipping mirror/)
    expect(uploader).toMatch(/R2_BUCKET/)
  })

  it('fails loudly once it IS configured but cannot run', () => {
    // The opposite risk: configured, tooling missing, mirror silently skipped,
    // and the release reports success with half the origin empty.
    expect(uploader).toMatch(/R2 is configured but the aws CLI is not installed/)
    expect(uploader).toMatch(/return false/)
  })

  it('still publishes to GitHub as well', () => {
    // The bridge is both, not a swap. Dropping GitHub here is what would
    // strand everyone already installed.
    expect(uploader).toContain('uploads.github.com')
  })
})

describe('the cutover is not half-done', () => {
  it('still points clients at GitHub for now', () => {
    const domains = readFileSync(join(root, 'src/shared/productDomains.ts'), 'utf8')
    // ACTIVE must stay on CURRENT until a release has shipped that points at
    // R2. Flipping it before the mirror runs gives every new install a download
    // origin with nothing in it.
    expect(domains).toMatch(/export const ACTIVE: ProductDomains = CURRENT/)
  })
})
