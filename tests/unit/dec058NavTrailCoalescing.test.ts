// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  createNavTrailGate,
  navTrailGate,
  NAV_TRAIL_POLICY,
  type NavTrailPolicy
} from '../../src/shared/navTrail'
import { recordActivity, admitsNavRow, NAV_KIND, type ActivityWriteDb } from '../../src/main/db/activity'

// DEC-058 — the cause DEC-057 was capping.
//
// DEC-057 bounded `activity_log` after the fact; it did not stop the thing
// filling it. The live database showed 39,762 `browser_nav` rows written in one
// ~19-hour window (~35/minute, 76% of the whole table) carrying FIFTEEN
// distinct URLs between them — four widgets, one URL each. Nobody navigated.
//
// Two multipliers, both reproduced below:
//   1. `BrowserSurface` funnels did-navigate / did-navigate-in-page /
//      did-finish-load / did-redirect-navigation into one handler, so a cold
//      load reaches the recording site three times (measured at +0ms, +329ms,
//      +1407ms, each with a different `getTitle()`).
//   2. `SYNC_INTERVAL_MS = 20_000` reloads every mounted webview — the burst's
//      cycles are 20.0s apart and its four widgets fire within 3ms of one
//      another, which four independent pages do not do by coincidence.
//
// These tests pin the guard AND the two properties that would silently regress
// it: that a real navigation is never delayed or dropped, and that a widget
// remount does not reset the trail (the sync refresh remounts browser widgets,
// so a per-mount gate would be cleared by the very thing it absorbs).

const START = 1_782_772_980_000 // the real burst's first row, to the second

// One page load as the recording site actually sees it: three events, same URL,
// spread over the commit → load → hydrate sequence measured in the live data.
const LOAD_OFFSETS = [0, 329, 1_407]

// The four widgets that produced 39,704 of the 39,762 rows, one URL each.
const BURST = [
  { widgetId: '0c88c9f0', url: 'https://app.slack.com/client/T0B7BHYCJFN/C0B828EU87J' },
  { widgetId: '5f4a74dc', url: 'https://app.notion.com/p/Plexi-Inc-Atlas-Application-Review' },
  { widgetId: '9cbb8fc1', url: 'https://claude.ai/chat/a35f2986-56b2-4208-80eb-cf16de146e05' },
  { widgetId: 'ae1d0528', url: 'https://dashboard.stripe.com/acct_1TlslVPg0PzMaHDK/atlas/app/sign' }
]

const SYNC_RELOAD_MS = 20_000 // workspaceSync.ts SYNC_INTERVAL_MS
const BURST_HOURS = 19
const CYCLES = (BURST_HOURS * 3_600_000) / SYNC_RELOAD_MS // 3,420 reloads

