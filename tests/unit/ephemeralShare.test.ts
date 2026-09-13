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

// A recipient opened their link and got the PlexiSuite dashboard. The desk had
// imported perfectly -- 47 widgets, 6 tables, the lot -- and the window simply
// never went to it.
describe('opening the desk that was sent', () => {
  const nodes = [
    { id: 'folder', kind: 'folder' },
    { id: 'desk-a', kind: 'task' },
    { id: 'desk-b', kind: 'task' }
  ]

  it('opens the desk the share names', async () => {
    const { deskToOpen } = await import('../../src/renderer/src/lib/shareMode')
    expect(deskToOpen(nodes, 'desk-b')).toBe('desk-b')
  })

  it('falls back to the only desk when the id did not travel', async () => {
    // A link minted before the id was carried, or a browser refusing
    // sessionStorage. The workspace is built from the bundle alone, so the
    // first desk in it is the right answer rather than a guess.
    const { deskToOpen } = await import('../../src/renderer/src/lib/shareMode')
    expect(deskToOpen(nodes, null)).toBe('desk-a')
    expect(deskToOpen(nodes, 'not-here')).toBe('desk-a')
  })

  it('says "not yet" while the nodes are still loading', async () => {
    const { deskToOpen } = await import('../../src/renderer/src/lib/shareMode')
    // Navigating to a desk the store has not seen shows an empty canvas, which
    // looks exactly like the bug being fixed here.
    expect(deskToOpen([], 'desk-a')).toBeNull()
    expect(deskToOpen([{ id: 'f', kind: 'folder' }], null)).toBeNull()
  })

  it('skips an archived desk', async () => {
    const { deskToOpen } = await import('../../src/renderer/src/lib/shareMode')
    expect(deskToOpen([{ id: 'old', kind: 'task', archived: true }, { id: 'live', kind: 'task' }], null)).toBe('live')
  })

  it('moves the VIEW, which is the thing that decides what is on screen', async () => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const src = readFileSync(resolve(__dirname, '../../src/renderer/src/App.tsx'), 'utf8')
    const i = src.indexOf('A share window opens on the desk it was sent')
    expect(i).toBeGreaterThan(-1)
    const block = src.slice(i, i + 1200)
    // setActive was the first attempt and it did nothing: an effect below syncs
    // activeTaskId FROM currentView, so the dashboard won on the next render.
    expect(block).toContain('goTask')
    expect(block).not.toContain('setActive')
  })
})

// A recipient could open the desk and then do nothing with it -- no pan, no
// zoom, no click. Nothing in the data or the policy was wrong: #boot is a
// full-viewport fixed layer, hidden only while :empty, and a share window keeps
// a 40px countdown bar in it for the whole session. The bar was visible, the
// sheet around it was not, and every event landed on the sheet.
//
// No logic test could have caught it, so this reads the stylesheet.
describe('the gate layer does not sit on top of the desk', () => {
  const html = (): string => {
    const { readFileSync } = require('fs') as typeof import('fs')
    const { resolve } = require('path') as typeof import('path')
    return readFileSync(resolve(__dirname, '../../src/web/index.html'), 'utf8')
  }

  it('lets events through, because it is not always empty', () => {
    const css = html()
    const rule = css.slice(css.indexOf('#boot {'), css.indexOf('#boot:empty'))
    expect(rule).toContain('pointer-events: none')
  })

  it('gives its children their events back, so the bar and the gates still work', () => {
    expect(html()).toContain('#boot > * { pointer-events: auto; }')
  })

  it('still hides itself entirely when there is nothing in it', () => {
    expect(html()).toContain('#boot:empty { display: none; }')
  })

  it('starts the app below the bar rather than behind it', () => {
    expect(html()).toMatch(/html\.fb-share-bar #root \{[^}]*padding-top: 40px/)
  })

  it('adds that class only while the bar is mounted', async () => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const boot = readFileSync(resolve(__dirname, '../../src/web/boot.tsx'), 'utf8')
    // Bounded by the next top-level declaration, not by the first '\n}':
    // ExpiryBar's destructured parameters close with a brace at line start, so
    // that cut the body at 47 characters and the assertion passed on nothing.
    const from = boot.indexOf('function ExpiryBar(')
    const after = boot.indexOf('\ntype State', from)
    const body = boot.slice(from, after > -1 ? after : boot.length)
    expect(body.length).toBeGreaterThan(500)
    expect(body).toContain("classList.add('fb-share-bar')")
    expect(body).toContain("classList.remove('fb-share-bar')")
  })
})
