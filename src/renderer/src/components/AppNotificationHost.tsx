import { useEffect, useRef, useState, type JSX } from 'react'
import { useConnectedAppsStore } from '../stores/connectedApps'
import { useAppNotifications, looksSignedOut, sumAriaUnread } from '../stores/appNotifications'

// Background unread counts for connected apps.
//
// WHY THIS EXISTS. A count read from a page title only exists while that page
// is loaded, so the first version only knew about apps you happened to have
// open. This loads them itself, in the background, so the side menu is current
// for every app you asked to watch.
//
// THE DIRECTORY IS NOT FINITE, and that governs the whole design. People add
// whatever they use, so there can be no per-app rule — no "Gmail's count is
// here, Slack's is there". Everything below works off signals the entire web
// shares: the document title (where apps advertise a count), the presence of a
// password field (where they advertise that you are signed out), and the
// accessible labels on unread pills (where they advertise the real per-thread
// numbers).
//
// TITLES COUNT THREADS, NOT MESSAGES — a chat holding five unread titled itself
// "(1)" and we badged 1. The accessible labels carry the message counts, so
// they are summed and they outrank the title. `aria-label` is a standard rather
// than a selector, which is what keeps this working on an app nobody
// anticipated.
//
// POLL THEN RELEASE, rather than keeping a webview alive per app. Each check
// mounts one hidden webview, waits for the title, records it, and unmounts. A
// standing webview per app is a renderer process per app — a real cost on a
// real machine, and this machine already runs hot — whereas this holds at most
// SLOTS of them for a few seconds each. The trade is that counts refresh every
// cycle rather than instantly, which is the right trade for a badge.
//
// SESSIONS ARE REUSED, NOT CREATED. Each webview runs in the app's own
// `persist:connectedapp-<id>` partition — the same one the full-pane view and
// the desk widget use — so if you signed in there, this is signed in too, and
// the Vault binding keeps it that way. Nothing here logs anybody in.
//
// WHAT THE USER IS TOLD. The badge distinguishes a live count from a remembered
// one (sun/green vs moon/grey), because "4 unread, checked just now, signed in"
// and "4 unread, last seen yesterday, signed out" are different claims and a
// bare number makes both.

/** How many apps may be loading at once. */
const SLOTS = 2
/** How long to wait for an app to settle before giving up on this round. */
const CHECK_TIMEOUT_MS = 20_000
/** Gap between rounds. Long, because an unread badge is not a live ticker. */
const ROUND_GAP_MS = 5 * 60_000
/** Grace after the title arrives, for apps that set it twice while loading. */
const SETTLE_MS = 2_500

interface Watchable {
  id: string
  url: string
}

/**
 * One background check: load, read, report, unmount.
 *
 * Returns nothing — it reports into the store and then asks to be retired via
 * `onDone`, which is what advances the queue.
 */