describe('dec_058 — the navigation trail coalesces what the recording site duplicates', () => {
  it('dec_058_replaying_the_real_burst_collapses_it_by_three_orders_of_magnitude', () => {
    const gate = createNavTrailGate()
    let offered = 0
    let admitted = 0

    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const loadedAt = START + cycle * SYNC_RELOAD_MS
      for (const offset of LOAD_OFFSETS) {
        for (const widget of BURST) {
          offered++
          if (gate.admit(widget, loadedAt + offset)) admitted++
        }
      }
    }

    // The shape of the real incident: ~41k events, ~35/minute sustained.
    expect(offered).toBe(41_040)
    expect(offered / (BURST_HOURS * 60)).toBeCloseTo(36, 0)

    // Every reload kept the widget on the page it was already on, so the whole
    // burst reduces to each widget re-affirming its page every 30 minutes:
    // 19h / 30min = 38 rows per widget, 152 in total, against 39,762 written.
    expect(admitted).toBe(152)
    expect(admitted / offered).toBeLessThan(0.004)
  })

  it('dec_058_one_page_load_is_one_row_however_many_webview_events_it_fires', () => {
    // The narrowest statement of multiplier #1, isolated from the reload loop:
    // three events, three different titles, one navigation, one row.
    const gate = createNavTrailGate()
    const url = 'https://claude.ai/chat/a35f2986'
    const admitted = LOAD_OFFSETS.filter((offset) =>
      gate.admit({ widgetId: 'w1', url }, START + offset)
    )
    expect(admitted).toEqual([0])
  })

  it('dec_058_a_real_navigation_is_admitted_immediately_and_never_debounced', () => {
    // The property that makes this a dedupe and not a debounce: a URL the
    // widget has not been on is recorded on the spot. A person clicking through
    // four pages in four seconds gets four rows, at the moment of each click —
    // no timer between the click and the trail.
    const gate = createNavTrailGate()
    const clicks = ['/inbox', '/inbox/thread-1', '/settings', '/settings/billing']
    const rows = clicks.filter((path, i) =>
      gate.admit({ widgetId: 'w1', url: `https://example.test${path}` }, START + i * 1_000)
    )
    expect(rows).toEqual(clicks)
  })

  it('dec_058_a_redirect_loop_is_bounded_even_though_every_hop_changes_the_url', () => {
    // The failure this burst was NOT, but that the same code path permits: a
    // page cycling A → B → A → B changes URL on every hop, so the stationary
    // window never sees a repeat and each hop reads as real navigation. The
    // revisit window is what bounds it — without it this loop is unbounded.
    const gate = createNavTrailGate()
    const a = 'https://example.test/app'
    const b = 'https://example.test/signin'
    let admitted = 0
    // Two hops a second for ten minutes: 1,200 navigation events.
    for (let i = 0; i < 1_200; i++) {
      if (gate.admit({ widgetId: 'w1', url: i % 2 === 0 ? a : b }, START + i * 500)) admitted++
    }
    // Ten minutes, two URLs, one row per URL per minute: 20 rows from 1,200
    // events. Without the revisit window every one of the 1,200 is a row.
    expect(admitted).toBe(20)
  })

  it('dec_058_a_widget_remount_does_not_reset_the_trail', () => {
    // Load-bearing, and the easiest thing to break by "tidying up": the sync
    // refresh that caused the burst remounts browser widgets, so a gate cleared
    // on unmount would be cleared 3 times a minute by the exact event it
    // exists to absorb. The gate is keyed by widget id and outlives the mount.
    const gate = createNavTrailGate()
    const nav = { widgetId: 'w1', url: 'https://app.slack.com/client/T0/C0' }
    expect(gate.admit(nav, START)).toBe(true)
    // …widget unmounts and remounts, twice, as the sync tick refreshes it…
    expect(gate.admit(nav, START + SYNC_RELOAD_MS)).toBe(false)
    expect(gate.admit(nav, START + SYNC_RELOAD_MS * 2)).toBe(false)
    // An explicit forget is the only thing that clears it.
    gate.forget('w1')
    expect(gate.admit(nav, START + SYNC_RELOAD_MS * 3)).toBe(true)
  })

  it('dec_058_returning_to_a_page_you_actually_left_is_recorded', () => {
    // The stationary window only ever suppresses the page a widget is already
    // on. Leave it and come back and that is genuine navigation, recorded even
    // though the URL is a repeat — provided the revisit window has passed.
    const gate = createNavTrailGate()
    const w = 'w1'
    const a = 'https://example.test/a'
    const b = 'https://example.test/b'
    expect(gate.admit({ widgetId: w, url: a }, START)).toBe(true)
    expect(gate.admit({ widgetId: w, url: b }, START + 1_000)).toBe(true)
    // Straight back within the revisit window — already in the trail, no row.
    expect(gate.admit({ widgetId: w, url: a }, START + 2_000)).toBe(false)
    // Back an hour later — a real return to a page you left.
    expect(gate.admit({ widgetId: w, url: a }, START + 3_600_000)).toBe(true)
  })

  it('dec_058_trails_are_per_widget_and_never_shared', () => {
    // Two widgets showing the same page is two facts, not one. The burst's four
    // widgets each held a different URL, but pinned Connected Apps routinely
    // duplicate one.
    const gate = createNavTrailGate()
    const url = 'https://app.slack.com/client/T0/C0'
    expect(gate.admit({ widgetId: 'w1', url }, START)).toBe(true)
    expect(gate.admit({ widgetId: 'w2', url }, START)).toBe(true)
    expect(gate.admit({ widgetId: 'w1', url }, START + 10)).toBe(false)
  })

  it('dec_058_memory_is_bounded_in_both_dimensions', () => {
    // No lifecycle hook keeps this map honest, so the LRUs have to. Per widget
    // the trail remembers `recentUrls`; across widgets it remembers
    // `trackedWidgets`. Eviction is observable only as a re-admitted row, which
    // is the safe direction to fail.
    const policy: NavTrailPolicy = { ...NAV_TRAIL_POLICY, recentUrls: 3, trackedWidgets: 2 }
    const gate = createNavTrailGate(policy)

    // Per-widget: four URLs into a three-deep trail evicts the first.
    for (let i = 0; i < 4; i++) gate.admit({ widgetId: 'w1', url: `u${i}` }, START + i)
    expect(gate.admit({ widgetId: 'w1', url: 'u0' }, START + 10)).toBe(true) // evicted
    expect(gate.admit({ widgetId: 'w1', url: 'u3' }, START + 11)).toBe(false) // retained

    // Across widgets: a third widget evicts the least recently used.
    const g2 = createNavTrailGate(policy)
    g2.admit({ widgetId: 'a', url: 'u' }, START)
    g2.admit({ widgetId: 'b', url: 'u' }, START + 1)
    g2.admit({ widgetId: 'c', url: 'u' }, START + 2)
    expect(g2.admit({ widgetId: 'a', url: 'u' }, START + 3)).toBe(true) // 'a' evicted
    expect(g2.admit({ widgetId: 'c', url: 'u' }, START + 4)).toBe(false) // 'c' retained
  })

  it('dec_058_a_backwards_clock_re_anchors_instead_of_suppressing_everything', () => {
    // Elapsed time computed from a wall clock can go negative across a DST or
    // NTP correction. Negative elapsed reads as "no time has passed", which
    // would suppress every navigation until the clock caught up — an hour of
    // silent trail after a one-hour correction.
    const gate = createNavTrailGate()
    const nav = { widgetId: 'w1', url: 'https://example.test/a' }
    expect(gate.admit(nav, START)).toBe(true)
    expect(gate.admit(nav, START - 3_600_000)).toBe(true)
  })

  it('dec_058_an_unkeyable_payload_is_recorded_rather_than_dropped', () => {
    // Failure direction matters: this gate exists to remove noise and must
    // never be the reason a navigation vanished.
    const gate = createNavTrailGate()
    expect(gate.admit({ widgetId: '', url: 'https://example.test/a' }, START)).toBe(true)
    expect(gate.admit({ widgetId: '', url: 'https://example.test/a' }, START)).toBe(true)
    expect(gate.admit({ widgetId: 'w1', url: '' }, START)).toBe(true)
  })

  it('dec_058_shipped_policy_matches_the_measurements_that_chose_it', () => {
    // Guards the numbers against drift. `stationaryMs` is 90× the 20s reload
    // cadence that caused the burst; `revisitMs` is longer than a redirect
    // cycle and shorter than a person's.
    expect(NAV_TRAIL_POLICY).toEqual({
      stationaryMs: 1_800_000,
      revisitMs: 60_000,
      recentUrls: 8,
      trackedWidgets: 64
    })
    expect(NAV_TRAIL_POLICY.stationaryMs / SYNC_RELOAD_MS).toBe(90)
  })
})

