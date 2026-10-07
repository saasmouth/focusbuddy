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
import {
  ACTIVE,
  CURRENT,
  PRODUCTION,
  releaseAssetUrl,
  updateFeedUrl,
  usesGithubReleases
} from '../../src/shared/productDomains'

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

  it('loads the R2 credentials from .env by itself', () => {
    // Nothing else does. This script is invoked directly as
    // `node scripts/upload-release-assets.mjs <version>`, so without its own
    // parser process.env holds no R2 keys, mirrorToR2 takes the inert branch,
    // and the release reports success with the download origin empty.
    expect(uploader).toMatch(/readFileSync\(join\(root, '\.env'\)/)
    expect(uploader).toMatch(/R2_KEYS\.includes\(k\)/)
  })

  it('reads .env by parsing it, never by sourcing it', () => {
    // .env holds a bare value on a line of its own, with no `KEY=`, which a
    // shell executes when it sources the file. Same trap as release-env.mjs.
    expect(uploader).toMatch(/!t\.includes\('='\)/)
  })

  it('treats a key that is present but empty as unconfigured', () => {
    // .env ships R2_ACCESS_KEY_ID= and R2_SECRET_ACCESS_KEY= as placeholders
    // awaiting values. Taking '' as configuration would make the mirror attempt
    // an unauthenticated upload instead of reporting that it cannot run.
    expect(uploader).toMatch(/if \(v && !process\.env\[k\]\)/)
  })

  it('fails on PARTIAL configuration instead of skipping', () => {
    // The dangerous middle state: bucket and account set, secrets still blank.
    // The original guard was `if (!bucket || !account || !key || !secret)`,
    // which took the "not configured, skipping" branch and returned true — so a
    // release with a half-filled .env reported success and mirrored nothing.
    expect(uploader).toMatch(/partially configured/)
    expect(uploader).toMatch(/missing\.length === R2_KEYS\.length/)
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

describe('the cutover is deliberately partial', () => {
  // This replaces an earlier tripwire that asserted ACTIVE === CURRENT. That
  // guard existed to stop a cutover shipping before the mirror worked. The
  // mirror now works and has been verified against the live bucket, so the
  // guard becomes the opposite: assert the BRIDGE state exactly, surface by
  // surface, so neither half of it can drift unnoticed.

  it('downloads have moved to R2', () => {
    // Required for this release to be a bridge at all. Until a build ships
    // whose download origin is R2, every client asks GitHub forever and taking
    // the repo private strands all of them.
    expect(ACTIVE.downloads).toBe(PRODUCTION.downloads)
  })

  it('the site has NOT moved, because /download does not exist there yet', () => {
    // autoUpdate.ts compiles the manual-download fallback as
    // `${ACTIVE.site}/download`. www.plexiidesk.com serves a GoDaddy builder
    // page and returns 404 on that path; haptyx-web.vercel.app returns 200.
    // Shipping the broken one is a release to redo, and it is reached by
    // exactly the user who has just been told to download manually.
    expect(ACTIVE.site).toBe(CURRENT.site)
  })

  it('the api and viewer have NOT moved', () => {
    // Both production hosts resolve and serve — api.plexiidesk.com/healthz
    // returns 200. They are held back on purpose: the api carries signup,
    // login, sharing and plan checks for every user, so it moves in a release
    // that exists to move it, not one about download origins.
    expect(ACTIVE.api).toBe(CURRENT.api)
    expect(ACTIVE.viewer).toBe(CURRENT.viewer)
  })
})

describe('detection and download cannot diverge', () => {
  // The subtlety that nearly shipped. electron-builder bakes its `publish`
  // block into Resources/app-update.yml, and THAT is what electron-updater
  // reads to detect an update, on both platforms. Where macOS downloads from is
  // a separate path through updaterInstall.ts and ACTIVE.downloads.
  //
  // Flipping ACTIVE.downloads to R2 while publish still said `provider: github`
  // would give a client that downloads from R2 but asks GitHub whether an
  // update exists — so taking the repo private would break detection for
  // everyone, including the release meant to be the bridge off GitHub.
  const builderConfig = require('../../electron-builder.cjs') as {
    publish: { provider: string; url?: string; channel?: string; owner?: string; repo?: string }
  }

  it('the baked feed follows ACTIVE.downloads', () => {
    if (usesGithubReleases(ACTIVE.downloads)) {
      expect(builderConfig.publish.provider).toBe('github')
    } else {
      expect(builderConfig.publish.provider).toBe('generic')
      expect(builderConfig.publish.url).toBe(ACTIVE.downloads.replace(/\/+$/, ''))
    }
  })

  it('reads the feed from the bucket root, not a versioned prefix', () => {
    // The feed URL is compiled into the installer, so it cannot name the next
    // version's prefix — it has to be a fixed directory whose contents roll.
    if (usesGithubReleases(ACTIVE.downloads)) return
    expect(builderConfig.publish.url).toBe(updateFeedUrl(ACTIVE.downloads))
    expect(builderConfig.publish.url, 'feed points at a versioned prefix').not.toMatch(/\/v\d/)
  })
})

describe('the bucket layout', () => {
  it('writes every asset to both the versioned prefix and the root', () => {
    // v<version>/<file> is the immutable archive that releaseAssetUrl builds;
    // <file> at the root is the flat directory electron-updater's generic feed
    // needs beside its manifest. Dropping either breaks one of the two paths.
    expect(uploader).toContain('`v${VERSION}/${name}`, name')
  })

  it('uploads manifests LAST', () => {
    // The root copies are a live feed. A client polling mid-upload that reads a
    // new latest.yml naming an artifact still uploading gets a 404 and a failed
    // update.
    expect(uploader).toMatch(/\.endsWith\('\.yml'\)/)
    expect(uploader).toContain('[...artifacts, ...manifests]')
  })
})

describe('the manual-download fallback', () => {
  const updater = readFileSync(join(root, 'src/main/autoUpdate.ts'), 'utf8')

  it('sends the user to the product page, not the code host', () => {
    // Reached when the in-place update cannot run. A GitHub releases page
    // behind auth shows a 404 to exactly the user who has just been told to
    // download manually — and this string is compiled into the binary, so it
    // has to be right in the build that ships BEFORE the repo closes.
    expect(updater).toMatch(/RELEASES_URL = `\$\{ACTIVE\.site\}\/download`/)
    expect(updater, 'still points at github').not.toMatch(/github\.com\/saasmouth/)
  })
})
