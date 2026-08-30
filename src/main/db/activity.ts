import { randomUUID } from 'crypto'
import { getDb } from './database'
import { getActiveOrgId } from './activeOrg'
import { navTrailGate, type NavTrailGate } from '@shared/navTrail'
import type { ActivityEvent, ActivityRecordDraft } from '@shared/types'

interface ActivityRow {
  id: string
  task_id: string | null
  ts: number
  kind: string
  payload: string | null
}

function rowToEvent(row: ActivityRow): ActivityEvent {
  let payload: Record<string, unknown> = {}
  if (row.payload) {
    try {
      const parsed = JSON.parse(row.payload)
      if (parsed && typeof parsed === 'object') payload = parsed
    } catch {
      // ignore malformed payloads — better to return the event with empty payload than throw
    }
  }
  return {
    id: row.id,
    taskId: row.task_id,
    ts: row.ts,
    kind: row.kind as ActivityEvent['kind'],
    payload
  }
}

/** The slice of a database handle the write path needs. See `PruneDb` below. */
export interface ActivityWriteDb {
  prepare(sql: string): { run: (...args: (string | number | null)[]) => unknown }
}

/** Injection seams, all defaulting to production. Tests supply them; nobody else does. */
export interface RecordActivityDeps {
  db?: ActivityWriteDb
  gate?: NavTrailGate
  now?: number
  orgId?: string
  id?: string
}

// Should this draft become a row? Everything that is not navigation always
// does; `browser_nav` is asked, because it is the only kind a machine can emit
// on a loop (DEC-058 — see shared/navTrail.ts for the 39,762-row forensics).
//
// An unkeyable payload — no widgetId, no url — is admitted rather than dropped.
// The gate removes noise; it must never be the reason a navigation vanished.
export function admitsNavRow(
  draft: ActivityRecordDraft,
  gate: NavTrailGate,
  now: number
): boolean {
  if (draft.kind !== NAV_KIND) return true
  const payload = draft.payload
  const widgetId = typeof payload?.widgetId === 'string' ? payload.widgetId : ''
  const url = typeof payload?.url === 'string' ? payload.url : ''
  return gate.admit({ widgetId, url }, now)
}

/**
 * Write one activity row. Returns whether it was written — `false` means the
 * navigation trail coalesced it into a row that already exists, which is a
 * normal outcome and not an error.
 */
