// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { conferenceOf } from '../../src/main/calendar/sync'

// A mirrored event used to arrive as a title and a time.
//
// That is enough to draw a block on a grid and nothing like enough to act on:
// no guest list, no way to join the call, and no idea whether you had already
// accepted. "Fully integrated" starts here — the fields that make a meeting a
// meeting rather than a coloured rectangle.
//
// The pull itself talks to Google and Graph over the network, so what is
// testable without credentials is the part that decides what the fields MEAN:
// which link is the join link, what kind of call it is, and that the schema can
// carry a guest list in and back out again.

describe('conferenceOf — which link joins the call, and what kind it is', () => {
  it('prefers the modern conferenceData video entry point', () => {
    const got = conferenceOf({
      conferenceData: {
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+61000' },
          { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }
        ],
        conferenceSolution: { key: { type: 'hangoutsMeet' } }
      }
    })
    expect(got).toEqual({ url: 'https://meet.google.com/abc-defg-hij', kind: 'meet' })
  })

  it('never offers a phone number as the join link', () => {
    // A dial-in is not a thing a "Join" button can open.
    const got = conferenceOf({
      conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+61000' }] }
    })
    expect(got).toEqual({ url: null, kind: null })
  })

  it('falls back to hangoutLink, which plenty of real events still carry', () => {
    const got = conferenceOf({ hangoutLink: 'https://meet.google.com/zzz-zzzz-zzz' })
    expect(got.url).toBe('https://meet.google.com/zzz-zzzz-zzz')
    expect(got.kind).toBe('meet')
  })

  it('reports a Zoom booked through Google as Zoom, not as Meet', () => {
    // The solution key for a third-party add-on is just 'addOn', so the host is
    // what actually distinguishes them. Labelling a Zoom call "Meet" would be a
    // small lie on a button someone is about to press.
    const got = conferenceOf({
      conferenceData: {
        entryPoints: [{ entryPointType: 'video', uri: 'https://acme.zoom.us/j/123456' }],
        conferenceSolution: { key: { type: 'addOn' } }
      }
    })
    expect(got.kind).toBe('zoom')
  })

  it('recognises Teams', () => {
    const got = conferenceOf({
      conferenceData: {
        entryPoints: [
          { entryPointType: 'video', uri: 'https://teams.microsoft.com/l/meetup-join/abc' }
        ],
        conferenceSolution: { key: { type: 'addOn' } }
      }
    })
    expect(got.kind).toBe('teams')
  })

  it('admits it does not know, rather than guessing Meet', () => {
    const got = conferenceOf({
      conferenceData: {
        entryPoints: [{ entryPointType: 'video', uri: 'https://whereby.com/plexii' }],
        conferenceSolution: { key: { type: 'addOn' } }
      }
    })
    expect(got.kind).toBe('other')
    expect(got.url).toBe('https://whereby.com/plexii')
  })

  it('says nothing at all for an event with no conferencing', () => {
    expect(conferenceOf({})).toEqual({ url: null, kind: null })
  })
})

// ── The columns, in real SQLite ────────────────────────────────────────────
//
// external_events is created with CREATE TABLE IF NOT EXISTS, which leaves an
// existing table exactly as it was — so new columns reach no install that
// already had the table, which is every install. The ALTERs are what fix that,
// and this is the test that they are actually needed and actually run.

function legacyTable(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  // The table as it stood BEFORE the meeting fields.
  d.exec(`
    CREATE TABLE external_events (
      id TEXT PRIMARY KEY,
      calendar_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return d
}

const COLUMNS = ['attendees', 'conference_url', 'conference_kind', 'self_response', 'series_id']

describe('the meeting columns reach an install that already had the table', () => {
  it('CREATE TABLE IF NOT EXISTS would NOT have added them', () => {
    const d = legacyTable()
    // Re-running a create with the new columns is a no-op on an existing table.
    d.exec('CREATE TABLE IF NOT EXISTS external_events (id TEXT PRIMARY KEY, attendees TEXT)')
    const cols = (d.prepare('PRAGMA table_info(external_events)').all() as Array<{ name: string }>)
      .map((c) => c.name)
    expect(cols).not.toContain('attendees')
  })

  it('ALTER adds each one, and re-running is harmless', () => {
    const d = legacyTable()
    const add = (): void => {
      for (const col of COLUMNS) {
        try {
          d.exec(`ALTER TABLE external_events ADD COLUMN ${col} TEXT`)
        } catch (e) {
          // The one expected error, and the reason the real code swallows only
          // this and re-throws anything else.
          if (!/duplicate column name/i.test(e instanceof Error ? e.message : String(e))) throw e
        }
      }
    }
    add()
    add() // boot twice — the migration has to be idempotent
    const cols = (d.prepare('PRAGMA table_info(external_events)').all() as Array<{ name: string }>)
      .map((c) => c.name)
    for (const col of COLUMNS) expect(cols).toContain(col)
  })

  it('round-trips a guest list through the JSON column', () => {
    const d = legacyTable()
    for (const col of COLUMNS) d.exec(`ALTER TABLE external_events ADD COLUMN ${col} TEXT`)
    const attendees = [
      { email: 'ryan@example.com', name: 'Ryan', response: 'accepted', self: false },
      { email: 'me@example.com', name: 'Me', response: 'needsAction', self: true }
    ]
    d.prepare(
      `INSERT INTO external_events (id, calendar_id, uid, title, start_ms, end_ms, updated_at,
        attendees, self_response) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('e1', 'c1', 'u1', 'Standup', 1, 2, 3, JSON.stringify(attendees), 'needsAction')
    const row = d.prepare('SELECT attendees, self_response FROM external_events WHERE id = ?').get('e1') as {
      attendees: string
      self_response: string
    }
    expect(JSON.parse(row.attendees)).toHaveLength(2)
    // The signed-in user's own row is what the RSVP control binds to, and
    // Google's `self` flag is the only reliable way to find it — matching on
    // email breaks for delegated and aliased accounts.
    expect(JSON.parse(row.attendees).find((a: { self: boolean }) => a.self).email).toBe('me@example.com')
    expect(row.self_response).toBe('needsAction')
  })
})
