import { randomUUID } from 'crypto'
import { getDb } from './database'
import { getActiveOrgId } from './activeOrg'
import { advanceSchedule } from '@shared/schedule'
import type { TimeBlock, TimeBlockDraft, TimeBlockMeeting, TimeBlockPatch, TimeBlockRecurrence } from '@shared/types'

interface TimeBlockRow {
  id: string
  task_id: string | null
  title: string
  start_ms: number
  duration_min: number
  status: TimeBlock['status']
  meeting_json: string | null
  recurrence: TimeBlockRecurrence | null
  series_id: string | null
  origin: 'manual' | 'auto'
  locked: number
  push_policy: 'local' | 'push'
  calendar_id: string | null
  external_event_id: string | null
  external_calendar_id: string | null
  created_at: number
  updated_at: number
}

// The meeting payload is stored as JSON so the block schema stays flat. A
// malformed value resolves to no meeting rather than throwing — a corrupt row
// should never take the whole calendar down.
function parseMeeting(raw: string | null): TimeBlockMeeting | null {
  if (!raw) return null
  try {
    const m = JSON.parse(raw) as TimeBlockMeeting
    if (m && typeof m.roomId === 'string' && Array.isArray(m.invitees)) return m
  } catch {
    /* fall through to null */
  }
  return null
}