function Probe({ app, onDone }: { app: Watchable; onDone: (id: string) => void }): JSX.Element {
  const ref = useRef<HTMLElement | null>(null)
  const finished = useRef(false)

  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    const store = useAppNotifications.getState()

    const finish = (): void => {
      if (finished.current) return
      finished.current = true
      onDone(app.id)
    }

    let settle: number | null = null

    const onTitle = (e: Event): void => {
      const title = (e as unknown as { title?: string }).title ?? ''
      store.report(app.id, title)
      // Apps often set a provisional title then the real one; take the last
      // within the grace window rather than the first.
      if (settle !== null) window.clearTimeout(settle)
      settle = window.setTimeout(finish, SETTLE_MS)
    }

    const onReady = (): void => {
      // THE UNIVERSAL SIGNALS, read from inside the page.
      //
      //  - a visible password field  → signed out (a signed-out app often keeps
      //    a perfectly normal URL, so the URL alone is not enough)
      //  - accessible labels of the form "N unread…" → the per-conversation
      //    unread counts, which summed give the MESSAGE total the title does
      //    not. See `sumAriaUnread`. `aria-label` is a standard, so this needs
      //    no per-app selector and works on an app nobody anticipated.
      //
      // `containsAnother` is collected here rather than inferred later because
      // only the page knows its own tree, and without it a row's pill and the
      // row's wrapper both count and the total doubles.
      const probe = `(() => {
        const p = document.querySelector("input[type=password]");
        const nodes = Array.from(document.querySelectorAll('[aria-label]'))
          .filter((el) => /\\d+\\s+unread/i.test(el.getAttribute('aria-label') || ''));
        const labels = nodes.map((el) => ({
          label: el.getAttribute('aria-label') || '',
          containsAnother: nodes.some((o) => o !== el && el.contains(o))
        }));
        return { pw: !!p && !!p.offsetParent, url: location.href, labels };
      })()`
      ;(wv as unknown as { executeJavaScript: (s: string) => Promise<unknown> })
        .executeJavaScript(probe)
        .then((raw) => {
          const r = (raw ?? {}) as {
            pw?: boolean
            url?: string
            labels?: Array<{ label: string; containsAnother: boolean }>
          }
          const url = r.url ?? app.url
          if (looksSignedOut(url, !!r.pw)) {
            // Signed out: the count we may be holding is from an older,
            // signed-in read. Keep it, but stop calling it live.
            store.setLiveness(app.id, 'signed-out', url)
            finish()
            return
          }
          store.setLiveness(app.id, 'live', url)
          // The message total, when the page states one. It outranks the title,
          // which counts threads — this is the whole point: five messages in one
          // chat badged as 1.
          const summed = sumAriaUnread(r.labels ?? [])
          if (summed !== null) {
            store.reportCount(app.id, summed, 'messages')
          } else {
            // A live check that found no per-thread labels, where an earlier
            // one did. Hand the lead back to the title rather than letting a
            // message count we can no longer refresh outrank it forever.
            store.releaseMessageClaim(app.id)
          }
          // If the title already carried a count, onTitle has it; if the app
          // never sets one, the grace timer below retires this probe.
          if (settle === null) settle = window.setTimeout(finish, SETTLE_MS)
        })
        .catch(() => {
          // The probe could not run (CSP, crashed guest). Not a sign-out, and
          // not a count — say asleep rather than inventing either.
          store.setLiveness(app.id, 'asleep', app.url)
          finish()
        })
    }

    const onFail = (): void => {
      store.setLiveness(app.id, 'asleep', app.url)
      finish()
    }

    wv.addEventListener('page-title-updated', onTitle as EventListener)
    wv.addEventListener('dom-ready', onReady as EventListener)
    wv.addEventListener('did-fail-load', onFail as EventListener)
    const hardStop = window.setTimeout(finish, CHECK_TIMEOUT_MS)

    return () => {
      window.clearTimeout(hardStop)
      if (settle !== null) window.clearTimeout(settle)
      wv.removeEventListener('page-title-updated', onTitle as EventListener)
      wv.removeEventListener('dom-ready', onReady as EventListener)
      wv.removeEventListener('did-fail-load', onFail as EventListener)
    }
  }, [app.id, app.url, onDone])

  // Offscreen rather than display:none or 0x0: a guest with no layout may never
  // run its scripts, and a page that never runs never sets a title.
  return (
    <webview
      ref={ref as never}
      src={app.url}
      partition={`persist:connectedapp-${app.id}`}
      // eslint-disable-next-line react/no-unknown-property
      allowpopups={undefined}
      style={{
        position: 'fixed',
        left: -10_000,
        top: 0,
        width: 480,
        height: 360,
        opacity: 0,
        pointerEvents: 'none'
      }}
      aria-hidden="true"
      data-testid={`app-notification-probe-${app.id}`}
    />
  )
}

