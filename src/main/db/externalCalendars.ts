import { randomUUID } from 'crypto'
import { getDb } from './database'
import type { ExternalCalendar, ExternalEvent, ExternalCalendarDraft } from '@shared/types'

// Calendars that live somewhere else.
//
// External events are kept in their OWN table rather than folded into
// time_blocks, and that separation is the whole design. A time block is
// something the user committed to inside Plexii; a Google event is a mirror of
// a fact held elsewhere. Mixing them would mean a sync could delete work the
// user typed, and "delete this event" would silently mean different things
// depending on which row you hit.
//
// Everything here is therefore replaceable: a sync can drop every row for a
// calendar and rebuild it without losing anything the user owns.

export function ensureExternalCalendarSchema(db: {
  exec(sql: string): void
}): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      email TEXT,
      -- safeStorage ciphertext of { accessToken, refreshToken, expiresAt }.
      -- Never returned to the renderer, in any shape.
      token_cipher TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS external_calendars (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT,
      -- ICS: the feed URL. OAuth: the provider's own calendar id.
      source_ref TEXT NOT NULL,
      account_id TEXT REFERENCES external_accounts(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_sync_at INTEGER,
      last_sync_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS external_events (
      id TEXT PRIMARY KEY,
      calendar_id TEXT NOT NULL REFERENCES external_calendars(id) ON DELETE CASCADE,
      uid TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT,
      location TEXT,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0,
      status TEXT,
      organizer TEXT,
      url TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ext_events_start ON external_events (start_ms);
    CREATE INDEX IF NOT EXISTS idx_ext_events_cal ON external_events (calendar_id);
  `)
}

interface CalRow {
  id: string
  provider: string
  name: string
  color: string | null
  source_ref: string
  account_id: string | null
  enabled: number
  last_sync_at: number | null
  last_sync_error: string | null
  created_at: number
  updated_at: number
}

const toCal = (r: CalRow): ExternalCalendar => ({
  id: r.id,
  provider: r.provider as ExternalCalendar['provider'],
  name: r.name,
  color: r.color,
  sourceRef: r.source_ref,
  accountId: r.account_id,
  enabled: r.enabled === 1,
  lastSyncAt: r.last_sync_at,
  lastSyncError: r.last_sync_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export function listCalendars(): ExternalCalendar[] {
  return (
    getDb().prepare('SELECT * FROM external_calendars ORDER BY created_at').all() as CalRow[]
  ).map(toCal)
}

export function getCalendar(id: string): ExternalCalendar | null {
  const r = getDb().prepare('SELECT * FROM external_calendars WHERE id = ?').get(id) as
    | CalRow
    | undefined
  return r ? toCal(r) : null
}

export function createCalendar(draft: ExternalCalendarDraft): ExternalCalendar {
  const id = draft.id ?? randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO external_calendars
       (id, provider, name, color, source_ref, account_id, enabled, created_at, updated_at)
       VALUES (@id, @provider, @name, @color, @sourceRef, @accountId, 1, @now, @now)`
    )
    .run({
      id,
      provider: draft.provider,
      name: draft.name,
      color: draft.color ?? null,
      sourceRef: draft.sourceRef,
      accountId: draft.accountId ?? null,
      now
    })
  return getCalendar(id) as ExternalCalendar
}

export function updateCalendar(
  id: string,
  patch: Partial<Pick<ExternalCalendar, 'name' | 'color' | 'enabled' | 'lastSyncAt' | 'lastSyncError'>>
): ExternalCalendar | null {
  const cols: Array<[keyof typeof patch, string]> = [
    ['name', 'name'],
    ['color', 'color'],
    ['lastSyncAt', 'last_sync_at'],
    ['lastSyncError', 'last_sync_error']
  ]
  const fields: string[] = []
  const params: Record<string, unknown> = { id, now: Date.now() }
  for (const [k, col] of cols) {
    if (patch[k] !== undefined) {
      fields.push(`${col} = @${String(k)}`)
      params[String(k)] = patch[k]
    }
  }
  if (patch.enabled !== undefined) {
    fields.push('enabled = @enabled')
    params.enabled = patch.enabled ? 1 : 0
  }
  if (fields.length === 0) return getCalendar(id)
  fields.push('updated_at = @now')
  getDb().prepare(`UPDATE external_calendars SET ${fields.join(', ')} WHERE id = @id`).run(params)
  return getCalendar(id)
}

export function deleteCalendar(id: string): boolean {
  // Events go with it: they are a mirror, and a mirror with nothing behind it
  // is just stale data pretending to be current.
  const db = getDb()
  db.prepare('DELETE FROM external_events WHERE calendar_id = ?').run(id)
  const res = db.prepare('DELETE FROM external_calendars WHERE id = ?').run(id)
  return (res.changes ?? 0) > 0
}

interface EventRow {
  id: string
  calendar_id: string
  uid: string
  title: string
  description: string | null
  location: string | null
  start_ms: number
  end_ms: number
  all_day: number
  status: string | null
  organizer: string | null
  url: string | null
  updated_at: number
}

const toEvent = (r: EventRow): ExternalEvent => ({
  id: r.id,
  calendarId: r.calendar_id,
  uid: r.uid,
  title: r.title,
  description: r.description,
  location: r.location,
  startMs: r.start_ms,
  endMs: r.end_ms,
  allDay: r.all_day === 1,
  status: r.status,
  organizer: r.organizer,
  url: r.url,
  updatedAt: r.updated_at
})

/** Events overlapping a window, from enabled calendars only. */
export function listEvents(fromMs: number, toMs: number): ExternalEvent[] {
  return (
    getDb()
      .prepare(
        `SELECT e.* FROM external_events e
         JOIN external_calendars c ON c.id = e.calendar_id
         WHERE c.enabled = 1 AND e.start_ms < @to AND e.end_ms > @from
         ORDER BY e.start_ms`
      )
      .all({ from: fromMs, to: toMs }) as EventRow[]
  ).map(toEvent)
}

/**
 * Replace everything a calendar holds inside a window.
 *
 * A feed is the whole truth about its own calendar, so a sync REPLACES the
 * window rather than merging into it -- that is the only way a deleted event
 * actually disappears. Bounded to the window so a narrow refresh cannot wipe
 * out months either side of it.
 */
export function replaceEventsInWindow(
  calendarId: string,
  fromMs: number,
  toMs: number,
  events: Omit<ExternalEvent, 'id' | 'calendarId' | 'updatedAt'>[]
): number {
  const db = getDb()
  const now = Date.now()
  const run = db.transaction(() => {
    db.prepare(
      'DELETE FROM external_events WHERE calendar_id = @cal AND start_ms < @to AND end_ms > @from'
    ).run({ cal: calendarId, from: fromMs, to: toMs })
    const ins = db.prepare(
      `INSERT OR REPLACE INTO external_events
       (id, calendar_id, uid, title, description, location, start_ms, end_ms, all_day,
        status, organizer, url, updated_at)
       VALUES (@id, @cal, @uid, @title, @description, @location, @start, @end, @allDay,
               @status, @organizer, @url, @now)`
    )
    for (const e of events) {
      ins.run({
        // Stable per occurrence, so a re-sync overwrites rather than duplicates.
        id: `${calendarId}:${e.uid}:${e.startMs}`,
        cal: calendarId,
        uid: e.uid,
        title: e.title,
        description: e.description ?? null,
        location: e.location ?? null,
        start: e.startMs,
        end: e.endMs,
        allDay: e.allDay ? 1 : 0,
        status: e.status ?? null,
        organizer: e.organizer ?? null,
        url: e.url ?? null,
        now
      })
    }
  })
  run()
  return events.length
}
