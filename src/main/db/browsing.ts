import { getDb } from './database'
import type { PruneDb } from './activity'
import { getActiveOrgId } from './activeOrg'
import type { BrowsingHistoryEntry } from '@shared/types'

interface HistoryRow {
  url: string
  title: string
  host: string
  task_id: string | null
  first_visited_at: number
  last_visited_at: number
  visit_count: number
}

function rowToEntry(row: HistoryRow): BrowsingHistoryEntry {
  return {
    url: row.url,
    title: row.title,
    host: row.host,
    taskId: row.task_id,
    firstVisitedAt: row.first_visited_at,
    lastVisitedAt: row.last_visited_at,
    visitCount: row.visit_count
  }
}

function safeHostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// Skip non-http(s) and obvious junk so the history stays useful.
function isRecordableUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  if (/^chrome-error:|^about:|^data:/i.test(url)) return false
  return true
}

/**
 * DEC-061 — record a page visit.
 *
 * `countsAsVisit` separates "this is a new visit" from "here is better metadata
 * about the page you are already on", and the two genuinely differ. The browser
 * core funnels four webview events into one nav callback, so one page load
 * arrives several times, each pass carrying a more mature `getTitle()` — the
 * first often the raw URL, the last the real title. The upsert below is built
 * for exactly that: it takes the better title each time it sees one. Only 35 of
 * 814 rows on the operator's machine still held a URL-ish title, so the
 * mechanism works and must be preserved.
 *
 * What could not be preserved was counting every one of those passes as a
 * visit. Ungated, one Slack channel reached 14,096 "visits" — a number that is
 * user-visible (the NewNodeDialog badge) and rendered into LLM prompts, so it
 * was not merely untidy, it was telling the model something false.
 *
 * Hence the split rather than a gate on the whole call: gating the call would
 * have frozen every title at the first event's value, which is the raw URL.
 * Recency updates too — you ARE still on the page, and last_visited_at is about
 * where you are, not how many times you arrived.
 */
export function recordVisit(
  url: string,
  title: string,
  taskId: string | null,
  countsAsVisit = true
): void {
  if (!isRecordableUrl(url)) return
  const db = getDb()
  const now = Date.now()
  const host = safeHostOf(url)
  const cleanTitle = (title || '').trim()
  db.prepare(
    `INSERT INTO browsing_history (url, title, host, task_id, first_visited_at, last_visited_at, visit_count, org_id)
     VALUES (@url, @title, @host, @taskId, @now, @now, 1, @orgId)
     ON CONFLICT(url) DO UPDATE SET
       title = CASE WHEN excluded.title != '' THEN excluded.title ELSE browsing_history.title END,
       last_visited_at = excluded.last_visited_at,
       visit_count = browsing_history.visit_count + @increment,
       task_id = COALESCE(excluded.task_id, browsing_history.task_id),
       org_id = excluded.org_id`
  ).run({
    url,
    title: cleanTitle,
    host,
    taskId,
    now,
    // A first sighting always counts as one, even when the gate is closed:
    // otherwise a brand-new row would land at zero visits and read as never
    // visited by the very code that just recorded visiting it.
    increment: countsAsVisit ? 1 : 0,
    orgId: getActiveOrgId()
  })
}

export function getRecentHistory(limit = 12, taskId?: string | null): BrowsingHistoryEntry[] {
  const db = getDb()
  // If a taskId is supplied, prioritize that task's history first, then fill from global.
  if (taskId) {
    const taskRows = db
      .prepare(
        `SELECT * FROM browsing_history WHERE task_id = ?
         ORDER BY last_visited_at DESC LIMIT ?`
      )
      .all(taskId, limit) as HistoryRow[]
    const taskUrls = new Set(taskRows.map((r) => r.url))
    const remaining = limit - taskRows.length
    let globalRows: HistoryRow[] = []
    if (remaining > 0) {
      globalRows = db
        .prepare(
          `SELECT * FROM browsing_history WHERE task_id IS NULL OR task_id != ?
           ORDER BY visit_count DESC, last_visited_at DESC LIMIT ?`
        )
        .all(taskId, remaining * 2) as HistoryRow[]
      globalRows = globalRows.filter((r) => !taskUrls.has(r.url)).slice(0, remaining)
    }
    return [...taskRows, ...globalRows].map(rowToEntry)
  }
  const rows = db
    .prepare(
      `SELECT * FROM browsing_history WHERE org_id = ?
       ORDER BY visit_count DESC, last_visited_at DESC LIMIT ?`
    )
    .all(getActiveOrgId(), limit) as HistoryRow[]
  return rows.map(rowToEntry)
}

// ── Retention (DEC-057) ──────────────────────────────────────────────────────
// Bound the history table to its most recent entries per organisation. Like
// `pruneActivity()`, this cap was declared and then never called from anywhere
// (see db/retention.ts); unlike it, the table it guards is genuinely small —
// 814 rows / 0.27 MB live, against a declared cap of 500. Wiring it is about
// closing the last uncalled cap rather than reclaiming space.
//
// `url` is this table's PRIMARY KEY, so selecting on it is selecting on the
// row identity — there is no separate `id` column to prefer.
//
// The change from the original: PARTITION BY org_id. Reads here are scoped
// `WHERE org_id = ?` (see `getTopHistory` above), so a table-wide cap lets one
// organisation's browsing evict another's entirely (PLX-SEC-010/011). The
// `last_visited_at DESC, url DESC` tie-break keeps the retained set stable
// across runs when timestamps collide.
export const HISTORY_KEEP = 500

export function pruneHistory(keep: number = HISTORY_KEEP, db: PruneDb = getDb() as unknown as PruneDb): number {
  const info = db
    .prepare(
      `DELETE FROM browsing_history
        WHERE url NOT IN (
          SELECT url FROM (
            SELECT url, ROW_NUMBER() OVER (
                     PARTITION BY org_id ORDER BY last_visited_at DESC, url DESC
                   ) AS rn
              FROM browsing_history
          ) WHERE rn <= ?
        )`
    )
    .run(keep)
  return Number((info as { changes?: number } | undefined)?.changes ?? 0)
}
