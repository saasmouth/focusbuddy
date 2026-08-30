// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { repairBrowsingHistoryCounts, type HistoryRepairDb } from '../../src/main/db/migrateBrowsingHistoryCounts'

// DEC-061 — the repair must be exact where it acts and silent where it cannot.
// A partial log can only produce a WORSE number than the one already stored, so
// refusing is the correct outcome rather than a shortfall.

function db(): DatabaseSync & HistoryRepairDb {
  const d = new DatabaseSync(':memory:')
  d.exec(`
    CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, payload TEXT);
    CREATE TABLE browsing_history (url TEXT PRIMARY KEY, visit_count INTEGER);
  `)
  return d as never
}
const nav = (d: DatabaseSync, ts: number, url: string, widgetId = 'w1'): void => {
  d.prepare(`INSERT INTO activity_log (ts, kind, payload) VALUES (?, 'browser_nav', ?)`)
    .run(ts, JSON.stringify({ url, widgetId }))
}
const hist = (d: DatabaseSync, url: string, n: number): void => {
  d.prepare(`INSERT INTO browsing_history (url, visit_count) VALUES (?, ?)`).run(url, n)
}
const count = (d: DatabaseSync, url: string): number =>
  (d.prepare(`SELECT visit_count c FROM browsing_history WHERE url = ?`).get(url) as { c: number }).c

const T0 = 1_750_000_000_000

describe('dec_061 — the burst collapses to the truth', () => {
  it('dec_061_a_reload_burst_becomes_one_visit', () => {
    const d = db()
    // The real shape: the same URL re-recorded every 20s by the sync tick.
    for (let i = 0; i < 200; i++) nav(d, T0 + i * 20_000, 'https://slack.com/x')
    hist(d, 'https://slack.com/x', 200) // stored count equals the raw log count
    const r = repairBrowsingHistoryCounts(d)
    expect(r.repaired).toBe(1)
    // 200 rows span 66 minutes, so the 30-minute stationary window admits ~3.
    expect(count(d, 'https://slack.com/x')).toBeLessThanOrEqual(4)
    expect(count(d, 'https://slack.com/x')).toBeGreaterThan(0)
    expect(r.visitsRemoved).toBeGreaterThan(190)
  })

  it('dec_061_genuine_separate_visits_are_preserved', () => {
    // Four visits, hours apart. Nothing here is noise and nothing may be lost.
    const d = db()
    for (let i = 0; i < 4; i++) nav(d, T0 + i * 3 * 3_600_000, 'https://docs.example/a')
    hist(d, 'https://docs.example/a', 4)
    repairBrowsingHistoryCounts(d)
    expect(count(d, 'https://docs.example/a')).toBe(4)
  })
})

describe('dec_061 — the guard', () => {
  it('dec_061_a_pruned_log_leaves_the_row_untouched', () => {
    // THE case that matters here: retention already capped the log, so the
    // evidence is partial. Repairing from it would invent a smaller, wronger
    // number and destroy the real one.
    const d = db()
    for (let i = 0; i < 5; i++) nav(d, T0 + i * 20_000, 'https://slack.com/x') // only 5 survive
    hist(d, 'https://slack.com/x', 14096) // the real, inflated count
    const r = repairBrowsingHistoryCounts(d)
    expect(r.repaired).toBe(0)
    expect(r.skippedNoEvidence).toBe(1)
    expect(count(d, 'https://slack.com/x')).toBe(14096) // untouched
  })

  it('dec_061_a_row_with_no_log_at_all_is_untouched', () => {
    const d = db()
    hist(d, 'https://old.example/', 7)
    const r = repairBrowsingHistoryCounts(d)
    expect(r.skippedNoEvidence).toBe(1)
    expect(count(d, 'https://old.example/')).toBe(7)
  })

  it('dec_061_running_twice_changes_nothing_the_second_time', () => {
    const d = db()
    for (let i = 0; i < 200; i++) nav(d, T0 + i * 20_000, 'https://slack.com/x')
    hist(d, 'https://slack.com/x', 200)
    repairBrowsingHistoryCounts(d)
    const after = count(d, 'https://slack.com/x')
    const second = repairBrowsingHistoryCounts(d)
    expect(second.repaired).toBe(0)
    expect(count(d, 'https://slack.com/x')).toBe(after)
  })

  it('dec_061_an_empty_log_is_a_no_op_not_a_wipe', () => {
    const d = db()
    hist(d, 'https://a/', 3)
    const r = repairBrowsingHistoryCounts(d)
    // Reported as skipped, not as nothing-to-do: the row WAS considered and
    // deliberately left alone, and the summary should say so.
    expect(r).toEqual({ repaired: 0, skippedNoEvidence: 1, alreadyCorrect: 0, visitsRemoved: 0 })
    expect(count(d, 'https://a/')).toBe(3)
  })
})

describe('dec_061 — evidence may come from a different database', () => {
  it('dec_061_repairs_one_db_from_anothers_log', () => {
    // How the operator's machine had to be repaired: the live log was already
    // capped by retention, and the intact evidence survived only in a backup.
    const live = db()
    const backup = db()
    for (let i = 0; i < 200; i++) nav(backup, T0 + i * 20_000, 'https://slack.com/x')
    hist(live, 'https://slack.com/x', 200)
    const r = repairBrowsingHistoryCounts(live, backup)
    expect(r.repaired).toBe(1)
    expect(count(live, 'https://slack.com/x')).toBeLessThanOrEqual(4)
  })
})
