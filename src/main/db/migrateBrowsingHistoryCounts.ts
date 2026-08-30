// DEC-061 — repair browsing_history.visit_count.
//
// The counts are wrong in the same way, and from the same handler, as the
// activity-log burst DEC-058 fixed. `BrowserSurface` funnels four webview
// events into one nav callback and the 20-second sync tick reloaded the webview
// underneath it, so `history.record` fired repeatedly for a page nobody had
// navigated. One Slack channel reached 14,096 "visits".
//
// That number is not merely untidy. It is user-visible (the NewNodeDialog
// badge) and it is rendered into LLM prompts as `[14096x]`, so the corruption
// was actively telling the model something false about what the user cares
// about.
//
// ── Why this repair is exact, not an estimate ────────────────────────────────
// Both writes — the activity_log row and the visit_count increment — came from
// that same handler, on the same events. So the log IS the provenance of the
// count. Verified on the operator's machine before repairing: across 814
// history rows, 763 had a browser_nav row count EQUAL to the stored
// visit_count and ZERO disagreed (14,096 = 14,096; 10,064 = 10,064;
// 6,664 = 6,664). The remaining 51 simply predate the log.
//
// So replaying the log through the real DEC-058 gate — the same
// `createNavTrailGate` the live path uses, never a reimplementation of it —
// yields the count that WOULD have been recorded had the gate existed. That is
// a reconstruction, not a guess.
//
// ── The guard ───────────────────────────────────────────────────────────────
// A row is only touched when its raw log count equals its stored visit_count.
// That equality is what proves the log is complete for that URL and that the
// stored number came from it. Where the log has been pruned, or the row
// predates it, the numbers differ and the row is left exactly as it is —
// a partial log can only produce a WORSE number, so refusing is the correct
// outcome, not a limitation.
//
// The guard doubles as idempotency: after a repair the stored count is the
// corrected (smaller) one, so it no longer equals the raw log count and a
// second run declines.
//
// Electron-free, same as the other migrations: production hands it
// better-sqlite3, tests hand it node:sqlite.

import { createNavTrailGate } from '@shared/navTrail'

export interface HistoryRepairDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
}

export interface HistoryRepairResult {
  repaired: number
  /** Rows left alone because the evidence could not vouch for them. */
  skippedNoEvidence: number
  /** Rows whose stored count already matched the reconstruction. */
  alreadyCorrect: number
  /** Total inflation removed, for the log line. */
  visitsRemoved: number
}

interface NavRow {
  ts: number
  payload: string
}

/**
 * Reconstruct the true visit counts.
 *
 * @param db        the database whose browsing_history is repaired
 * @param evidenceDb where the browser_nav log lives. Defaults to `db` — the
 *   shipping case. It is a parameter because on the machine that found this
 *   bug the retention sweep had already capped the log, and the intact
 *   evidence survived only in a pre-sweep backup. Reading evidence from one
 *   database and repairing another is the honest way to express that, rather
 *   than pretending the live log is still complete.
 */
export function repairBrowsingHistoryCounts(
  db: HistoryRepairDb,
  evidenceDb: HistoryRepairDb = db
): HistoryRepairResult {
  const result: HistoryRepairResult = {
    repaired: 0,
    skippedNoEvidence: 0,
    alreadyCorrect: 0,
    visitsRemoved: 0
  }

  // Chronological order is required: the gate answers on elapsed time, so
  // replaying out of order would ask the wrong question of every row.
  const rows = evidenceDb
    .prepare(`SELECT ts, payload FROM activity_log WHERE kind = 'browser_nav' ORDER BY ts ASC, id ASC`)
    .all() as NavRow[]
  // Deliberately no early return on an empty log: the history rows are still
  // walked below so they are counted as skipped. A report of "skipped: 0" while
  // 500 rows were left untouched would be a false all-clear.

  const gate = createNavTrailGate()
  const raw = new Map<string, number>()
  const corrected = new Map<string, number>()

  for (const row of rows) {
    let url: string | undefined
    let widgetId: string | undefined
    try {
      const p = JSON.parse(row.payload) as { url?: string; widgetId?: string }
      url = p.url
      widgetId = p.widgetId
    } catch {
      continue // an unparseable row is evidence of nothing
    }
    if (!url) continue
    raw.set(url, (raw.get(url) ?? 0) + 1)
    // A row with no widgetId still belongs to a surface; key it by URL so it
    // is judged against its own history rather than sharing a bucket with
    // every other unattributed row.
    if (gate.admit({ widgetId: widgetId ?? `url:${url}`, url }, row.ts)) {
      corrected.set(url, (corrected.get(url) ?? 0) + 1)
    }
  }

  const history = db
    .prepare(`SELECT url, visit_count FROM browsing_history`)
    .all() as { url: string; visit_count: number }[]
  const update = db.prepare(`UPDATE browsing_history SET visit_count = ? WHERE url = ?`)

  for (const h of history) {
    const rawCount = raw.get(h.url)
    // No evidence, or evidence that cannot account for the stored number.
    if (rawCount === undefined || rawCount !== h.visit_count) {
      result.skippedNoEvidence++
      continue
    }
    const trueCount = corrected.get(h.url) ?? 0
    if (trueCount === h.visit_count) {
      result.alreadyCorrect++
      continue
    }
    update.run(trueCount, h.url)
    result.repaired++
    result.visitsRemoved += h.visit_count - trueCount
  }

  return result
}
