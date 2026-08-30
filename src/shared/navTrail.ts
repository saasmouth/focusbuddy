// DEC-058 — coalescing the browser navigation trail at the point of record.
//
// DEC-057 capped `activity_log` after the fact; this is the cause it was
// capping. The forensics, from the live database:
//
//   39,762 browser_nav rows written 2026-06-29 17:43 → 2026-06-30 12:30 local
//   (~19 hours, ~35 rows/minute sustained) — 76% of the entire 52,208-row
//   table. Between them those 39,762 rows carry FIFTEEN distinct URLs, and
//   four widgets account for 39,704 of them, one URL each:
//
//     app.slack.com        13,233 rows   1 url
//     claude.ai             9,927 rows   1 url
//     app.notion.com        9,927 rows   1 url
//     dashboard.stripe.com  6,617 rows   1 url
//
// Nobody navigated. Two independent multipliers turned a stationary desk into
// 35 writes a minute:
//
// 1. ONE PAGE LOAD EMITS THREE ROWS. `BrowserSurface` funnels four different
//    webview events into a single `nav` handler — did-navigate,
//    did-navigate-in-page, did-finish-load and did-redirect-navigation
//    (BrowserSurface.tsx). A cold load trips three of them in sequence, which
//    is legible in the recorded titles because `getTitle()` returns something
//    different at each stage:
//
//      06:13:24.749  claude.ai/chat/a35f…                    (commit)
//      06:13:25.078  Claude                                  (+329ms, load)
//      06:13:26.485  Choosing between LLC and C-corp…        (+1.4s, hydrate)
//
// 2. THE WORKSPACE SYNC TICK RELOADS EVERY WEBVIEW. That triplet repeats every
//    20.0 seconds, and all four widgets fire within 3ms of each other —
//    06:13:24.746, .748, .749, .941. Four independent pages do not reload in
//    lockstep by coincidence; they were reloaded by one shared caller.
//    `SYNC_INTERVAL_MS = 20_000` (workspaceSync.ts), whose applied-changes
//    branch calls `loadForTask(activeTaskId, { refresh: true })`.
//
//    4 widgets × 3 rows/load × 3 loads/minute = 36 rows/minute. Observed: 35.
//
// So the recording site was asked to record the same page ~1,900 times per
// widget and did exactly as it was told. `handleNav()` passed every event
// straight to `trail.record`, while `persistNavUrl()` — three lines below it,
// in the same function body — already skipped the redundant work with
// `if (url === lastPersistedUrl.current) return`. The widget's DB write was
// guarded; its activity row was not. This module is that missing guard, and it
// lives in `shared/` because both ends of the IPC need it: the renderer to not
// send 39,762 messages, main to not trust that it didn't.
//
// ── What this deliberately does NOT do ──────────────────────────────────────
// It does not debounce. A debounce delays every navigation, including the
// single most interesting one — the one the user just made — to catch repeats
// that a comparison catches for free. The trail stays live: a genuinely new
// URL is admitted on the spot, with no timer between the click and the row.

/** The identity of one navigation, as `WebViewWidget` reports it. */
export interface NavTrailKey {
  /** The widget whose webview navigated. Trails are tracked per widget. */
  widgetId: string
  /** The destination URL. */
  url: string
}

export interface NavTrailPolicy {
  /**
   * How long a page you have NOT left is left un-re-recorded. This is the
   * window that answers the burst above: those reloads never changed the URL,
   * so every row after the first said something already on the record.
   */
  stationaryMs: number
  /**
   * How long a URL the widget has recently left is suppressed for on return.
   * This is the guard against the failure the burst was NOT, but that the same
   * code path permits: a page that cycles A → B → A → B (a self-redirect, an
   * SPA fighting its own router) changes URL on every hop, so `stationaryMs`
   * never sees a repeat and every hop looks like real navigation.
   */
  revisitMs: number
  /** Recent URLs remembered per widget — the depth of the `revisitMs` check. */
  recentUrls: number
  /** Widgets tracked at once. Bounds the gate's memory with no lifecycle hook. */
  trackedWidgets: number
}

// `stationaryMs` is 30 minutes: 90× the 20-second reload cadence that produced
// the burst, so no machine-driven refresh can approach it, and coarse enough
// that "still on the same page" — which is the absence of navigation, not an
// instance of it — costs at most two rows an hour per widget. Against the real
// burst that is 152 rows where 39,762 were written, and it cannot suppress a
// real navigation, because a real navigation changes the URL and is therefore
// judged by `revisitMs` instead.
//
// `revisitMs` is 60 seconds, sized to be longer than any redirect cycle and
// shorter than a person's. Its cost when wrong is one missing row for a
// back-button press inside a minute — on a page already in the trail.
export const NAV_TRAIL_POLICY: NavTrailPolicy = {
  stationaryMs: 1_800_000,
  revisitMs: 60_000,
  recentUrls: 8,
  trackedWidgets: 64
}

export interface NavTrailGate {
  /**
   * True when this navigation should be written. Call once per candidate row:
   * an admitted call updates the trail, so asking twice about the same event
   * answers false the second time.
   */
  admit(key: NavTrailKey, now: number): boolean
  /** Drop a widget's trail — it closed, or its webview was torn down. */
  forget(widgetId: string): void
  /** Drop every trail. Tests, and sign-out. */
  reset(): void
}

interface WidgetTrail {
  /** url → the ms of the row actually written for it. Insertion-ordered LRU. */
  seen: Map<string, number>
  /** The URL of the most recent admitted row: the page the widget is "on". */
  currentUrl: string
}

// Evict from the front of an insertion-ordered Map until it fits. Re-setting a
// key does not reorder it in JS, which is why `admit` deletes before it sets.
function trim(map: Map<string, unknown>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next()
    if (oldest.done) return
    map.delete(oldest.value)
  }
}

export function createNavTrailGate(policy: NavTrailPolicy = NAV_TRAIL_POLICY): NavTrailGate {
  const widgets = new Map<string, WidgetTrail>()

  return {
    admit({ widgetId, url }, now) {
      // Nothing to key a trail on. Recording is the safe failure: this gate
      // exists to remove noise, never to be the reason a navigation vanished.
      if (!widgetId || !url) return true

      const trail = widgets.get(widgetId)
      if (!trail) {
        widgets.set(widgetId, { seen: new Map([[url, now]]), currentUrl: url })
        trim(widgets, policy.trackedWidgets)
        return true
      }

      const seenAt = trail.seen.get(url)
      const window = url === trail.currentUrl ? policy.stationaryMs : policy.revisitMs
      // `now >= seenAt` is the clock-skew arm: a backwards system clock makes
      // the elapsed time negative, which would otherwise read as "no time has
      // passed" and suppress every row until the clock caught up. A jump
      // backwards re-anchors the trail instead.
      if (seenAt !== undefined && now >= seenAt && now - seenAt < window) return false

      trail.seen.delete(url) // delete-then-set = move to the LRU's newest end
      trail.seen.set(url, now)
      trail.currentUrl = url
      trim(trail.seen, policy.recentUrls)

      widgets.delete(widgetId)
      widgets.set(widgetId, trail)
      return true
    },

    forget(widgetId) {
      widgets.delete(widgetId)
    },

    reset() {
      widgets.clear()
    }
  }
}

// Process-local default. Main and the renderer each bundle their own module
// instance and therefore hold their own gate — which is what we want: the
// renderer's gate spares the IPC, main's gate holds the invariant for every
// caller, including one written after this comment.
export const navTrailGate: NavTrailGate = createNavTrailGate()
