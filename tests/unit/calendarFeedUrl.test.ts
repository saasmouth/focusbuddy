// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'

// Feed URLs and the sync window — the pure half of calendar sync.
//
// A calendar feed URL is usually pasted by a person who was told "give us your
// calendar link", so it arrives as webcal://, with stray whitespace, or as
// something that is not a URL at all. It is also, for a Google "secret
// address", the entire security model: whoever holds the URL reads the diary.
// Nothing here was tested.

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, net: { fetch: vi.fn() } }))
vi.mock('../../src/main/db/database', () => ({ getDb: () => ({}) }))

import { normaliseFeedUrl, feedUrlProblem, syncWindow, SYNC_BACK_MS, SYNC_FORWARD_MS } from '../../src/main/calendar/sync'

describe('normaliseFeedUrl', () => {
  it('turns webcal into https — it is https with a different word in front', () => {
    expect(normaliseFeedUrl('webcal://calendar.google.com/x/basic.ics')).toBe('https://calendar.google.com/x/basic.ics')
  })

  it('does so whatever the case, because people type WEBCAL too', () => {
    expect(normaliseFeedUrl('WebCal://a.test/c.ics')).toBe('https://a.test/c.ics')
  })

  it('trims what a paste drags along with it', () => {
    expect(normaliseFeedUrl('  https://a.test/c.ics\n')).toBe('https://a.test/c.ics')
  })

  it('leaves an ordinary https URL exactly as it was', () => {
    // Including the query string, which is where a secret address keeps its key.
    const u = 'https://a.test/c.ics?token=abc123&x=1'
    expect(normaliseFeedUrl(u)).toBe(u)
  })

  it('only rewrites the scheme, never a "webcal" elsewhere in the URL', () => {
    expect(normaliseFeedUrl('https://webcal.test/webcal://x')).toBe('https://webcal.test/webcal://x')
  })
})

describe('feedUrlProblem — checked before a feed is saved', () => {
  it('accepts https and webcal feeds', () => {
    expect(feedUrlProblem('https://a.test/c.ics')).toBeNull()
    expect(feedUrlProblem('webcal://a.test/c.ics')).toBeNull()
  })

  it('accepts plain http rather than refusing an intranet feed', () => {
    // Deliberately allowed: some internal feeds are http. Refusing would push
    // people to a worse workaround than an unencrypted link on their own network.
    expect(feedUrlProblem('http://intranet.local/team.ics')).toBeNull()
  })

  it('rejects something that is not a URL, in words a person can act on', () => {
    expect(feedUrlProblem('my work calendar')).toBe('That does not look like a URL.')
    expect(feedUrlProblem('')).toBe('That does not look like a URL.')
  })

  it('rejects schemes that are not a web feed', () => {
    // file: would read the local disk; javascript: and data: are not fetches at all.
    for (const u of ['file:///etc/passwd', 'ftp://a.test/c.ics', 'javascript:alert(1)', 'data:text/calendar,BEGIN:VCALENDAR']) {
      expect(feedUrlProblem(u), u).toBe('A calendar feed must be an http(s) or webcal address.')
    }
  })

  it('judges the NORMALISED URL, so a pasted webcal link is not rejected as an odd scheme', () => {
    expect(feedUrlProblem('  WEBCAL://a.test/c.ics  ')).toBeNull()
  })
})

describe('syncWindow', () => {
  it('reaches a year back and two years forward', () => {
    const now = Date.UTC(2026, 8, 21)
    expect(syncWindow(now)).toEqual({ from: now - SYNC_BACK_MS, to: now + SYNC_FORWARD_MS })
  })

  it('is wide enough to hold next year\'s recurring meetings', () => {
    // The forward reach is what a sync is allowed to DELETE and rewrite, so it
    // must at least cover a full year ahead or annual events drop out.
    expect(SYNC_FORWARD_MS).toBeGreaterThanOrEqual(365 * 86_400_000)
    expect(SYNC_BACK_MS).toBeGreaterThan(0)
  })

  it('moves with the clock rather than being fixed at start-up', () => {
    const a = syncWindow(1_000_000_000_000)
    const b = syncWindow(1_000_000_000_000 + 86_400_000)
    expect(b.from - a.from).toBe(86_400_000)
  })
})