function rowToBlock(row: TimeBlockRow): TimeBlock {
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    startMs: row.start_ms,
    durationMin: row.duration_min,
    status: row.status,
    meeting: parseMeeting(row.meeting_json),
    recurrence: row.recurrence ?? null,
    seriesId: row.series_id ?? null,
    origin: row.origin === 'auto' ? 'auto' : 'manual',
    locked: !!row.locked,
    pushPolicy: row.push_policy === 'push' ? 'push' : 'local',
    calendarId: row.calendar_id ?? null,
    externalEventId: row.external_event_id ?? null,
    externalCalendarId: row.external_calendar_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// Blocks that OVERLAP the [fromMs, toMs) window — a block counts if it starts
// before the window ends and ends after the window starts, so a long block
// spanning the boundary still shows.
export function listBlocksInRange(fromMs: number, toMs: number): TimeBlock[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM time_blocks
       WHERE org_id = @orgId AND trashed_at IS NULL AND start_ms < @to AND (start_ms + duration_min * 60000) > @from
       ORDER BY start_ms ASC`
    )
    .all({ from: fromMs, to: toMs, orgId: getActiveOrgId() }) as TimeBlockRow[]
  return rows.map(rowToBlock)
}

export function createTimeBlock(draft: TimeBlockDraft): TimeBlock {
  const db = getDb()
  // WS01 lifecycle: honour a client-provided id (create-if-missing by primary key).
  const id = draft.id ?? randomUUID()
  if (draft.id) {
    const existing = db.prepare('SELECT * FROM time_blocks WHERE id = ?').get(draft.id) as TimeBlockRow | undefined
    if (existing) return rowToBlock(existing)
  }
  const now = Date.now()
  const duration = Math.max(5, Math.round(draft.durationMin))
  db.prepare(
    `INSERT INTO time_blocks (id, task_id, title, start_ms, duration_min, status, meeting_json, recurrence, series_id, origin, created_at, updated_at, org_id)
     VALUES (@id, @taskId, @title, @startMs, @durationMin, 'planned', @meetingJson, @recurrence, @seriesId, @origin, @now, @now, @orgId)`
  ).run({
    id,
    origin: draft.origin === 'auto' ? 'auto' : 'manual',
    taskId: draft.taskId ?? null,
    title: draft.title ?? '',
    startMs: Math.round(draft.startMs),
    durationMin: duration,
    meetingJson: draft.meeting ? JSON.stringify(draft.meeting) : null,
    recurrence: draft.recurrence ?? null,
    // The first occurrence anchors its own series.
    seriesId: draft.recurrence ? id : null,
    orgId: getActiveOrgId(),
    now
  })
  if (draft.recurrence) materializeRecurringBlocks()
  const row = db.prepare('SELECT * FROM time_blocks WHERE id = ?').get(id) as TimeBlockRow
  return rowToBlock(row)
}

// How far ahead a repeating series is materialised, and the per-run safety cap.
const RECUR_HORIZON_MS = 60 * 24 * 60 * 60 * 1000 // 60 days
const RECUR_MAX_PER_RUN = 500

/**
 * Extend every active repeating series with real occurrence rows up to the
 * rolling horizon. Idempotent and cheap (each series continues from its newest
 * row), so it is safe to run on every create and on the periodic main tick.
 * Meetings are NOT copied onto generated occurrences: a meeting room id is a
 * one-time thing; repeating meetings can be revisited when invitee flows are.
 */
export function materializeRecurringBlocks(): void {
  const db = getDb()
  const horizon = Date.now() + RECUR_HORIZON_MS
  // The newest row per series carries the pattern forward. A series where the
  // user cleared recurrence (delete "this and future") has no recurring newest
  // row and is skipped.
  const heads = db
    .prepare(
      `SELECT t.* FROM time_blocks t
       JOIN (SELECT series_id, MAX(start_ms) AS max_start FROM time_blocks
             WHERE series_id IS NOT NULL AND trashed_at IS NULL GROUP BY series_id) m
         ON t.series_id = m.series_id AND t.start_ms = m.max_start
       WHERE t.recurrence IS NOT NULL AND t.trashed_at IS NULL AND t.start_ms < @horizon`
    )
    .all({ horizon }) as TimeBlockRow[]
  let budget = RECUR_MAX_PER_RUN
  // Occurrence ids are DETERMINISTIC (seriesId@startMs): with multi-device
  // sync, two devices materialising the same series produce identical rows
  // that upsert-dedupe by id instead of duplicating, and a tombstoned
  // (deleted) occurrence blocks its own regeneration because the row id
  // already exists. ON CONFLICT DO NOTHING makes the whole pass idempotent.
  const insert = db.prepare(
    `INSERT INTO time_blocks (id, task_id, title, start_ms, duration_min, status, meeting_json, recurrence, series_id, origin, created_at, updated_at, org_id)
     VALUES (@id, @taskId, @title, @startMs, @durationMin, 'planned', NULL, @recurrence, @seriesId, @origin, @now, @now, @orgId)
     ON CONFLICT(id) DO NOTHING`
  )
  for (const head of heads) {
    let cursor = head.start_ms
    while (budget > 0) {
      cursor = advanceSchedule(head.recurrence as TimeBlockRecurrence, cursor)
      if (cursor >= horizon) break
      const now = Date.now()
      insert.run({
        id: `${head.series_id}@${cursor}`,
        origin: head.origin === 'auto' ? 'auto' : 'manual',
        taskId: head.task_id,
        title: head.title,
        startMs: cursor,
        durationMin: head.duration_min,
        recurrence: head.recurrence,
        seriesId: head.series_id,
        orgId: getActiveOrgId(),
        now
      })
      budget--
    }
  }
}

export function updateTimeBlock(id: string, patch: TimeBlockPatch): TimeBlock | null {
  const db = getDb()
  const fields: string[] = []
  const params: Record<string, unknown> = { id, now: Date.now() }
  const cols: Array<[keyof TimeBlockPatch, string, (v: unknown) => unknown]> = [
    ['taskId', 'task_id', (v) => v ?? null],
    ['title', 'title', (v) => v],
    ['startMs', 'start_ms', (v) => Math.round(v as number)],
    ['durationMin', 'duration_min', (v) => Math.max(5, Math.round(v as number))],
    ['status', 'status', (v) => v],
    ['meeting', 'meeting_json', (v) => (v ? JSON.stringify(v) : null)],
    // DEC-052: the pin and the per-block push choice are patchable; origin is
    // a birth fact and is not.
    ['locked', 'locked', (v) => (v ? 1 : 0)],
    ['pushPolicy', 'push_policy', (v) => (v === 'push' ? 'push' : 'local')],
    // Which internal calendar the block sits on — its colour, and whether it is
    // pushed out.
    ['calendarId', 'calendar_id', (v) => v ?? null],
    // Written by the push engine, not by a person.
    ['externalEventId', 'external_event_id', (v) => v ?? null],
    ['externalCalendarId', 'external_calendar_id', (v) => v ?? null]
  ]
  for (const [key, col, coerce] of cols) {
    if (patch[key] !== undefined) {
      fields.push(`${col} = @${key}`)
      params[key] = coerce(patch[key])
    }
  }
  if (fields.length === 0) {
    const row = db.prepare('SELECT * FROM time_blocks WHERE id = ?').get(id) as
      | TimeBlockRow
      | undefined
    return row ? rowToBlock(row) : null
  }
  fields.push('updated_at = @now')
  db.prepare(`UPDATE time_blocks SET ${fields.join(', ')} WHERE id = @id`).run(params)
  const row = db.prepare('SELECT * FROM time_blocks WHERE id = ?').get(id) as
    | TimeBlockRow
    | undefined
  return row ? rowToBlock(row) : null
}

/**
 * Delete a block. scope 'one' (default) removes just this occurrence; scope
 * 'series' removes this occurrence and everything after it in the same series
 * AND clears recurrence on the earlier rows, so the materialiser never regrows
 * the deleted tail. Past occurrences stay as an honest record of time spent.
 */
export function deleteTimeBlock(id: string, scope: 'one' | 'series' = 'one'): boolean {
  const db = getDb()
  const now = Date.now()
  if (scope === 'series') {
    const row = db.prepare('SELECT series_id, start_ms FROM time_blocks WHERE id = ?').get(id) as
      | { series_id: string | null; start_ms: number }
      | undefined
    if (row?.series_id) {
      // Tombstones, not hard deletes: sync propagates the deletion to other
      // devices, and the tombstoned deterministic ids stop the materialiser
      // regenerating the tail everywhere.
      const tx = db.transaction(() => {
        db.prepare('UPDATE time_blocks SET trashed_at = ?, updated_at = ? WHERE series_id = ? AND start_ms >= ? AND trashed_at IS NULL')
          .run(now, now, row.series_id, row.start_ms)
        db.prepare('UPDATE time_blocks SET recurrence = NULL, updated_at = ? WHERE series_id = ?').run(now, row.series_id)
      })
      tx()
      return true
    }
  }
  const r = db.prepare('UPDATE time_blocks SET trashed_at = ?, updated_at = ? WHERE id = ? AND trashed_at IS NULL').run(now, now, id)
  return r.changes > 0
}
