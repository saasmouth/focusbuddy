// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  pruneActivity,
  ACTIVITY_RETENTION,
  NAV_KIND,
  type PruneDb,
  type ActivityRetentionPolicy
} from '../../src/main/db/activity'
import { pruneHistory, HISTORY_KEEP } from '../../src/main/db/browsing'
import { retentionAllows, assertRetentionTarget } from '../../src/main/privacy/erasure'

// DEC-057 — `activity_log` and `browsing_history` retention.
//
// These tables were capped in name only: `pruneActivity()` and `pruneHistory()`
// existed with declared caps of 5,000 and 500 and had zero call sites, so the
// live table reached 52,208 rows / 15.79 MB against its own 5,000. Wiring them
// into `runRetentionSweep()` is what these tests pin — together with the two
// properties the naive caps got wrong, which are the ones that would silently
// regress: per-kind separation and per-organisation scoping.
//
// Production runs better-sqlite3 (Electron ABI, unloadable in the test runner),
// so the same SQL is driven through Node's built-in node:sqlite via a thin
// adapter satisfying the `PruneDb` surface — the reason those functions take an
// injectable handle at all.
function db(): { raw: DatabaseSync; sql: PruneDb } {
  const d = new DatabaseSync(':memory:')
  // Mirrors the production schema (db/database.ts) for the columns retention
  // touches, including `org_id`, whose absence from the original caps is the
  // bug these tests exist to prevent coming back.
  d.exec(`
    CREATE TABLE activity_log (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT,
      org_id TEXT NOT NULL DEFAULT 'personal'
    );
    CREATE TABLE browsing_history (
      url TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      host TEXT NOT NULL DEFAULT '',
      task_id TEXT,
      first_visited_at INTEGER NOT NULL,
      last_visited_at INTEGER NOT NULL,
      visit_count INTEGER NOT NULL DEFAULT 1,
      org_id TEXT NOT NULL DEFAULT 'personal'
    );
  `)
  const sql: PruneDb = {
    prepare: (q: string) => {
      const s = d.prepare(q)
      return {
        run: (...a: (string | number)[]) => s.run(...(a as never[])),
        get: (...a: (string | number)[]) => s.get(...(a as never[]))
      }
    }
  }
  return { raw: d, sql }
}

const DAY = 86_400_000
const NOW = 1_800_000_000_000 // fixed clock: retention is age-sensitive

function addActivity(
  d: DatabaseSync,
  rows: { id: string; ts: number; kind: string; org?: string }[]
): void {
  const st = d.prepare(
    'INSERT INTO activity_log (id, task_id, ts, kind, payload, org_id) VALUES (?, NULL, ?, ?, NULL, ?)'
  )
  for (const r of rows) st.run(r.id, r.ts, r.kind, r.org ?? 'personal')
}

const count = (d: DatabaseSync, sql: string): number =>
  Number((d.prepare(sql).get() as { n: number }).n)

const idsOf = (d: DatabaseSync, sql: string): string[] =>
  (d.prepare(sql).all() as { id: string }[]).map((r) => r.id)