// ── The guard where the rows are actually written ───────────────────────────
// The renderer consults the same gate before it sends (WebViewWidget.tsx), so
// in practice main sees an already-thinned stream. That is an optimisation, not
// the invariant: main holds the invariant, for every caller including ones
// written after this file. Same node:sqlite harness as DEC-057 — better-sqlite3
// is built against the Electron ABI and cannot load in the test runner.
function testDb(): { raw: DatabaseSync; sql: ActivityWriteDb } {
  const d = new DatabaseSync(':memory:')
  d.exec(`
    CREATE TABLE activity_log (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT,
      org_id TEXT NOT NULL DEFAULT 'personal'
    );
  `)
  const sql: ActivityWriteDb = {
    prepare: (q: string) => {
      const s = d.prepare(q)
      return { run: (...a: (string | number | null)[]) => s.run(...(a as never[])) }
    }
  }
  return { raw: d, sql }
}

const rowCount = (d: DatabaseSync): number =>
  Number((d.prepare('SELECT COUNT(*) AS n FROM activity_log').get() as { n: number }).n)

describe('dec_058 — recordActivity is the backstop, not just the renderer', () => {
  it('dec_058_the_burst_cannot_be_written_even_by_a_caller_that_skips_the_renderer_gate', () => {
    const { raw, sql } = testDb()
    const gate = createNavTrailGate()
    let written = 0

    // One hour of the burst, straight at the main-process entry point.
    for (let cycle = 0; cycle < 3_600_000 / SYNC_RELOAD_MS; cycle++) {
      for (const offset of LOAD_OFFSETS) {
        for (const widget of BURST) {
          const ts = START + cycle * SYNC_RELOAD_MS + offset
          const ok = recordActivity(
            {
              taskId: 'desk-1',
              kind: NAV_KIND,
              payload: { url: widget.url, title: 'x', host: 'h', widgetId: widget.widgetId }
            },
            { db: sql, gate, now: ts, orgId: 'personal', id: `r-${cycle}-${offset}-${widget.widgetId}` }
          )
          if (ok) written++
        }
      }
    }

    // 2,160 offered; two rows per widget per hour survive.
    expect(written).toBe(8)
    expect(rowCount(raw)).toBe(8)
  })

  it('dec_058_every_other_kind_is_written_unconditionally', () => {
    // The gate is asked about navigation only. `task_switched`, `chat_sent` and
    // the rest are the history DEC-057 went out of its way to protect — they
    // are never machine-generated on a loop and are never coalesced, even when
    // they repeat exactly.
    const { raw, sql } = testDb()
    const gate = createNavTrailGate()
    for (let i = 0; i < 5; i++) {
      expect(
        recordActivity(
          { taskId: 'desk-1', kind: 'task_switched', payload: { to: 'desk-1' } },
          { db: sql, gate, now: START, orgId: 'personal', id: `t-${i}` }
        )
      ).toBe(true)
    }
    expect(rowCount(raw)).toBe(5)
  })

  it('dec_058_a_coalesced_call_writes_nothing_and_says_so', () => {
    const { raw, sql } = testDb()
    const gate = createNavTrailGate()
    const draft = {
      taskId: null,
      kind: NAV_KIND,
      payload: { url: 'https://example.test/a', widgetId: 'w1' }
    }
    expect(recordActivity(draft, { db: sql, gate, now: START, orgId: 'o', id: 'r1' })).toBe(true)
    expect(recordActivity(draft, { db: sql, gate, now: START + 5, orgId: 'o', id: 'r2' })).toBe(false)
    expect(rowCount(raw)).toBe(1)
  })

  it('dec_058_the_row_it_writes_is_unchanged_from_before_the_guard', () => {
    // The guard decides whether to write, never what to write. Positional
    // binding replaced named binding so the tests could drive it; this pins
    // that the stored row is identical either way.
    const { raw, sql } = testDb()
    recordActivity(
      { taskId: 'desk-1', kind: NAV_KIND, payload: { url: 'https://example.test/a', widgetId: 'w1' } },
      { db: sql, gate: createNavTrailGate(), now: START, orgId: 'org-7', id: 'row-1' }
    )
    expect(raw.prepare('SELECT * FROM activity_log').get()).toEqual({
      id: 'row-1',
      task_id: 'desk-1',
      ts: START,
      kind: NAV_KIND,
      payload: JSON.stringify({ url: 'https://example.test/a', widgetId: 'w1' }),
      org_id: 'org-7'
    })
  })

  it('dec_058_admits_nav_row_reads_the_payload_the_widget_actually_sends', () => {
    // Contract between WebViewWidget's payload shape and the gate's key. If the
    // widget ever stops sending `widgetId`, this is where it shows up — as
    // every row being admitted, not as a crash.
    const gate = createNavTrailGate()
    const draft = {
      taskId: null,
      kind: NAV_KIND,
      payload: { url: 'https://example.test/a', title: 'A', host: 'example.test', widgetId: 'w1' }
    }
    expect(admitsNavRow(draft, gate, START)).toBe(true)
    expect(admitsNavRow(draft, gate, START + 5)).toBe(false)
    // A payload-less nav draft cannot be keyed, so it is admitted.
    expect(admitsNavRow({ taskId: null, kind: NAV_KIND }, gate, START)).toBe(true)
  })

  it('dec_058_the_default_gate_is_a_real_gate', () => {
    // `recordActivity` falls back to the process-local singleton when no gate
    // is injected — which is every production call. Cheap, but it is the line
    // that makes the invariant true in the app rather than only in these tests.
    navTrailGate.reset()
    const nav = { widgetId: 'dec058-default', url: 'https://example.test/default' }
    expect(navTrailGate.admit(nav, START)).toBe(true)
    expect(navTrailGate.admit(nav, START + 5)).toBe(false)
    navTrailGate.reset()
    expect(navTrailGate.admit(nav, START + 10)).toBe(true)
  })
})