export function recordActivity(draft: ActivityRecordDraft, deps: RecordActivityDeps = {}): boolean {
  const now = deps.now ?? Date.now()
  if (!admitsNavRow(draft, deps.gate ?? navTrailGate, now)) return false
  const db = deps.db ?? (getDb() as unknown as ActivityWriteDb)
  // Positional binding, matching the reads below: it is the form the tests can
  // drive through node:sqlite, since better-sqlite3 cannot load in the runner.
  db.prepare(
    `INSERT INTO activity_log (id, task_id, ts, kind, payload, org_id) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    deps.id ?? randomUUID(),
    draft.taskId,
    now,
    draft.kind,
    draft.payload ? JSON.stringify(draft.payload) : null,
    deps.orgId ?? getActiveOrgId()
  )
  return true
}

export function getRecentActivity(opts: {
  taskId?: string | null
  sinceMs?: number
  limit?: number
}): ActivityEvent[] {
  const db = getDb()
  const limit = opts.limit ?? 80
  const sinceMs = opts.sinceMs ?? 0
  let rows: ActivityRow[]
  if (opts.taskId) {
    rows = db
      .prepare(
        `SELECT * FROM activity_log WHERE task_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`
      )
      .all(opts.taskId, sinceMs, limit) as ActivityRow[]
  } else {
    rows = db
      .prepare(`SELECT * FROM activity_log WHERE ts >= ? AND org_id = ? ORDER BY ts DESC LIMIT ?`)
      .all(sinceMs, getActiveOrgId(), limit) as ActivityRow[]
  }
  return rows.map(rowToEvent)
}

// ── Retention (DEC-057) ──────────────────────────────────────────────────────
// The cap here used to read `keep = 5000`, table-wide, newest-first — and it
// was never called from anywhere (see db/retention.ts, which is where every
// prune in this codebase gets its one and only caller). Measuring the live
// table before wiring it up showed why that shape was the wrong cap to make
// real rather than simply an unenforced one:
//
//   activity_log        52,208 rows / 15.79 MB
//   ├─ browser_nav      50,120  (96%)  — one row per webview navigation
//   │    └─ of which    39,762  arrived in a single ~19-hour window on
//   │                           2026-06-29→30: ~35 rows/minute, sustained.
//   │                           That one burst is 76% of the whole table.
//   └─ everything else   2,088  — task_switched, widget_added, chat_sent,
//                                 session_started/ended, spread evenly across
//                                 all 83 days the log covers.
//
// A table-wide keep-newest-5,000 would have deleted 47,208 rows, and the rows
// it evicted would have included genuine history — task_switched and chat_sent
// events a person would recognise in the feed — to make room for navigation
// telemetry outnumbering them 24:1. The volume problem and the history worth
// keeping are not the same rows, so the policy stops treating them as one:
//
//   • browser_nav is capped by COUNT, per organisation (`navKeep`).
//   • every kind, browser_nav included, is bounded by AGE (`maxAgeDays`).
//
// The feed therefore keeps a deep recent navigation trail and its complete
// record of the things a person actually did.
//
// Why not age alone: the burst sits 58 days back, so a 60-day ceiling would
// retain all 39,762 of its rows and a 30-day ceiling would delete 49,442 —
// nearly all the real history with it. A single age number cannot separate a
// runaway from a working week; combined with the per-kind count cap, it does
// not have to.
export interface ActivityRetentionPolicy {
  /** browser_nav rows retained per organisation. */
  navKeep: number
  /** Age ceiling applied to every kind, browser_nav included. */
  maxAgeDays: number
}

export const ACTIVITY_RETENTION: ActivityRetentionPolicy = { navKeep: 2_000, maxAgeDays: 90 }

export interface ActivityPruneResult {
  navRemoved: number
  agedRemoved: number
  removed: number
}

// The slice of a database handle retention needs. Production passes
// better-sqlite3; the unit tests drive the same SQL through node:sqlite, which
// is the only way this logic is testable at all — better-sqlite3 is built
// against the Electron ABI and cannot load in the test runner.
export interface PruneDb {
  prepare(sql: string): {
    run: (...args: (string | number)[]) => unknown
    get: (...args: (string | number)[]) => unknown
  }
}

export const NAV_KIND = 'browser_nav'

function changed(result: unknown): number {
  return Number((result as { changes?: number } | undefined)?.changes ?? 0)
}

// Bound the activity log. Returns what it removed so the caller can record an
// accurate audit trail rather than an assumed one.
export function pruneActivity(
  policy: ActivityRetentionPolicy = ACTIVITY_RETENTION,
  db: PruneDb = getDb() as unknown as PruneDb,
  now: number = Date.now()
): ActivityPruneResult {
  // 1 — Count cap on the noisy kind, PARTITIONED BY ORG.
  //
  // Per-organisation and not table-wide, because reads are per-organisation:
  // `getRecentActivity()` filters `WHERE org_id = ?`. Under a table-wide cap a
  // busy tenant evicts a quiet tenant's entire feed, since the quiet tenant's
  // rows are globally old even when they are the only rows it has. Partitioning
  // caps each tenant against itself (PLX-SEC-010/011).
  //
  // `ts DESC, id DESC` — the tie-break is load-bearing, not decoration. The
  // burst above wrote thousands of rows onto identical millisecond timestamps,
  // so `ts` alone leaves the retained set to SQLite's discretion and makes the
  // boundary non-deterministic between runs.
  const navRemoved = changed(
    db
      .prepare(
        `DELETE FROM activity_log
          WHERE kind = ?
            AND id NOT IN (
              SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                         PARTITION BY org_id ORDER BY ts DESC, id DESC
                       ) AS rn
                  FROM activity_log WHERE kind = ?
              ) WHERE rn <= ?
            )`
      )
      .run(NAV_KIND, NAV_KIND, policy.navKeep)
  )

  // 2 — Age ceiling across every kind. Age needs no partition: a cutoff is
  // tenant-neutral by construction, so no organisation's volume can age out
  // another's rows.
  const agedRemoved = changed(
    db.prepare(`DELETE FROM activity_log WHERE ts < ?`).run(now - policy.maxAgeDays * 86_400_000)
  )

  return { navRemoved, agedRemoved, removed: navRemoved + agedRemoved }
}