export default function AppNotificationHost(): JSX.Element | null {
  const apps = useConnectedAppsStore((s) => s.apps)
  const setLiveness = useAppNotifications((s) => s.setLiveness)

  // Only web apps that asked to be watched. A local app is launched, not
  // rendered, so there is no page and no title to read.
  const watchable: Watchable[] = apps
    .filter((a) => a.notifications && a.kind !== 'local' && /^https?:/i.test(a.url))
    .map((a) => ({ id: a.id, url: a.url }))

  const [active, setActive] = useState<string[]>([])
  const queue = useRef<string[]>([])
  const roundTimer = useRef<number | null>(null)

  // Anything no longer watched stops claiming a liveness.
  useEffect(() => {
    const ids = new Set(watchable.map((w) => w.id))
    for (const a of apps) {
      if (!ids.has(a.id)) setLiveness(a.id, 'asleep')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apps.map((a) => `${a.id}:${a.notifications}`).join(','), setLiveness])

  // The rounds. Each fills the free slots from the queue; when the queue runs
  // dry a new round is scheduled rather than looping immediately, so this is
  // idle almost all of the time.
  //
  // ALL SCHEDULING HAPPENS OUTSIDE `setActive`, and that is the point.
  //
  // It used to live inside the updater passed to setActive — which both
  // shifted items off `queue.current` and called setTimeout from in there.
  // React may invoke an updater more than once for a single update, and an
  // updater is required to be pure. Invoked twice, that version consumed two
  // queue entries while rendering one, losing an app from the round, and
  // could leave a second round timer running. Two timers pump twice as often,
  // and the error compounds: with 17 connected apps and a session left open
  // overnight, that is hundreds of extra <webview> guests mounted over the
  // hours. Each one is a real renderer process.
  //
  // So `activeRef` mirrors the state, every decision is made against the ref
  // before any setState, and the updater is now a plain value.
  const activeRef = useRef<string[]>([])
  useEffect(() => {
    activeRef.current = active
  }, [active])

  const pumpRef = useRef<() => void>(() => {})

  useEffect(() => {
    let cancelled = false

    const pump = (): void => {
      if (cancelled) return
      const cur = activeRef.current
      if (cur.length >= SLOTS) return

      const next = [...cur]
      while (next.length < SLOTS && queue.current.length > 0) {
        const id = queue.current.shift()
        if (id && !next.includes(id)) next.push(id)
      }

      if (next.length === 0) {
        // Round finished. Schedule the next one, once.
        if (roundTimer.current === null) {
          roundTimer.current = window.setTimeout(() => {
            roundTimer.current = null
            queue.current = watchable.map((w) => w.id)
            pump()
          }, ROUND_GAP_MS)
        }
        return
      }

      if (next.length === cur.length) return
      activeRef.current = next
      setActive(next)
    }
    pumpRef.current = pump

    // First round shortly after launch, not instantly: start-up has enough to
    // do without several webviews opening at once.
    const kickoff = window.setTimeout(() => {
      queue.current = watchable.map((w) => w.id)
      pump()
    }, 8_000)

    return () => {
      cancelled = true
      pumpRef.current = () => {}
      window.clearTimeout(kickoff)
      if (roundTimer.current !== null) window.clearTimeout(roundTimer.current)
      roundTimer.current = null
      // Drop every in-flight probe, so a change to the watched set cannot
      // leave an orphaned guest mounted with nothing left to retire it.
      activeRef.current = []
      setActive([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchable.map((w) => w.id).join(',')])

  const onDone = useRef((id: string) => {
    setActive((cur) => cur.filter((x) => x !== id))
  }).current

  // Refill as probes retire. Also outside the updater, for the reason above.
  useEffect(() => {
    if (active.length < SLOTS && queue.current.length > 0) pumpRef.current()
  }, [active])

  if (watchable.length === 0) return null

  return (
    <>
      {active.map((id) => {
        const app = watchable.find((w) => w.id === id)
        if (!app) return null
        return <Probe key={id} app={app} onDone={onDone} />
      })}
    </>
  )
}