describe('dec_057 — activity_log retention separates telemetry from history', () => {
  it('dec_057_caps_browser_nav_by_count_and_spares_every_other_kind', () => {
    const { raw, sql } = db()
    // The live shape in miniature: browser_nav dwarfs the kinds a person would
    // recognise in the feed (96% of the real table), and the meaningful rows are
    // the OLDER ones — exactly what a table-wide keep-newest cap would evict.
    addActivity(
      raw,
      Array.from({ length: 50 }, (_, i) => ({
        id: `nav-${String(i).padStart(3, '0')}`,
        ts: NOW - i * 1000,
        kind: NAV_KIND
      }))
    )
    addActivity(raw, [
      { id: 'real-1', ts: NOW - 40 * DAY, kind: 'task_switched' },
      { id: 'real-2', ts: NOW - 50 * DAY, kind: 'chat_sent' },
      { id: 'real-3', ts: NOW - 60 * DAY, kind: 'widget_added' }
    ])

    const r = pruneActivity({ navKeep: 10, maxAgeDays: 90 }, sql, NOW)

    // The noisy kind is capped...
    expect(r.navRemoved).toBe(40)
    expect(count(raw, `SELECT COUNT(*) AS n FROM activity_log WHERE kind = '${NAV_KIND}'`)).toBe(10)
    // ...and it kept the NEWEST ten, not an arbitrary ten.
    expect(idsOf(raw, `SELECT id FROM activity_log WHERE kind = '${NAV_KIND}' ORDER BY id`)).toEqual(
      Array.from({ length: 10 }, (_, i) => `nav-${String(i).padStart(3, '0')}`)
    )

    // This is the assertion that matters: every meaningful row survives, even
    // though all three are older than all 50 navigation rows. Under the original
    // table-wide keep-newest-N they would have been the first rows deleted.
    expect(r.agedRemoved).toBe(0)
    expect(idsOf(raw, "SELECT id FROM activity_log WHERE kind <> 'browser_nav' ORDER BY id")).toEqual([
      'real-1',
      'real-2',
      'real-3'
    ])
  })

  it('dec_057_count_cap_is_per_organisation_so_a_busy_org_cannot_evict_a_quiet_one', () => {
    const { raw, sql } = db()
    // Reads are org-scoped (`getRecentActivity` filters WHERE org_id = ?), so a
    // table-wide cap lets one tenant delete another's entire feed: the quiet
    // tenant's rows are globally old even when they are all it has. Live proof
    // this is not hypothetical — the operator's DB holds a second org with
    // exactly one row, which survived only because 632 rows happened to be newer.
    addActivity(
      raw,
      Array.from({ length: 40 }, (_, i) => ({
        id: `busy-${String(i).padStart(3, '0')}`,
        ts: NOW - i * 1000,
        kind: NAV_KIND,
        org: 'org-busy'
      }))
    )
    // Older than every single one of the busy org's rows.
    addActivity(raw, [
      { id: 'quiet-1', ts: NOW - 10 * DAY, kind: NAV_KIND, org: 'org-quiet' },
      { id: 'quiet-2', ts: NOW - 11 * DAY, kind: NAV_KIND, org: 'org-quiet' }
    ])

    pruneActivity({ navKeep: 5, maxAgeDays: 90 }, sql, NOW)

    // The busy org is capped against itself...
    expect(count(raw, "SELECT COUNT(*) AS n FROM activity_log WHERE org_id = 'org-busy'")).toBe(5)
    // ...and the quiet org keeps everything, because 2 < 5 within its own partition.
    expect(idsOf(raw, "SELECT id FROM activity_log WHERE org_id = 'org-quiet' ORDER BY id")).toEqual([
      'quiet-1',
      'quiet-2'
    ])
  })

  it('dec_057_age_ceiling_applies_to_every_kind_including_browser_nav', () => {
    const { raw, sql } = db()
    addActivity(raw, [
      { id: 'fresh-nav', ts: NOW - 10 * DAY, kind: NAV_KIND },
      { id: 'stale-nav', ts: NOW - 200 * DAY, kind: NAV_KIND },
      { id: 'fresh-task', ts: NOW - 10 * DAY, kind: 'task_switched' },
      { id: 'stale-task', ts: NOW - 200 * DAY, kind: 'task_switched' },
      { id: 'edge', ts: NOW - 90 * DAY, kind: 'chat_sent' } // exactly at the cutoff
    ])

    const r = pruneActivity({ navKeep: 10_000, maxAgeDays: 90 }, sql, NOW)

    // Nothing hit the count cap, so everything removed was removed by age.
    expect(r.navRemoved).toBe(0)
    expect(r.agedRemoved).toBe(2)
    // The boundary is `ts < cutoff`, so a row exactly at the ceiling is kept.
    expect(idsOf(raw, 'SELECT id FROM activity_log ORDER BY id')).toEqual([
      'edge',
      'fresh-nav',
      'fresh-task'
    ])
  })

  it('dec_057_retained_set_is_deterministic_when_timestamps_collide', () => {
    // Not decoration: the 39,762-row burst that motivated this policy wrote
    // thousands of rows onto identical millisecond timestamps. Ordering by `ts`
    // alone leaves the boundary to SQLite's discretion, so the cap would retain
    // a different set run to run. `ts DESC, id DESC` pins it.
    const run = (): string[] => {
      const { raw, sql } = db()
      addActivity(
        raw,
        Array.from({ length: 20 }, (_, i) => ({
          id: `tie-${String(i).padStart(2, '0')}`,
          ts: NOW, // every row identical
          kind: NAV_KIND
        }))
      )
      pruneActivity({ navKeep: 5, maxAgeDays: 90 }, sql, NOW)
      return idsOf(raw, 'SELECT id FROM activity_log ORDER BY id')
    }
    // Highest ids win the `id DESC` tie-break, and do so repeatably.
    const expected = ['tie-15', 'tie-16', 'tie-17', 'tie-18', 'tie-19']
    expect(run()).toEqual(expected)
    expect(run()).toEqual(expected)
  })

  it('dec_057_prune_is_a_noop_when_under_both_bounds', () => {
    const { raw, sql } = db()
    addActivity(raw, [
      { id: 'a', ts: NOW - DAY, kind: NAV_KIND },
      { id: 'b', ts: NOW - DAY, kind: 'chat_sent' }
    ])
    expect(pruneActivity(ACTIVITY_RETENTION, sql, NOW)).toEqual({
      navRemoved: 0,
      agedRemoved: 0,
      removed: 0
    })
    expect(count(raw, 'SELECT COUNT(*) AS n FROM activity_log')).toBe(2)
  })

  it('dec_057_shipped_policy_keeps_the_feed_usable', () => {
    // Guards the numbers Ryan actually approved, so a later tweak is a decision
    // rather than a drift: 2,000 navigation rows per org, 90-day ceiling.
    const p: ActivityRetentionPolicy = ACTIVITY_RETENTION
    expect(p).toEqual({ navKeep: 2_000, maxAgeDays: 90 })
  })
})

