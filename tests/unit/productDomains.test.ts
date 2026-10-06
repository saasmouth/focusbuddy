// @vitest-environment node
//
// The four public surfaces, and the one place they are named.
//
// These hostnames are COMPILED INTO the installer. A user running a release
// carries whatever they said on build day, so changing DNS afterwards does not
// reach them: getting one wrong is not a deploy to redo, it is a release to
// redo, discovered when somebody cannot sign in. That is why they are named
// once and why this file exists.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTIVE, CURRENT, PRODUCTION, releaseAssetUrl, wsUrlFor } from '../../src/shared/productDomains'

const root = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')
const SURFACES = ['site', 'api', 'viewer', 'downloads'] as const

describe('the domain sets', () => {
  it('name every surface in both sets', () => {
    for (const k of SURFACES) {
      expect(PRODUCTION[k], `PRODUCTION.${k}`).toMatch(/^https:\/\/\S+$/)
      expect(CURRENT[k], `CURRENT.${k}`).toMatch(/^https:\/\/\S+$/)
    }
  })

  it('point production at the real domain', () => {
    for (const k of ['site', 'api', 'viewer', 'downloads'] as const) {
      expect(PRODUCTION[k], k).toContain('plexiidesk.com')
    }
  })

  it('derives the websocket url from the api origin', () => {
    expect(wsUrlFor('https://api.plexiidesk.com')).toBe('wss://api.plexiidesk.com/ws')
    expect(wsUrlFor('http://localhost:8787')).toBe('ws://localhost:8787/ws')
    // A trailing slash must not produce a double slash.
    expect(wsUrlFor('https://api.plexiidesk.com/')).toBe('wss://api.plexiidesk.com/ws')
  })

  it('is on exactly one set, deliberately', () => {
    // A hand-edited mixture is legitimate during a staged cutover, but it should
    // be a decision, not a typo — so it has to be one of the two named sets, or
    // a value from one of them per surface.
    for (const k of SURFACES) {
      expect(
        [PRODUCTION[k], CURRENT[k]],
        `ACTIVE.${k} is "${ACTIVE[k]}", which is in neither set`
      ).toContain(ACTIVE[k])
    }
  })
})

describe('nothing hardcodes a surface behind the config', () => {
  // The whole point is that cutover is one edit. A literal hostname anywhere
  // else silently opts that call site out of it.
  const EXEMPT = [
    'src/shared/productDomains.ts', // names them, by definition
    'src/renderer/src/vite-env.d.ts' // documents the env var's default in a comment
  ]

  it.each([
    ['src/renderer/src/lib/siteUrls.ts', 'ACTIVE.site'],
    ['src/renderer/src/lib/signalConfig.ts', 'ACTIVE.api'],
    ['src/renderer/src/lib/shareTokens.ts', 'ACTIVE.viewer']
  ])('%s reads the shared source', (file, expected) => {
    const src = read(file)
    expect(src).toContain(expected)
    expect(src, `${file} still carries a literal host`).not.toMatch(
      /'https:\/\/(focusbuddy-signal\.fly\.dev|focusbuddy-viewer\.vercel\.app|haptyx-web\.vercel\.app)/
    )
  })

  it('the release script derives the same values', () => {
    // It cannot import TypeScript, so it parses the module. If that parse ever
    // silently returns the wrong set, every build after it ships the wrong
    // backend — so the script exits non-zero rather than guessing, and this
    // pins that it reads the file at all.
    const src = read('scripts/release-env.mjs')
    expect(src).toContain('src/shared/productDomains.ts')
    expect(src).toContain('export const ACTIVE')
    expect(src).not.toMatch(/VITE_SIGNAL_HTTP_URL: 'https:\/\//)
  })
})

describe('the download origin, which is also the mac update channel', () => {
  // macOS does not use electron-updater's feed: autoUpdate.ts builds this URL
  // and fetches the zip itself. So this function is how a mac updates, and a
  // wrong value here is a silent 404 on every in-place update.
  it('keeps today\'s GitHub shape exactly', () => {
    expect(releaseAssetUrl(CURRENT.downloads, '4.3.8', 'Haptyx-4.3.8-mac-universal.zip')).toBe(
      'https://github.com/saasmouth/focusbuddy/releases/download/v4.3.8/Haptyx-4.3.8-mac-universal.zip'
    )
  })

  it('uses a flat per-version prefix for an object store', () => {
    expect(releaseAssetUrl(PRODUCTION.downloads, '4.3.8', 'Haptyx-4.3.8-mac-universal.zip')).toBe(
      'https://dl.plexiidesk.com/v4.3.8/Haptyx-4.3.8-mac-universal.zip'
    )
  })

  it('does not double a slash on a trailing-slash origin', () => {
    expect(releaseAssetUrl('https://dl.plexiidesk.com/', '1.0.0', 'a.zip')).toBe(
      'https://dl.plexiidesk.com/v1.0.0/a.zip'
    )
  })

  it('is the only place the mac updater builds its URL', () => {
    const src = readFileSync(join(root, 'src/main/updaterInstall.ts'), 'utf8')
    expect(src).toContain('releaseAssetUrl(ACTIVE.downloads')
    expect(src, 'updaterInstall still hardcodes github.com').not.toMatch(/https:\/\/github\.com/)
  })
})
