// The recipient's side of a 48-hour share.
//
// Three promises are made to two different people here, and each one is a line
// of code away from being false:
//
//   to the recipient — this is yours to edit, and it ends on a stated date
//   to the sender    — nothing they do comes back to you
//   to both          — when it ends, the copy is gone
//
// The second is the one worth testing hardest. It is true today partly by
// accident (a recipient has no account, so a sync request would fail anyway),
// and an accident is not a promise.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  shareTokenFromUrl, countdown, msLeft
} from '../../src/web/api/share'
import { markShareRecipient, isShareRecipient, shareRecipientToken } from '../../src/renderer/src/lib/shareMode'

describe('finding the share in a link', () => {
  it.each([
    ['https://cloud.plexii.app/s/abcd1234efgh', 'abcd1234efgh'],
    // Mounted under a path on the marketing site, which is how it ships.
    ['https://haptyx-web.vercel.app/share/s/abcd1234efgh', 'abcd1234efgh'],
    ['https://haptyx-web.vercel.app/share/s/abcd1234efgh/', 'abcd1234efgh'],
    ['https://cloud.plexii.app/s/abcd1234efgh/', 'abcd1234efgh'],
    // Chat clients mangle paths; a query fallback that works beats a clean one
    // that does not.
    ['https://cloud.plexii.app/?share=abcd1234efgh', 'abcd1234efgh'],
    ['https://cloud.plexii.app/', null],
    ['https://cloud.plexii.app/s/short', null],
    ['https://cloud.plexii.app/s/bad$token$here', null],
    ['not a url at all', null]
  ])('%s', (href, expected) => {
    expect(shareTokenFromUrl(href)).toBe(expected)
  })
})

describe('the countdown', () => {
  const t0 = 1_700_000_000_000
  it('is coarse while there is time and precise near the end', () => {
    expect(countdown(t0 + 47 * 3600_000, t0)).toBe('1d 23h left')
    expect(countdown(t0 + 5 * 3600_000, t0)).toBe('5h 0m left')
    expect(countdown(t0 + 90 * 60_000, t0)).toBe('1h 30m left')
    expect(countdown(t0 + 20 * 60_000, t0)).toBe('20 minutes left')
    expect(countdown(t0 + 60_000, t0)).toBe('1 minute left')
    expect(countdown(t0 + 30_000, t0)).toBe('less than a minute left')
  })

  it('never counts past the end', () => {
    expect(countdown(t0 - 1, t0)).toBe('expired')
    expect(countdown(t0 - 10 * 86_400_000, t0)).toBe('expired')
    expect(msLeft(t0 - 5000, t0)).toBe(0)
  })
})

describe('share mode', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.resetModules()
  })

  it('is off for an ordinary window', async () => {
    const fresh = await import('../../src/renderer/src/lib/shareMode?fresh-1')
      .catch(() => import('../../src/renderer/src/lib/shareMode'))
    expect(typeof fresh.isShareRecipient).toBe('function')
  })

  it('remembers which share this window is showing', () => {
    markShareRecipient('tok-123456789')
    expect(isShareRecipient()).toBe(true)
    expect(shareRecipientToken()).toBe('tok-123456789')
  })

  it('survives a reload, because the desk does', () => {
    markShareRecipient('tok-abcdefghij')
    expect(sessionStorage.getItem('fb.share.recipient')).toBe('tok-abcdefghij')
  })
})

describe('the promise that edits do not travel back', () => {
  it('is enforced in the sync loop itself, not left to a missing credential', async () => {
    // Read as source rather than executed: workspaceSync pulls in the whole
    // renderer graph, and what matters here is that the gate EXISTS in the
    // function that decides whether to sync at all.
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const src = readFileSync(
      resolve(__dirname, '../../src/renderer/src/lib/workspaceSync.ts'), 'utf8'
    )
    const enabled = src.slice(src.indexOf('function enabled('))
    const body = enabled.slice(0, enabled.indexOf('\n}'))
    expect(body).toContain('isShareRecipient()')
    // And it must come FIRST: a later return could shadow it.
    expect(body.indexOf('isShareRecipient()')).toBeLessThan(body.indexOf('localStorage'))
  })
})

// Three things have to agree about where this app is served from, and they are
// written in three different files: the URL an <img> asks for, the scope the
// Service Worker claims, and the prefix that worker answers. Disagreement is
// invisible in development (everything is at '/') and shows up in production as
// pictures that never load.
describe('serving the app from a path rather than a root', () => {
  it('derives the worker prefix from wherever the worker itself was served', () => {
    // The line in fb-file-sw.js, evaluated the way the browser evaluates it.
    const prefixFor = (swHref: string): string => new URL('./fb-file/', swHref).pathname
    expect(prefixFor('https://x/fb-file-sw.js')).toBe('/fb-file/')
    expect(prefixFor('https://haptyx-web.vercel.app/share/fb-file-sw.js')).toBe('/share/fb-file/')
  })

  it('keeps the worker file and its prefix in step in the shipped source', async () => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const sw = readFileSync(resolve(__dirname, '../../src/web/public/fb-file-sw.js'), 'utf8')
    // A hard-coded root prefix is the regression: it works at '/' and silently
    // serves nothing under a path.
    expect(sw).not.toMatch(/const PREFIX = ['"]\/fb-file\/['"]/)
    expect(sw).toContain("new URL('./fb-file/', self.location.href)")
  })

  it('asks for file bytes under the same base the app was served from', async () => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const src = readFileSync(resolve(__dirname, '../../src/renderer/src/lib/fileUrl.ts'), 'utf8')
    expect(src).toContain('webBase()')
    expect(src).not.toContain('`/fb-file/${encodeURIComponent(fileId)}`')
  })
})