describe('dec_057 — browsing_history retention', () => {
  it('dec_057_history_cap_is_per_organisation', () => {
    const { raw, sql } = db()
    const st = raw.prepare(
      'INSERT INTO browsing_history (url, first_visited_at, last_visited_at, org_id) VALUES (?, ?, ?, ?)'
    )
    for (let i = 0; i < 12; i++) st.run(`https://busy.example/${i}`, NOW, NOW - i * 1000, 'org-busy')
    // Older than every busy-org entry — table-wide, these are the first to go.
    st.run('https://quiet.example/a', NOW, NOW - 30 * DAY, 'org-quiet')

    const removed = pruneHistory(4, sql)

    expect(removed).toBe(8)
    expect(count(raw, "SELECT COUNT(*) AS n FROM browsing_history WHERE org_id = 'org-busy'")).toBe(4)
    expect(count(raw, "SELECT COUNT(*) AS n FROM browsing_history WHERE org_id = 'org-quiet'")).toBe(1)
  })

  it('dec_057_history_default_cap_matches_the_declared_one', () => {
    expect(HISTORY_KEEP).toBe(500)
  })
})

describe('dec_057 — the sweep still cannot reach the Event log', () => {
  it('dec_057_every_swept_target_is_retention_allowed_and_events_is_not', () => {
    // Both new targets pass the PLX-DATA-012 guard, and the guard is still the
    // thing standing between this sweep and history that PLX-EVT-030/031
    // promise is permanent. If a future edit adds a protected target to
    // `runRetentionSweep()`, this is where it fails loudly.
    for (const t of ['activity_log', 'browsing_history', 'event_outbox']) {
      expect(retentionAllows(t)).toBe(true)
      expect(() => assertRetentionTarget(t)).not.toThrow()
    }
    for (const t of ['events', 'event', 'decision.alternatives', 'alternatives']) {
      expect(retentionAllows(t)).toBe(false)
      expect(() => assertRetentionTarget(t)).toThrow(/MUST NOT prune/)
    }
  })
})
