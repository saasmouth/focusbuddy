import { useEffect, useRef, useState, type JSX } from 'react'
import { useConnectedAppsStore } from '../stores/connectedApps'
import { useAppNotifications, looksSignedOut } from '../stores/appNotifications'

// Background unread counts for connected apps.
//
// WHY THIS EXISTS. A count read from a page title only exists while that page
// is loaded, so the first version only knew about apps you happened to have
// open. This loads them itself, in the background, so the side menu is current
// for every app you asked to watch.
//
// THE DIRECTORY IS NOT FINITE, and that governs the whole design. People add
// whatever they use, so there can be no per-app rule — no "Gmail's count is
// here, Slack's is there". Everything below works off two signals the entire
// web shares: the document title (where apps advertise unread counts) and the
// presence of a password field (where they advertise that you are signed out).
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
      // The two universal signals. A password field is checked in the page
      // itself because a signed-out app often keeps a perfectly normal URL.
      const probe =
        '(() => { const p = document.querySelector("input[type=password]"); ' +
        'return { pw: !!p && !!p.offsetParent, url: location.href } })()'
      ;(wv as unknown as { executeJavaScript: (s: string) => Promise<unknown> })
        .executeJavaScript(probe)
        .then((raw) => {
          const r = (raw ?? {}) as { pw?: boolean; url?: string }
          const url = r.url ?? app.url
          if (looksSignedOut(url, !!r.pw)) {
            // Signed out: the count we may be holding is from an older,
            // signed-in read. Keep it, but stop calling it live.
            store.setLiveness(app.id, 'signed-out', url)
            finish()
            return
          }
          store.setLiveness(app.id, 'live', url)
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
  useEffect(() => {
    let cancelled = false

    const pump = (): void => {
      if (cancelled) return
      setActive((cur) => {
        if (cur.length >= SLOTS) return cur
        const next = [...cur]
        while (next.length < SLOTS && queue.current.length > 0) {
          const id = queue.current.shift()
          if (id && !next.includes(id)) next.push(id)
        }
        if (next.length === 0 && roundTimer.current === null) {
          roundTimer.current = window.setTimeout(() => {
            roundTimer.current = null
            queue.current = watchable.map((w) => w.id)
            pump()
          }, ROUND_GAP_MS)
        }
        return next
      })
    }

    // First round shortly after launch, not instantly: start-up has enough to
    // do without several webviews opening at once.
    const kickoff = window.setTimeout(() => {
      queue.current = watchable.map((w) => w.id)
      pump()
    }, 8_000)

    return () => {
      cancelled = true
      window.clearTimeout(kickoff)
      if (roundTimer.current !== null) window.clearTimeout(roundTimer.current)
      roundTimer.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchable.map((w) => w.id).join(',')])

  const onDone = useRef((id: string) => {
    setActive((cur) => cur.filter((x) => x !== id))
  }).current

  // Refill as probes retire.
  useEffect(() => {
    if (active.length < SLOTS && queue.current.length > 0) {
      setActive((cur) => {
        const next = [...cur]
        while (next.length < SLOTS && queue.current.length > 0) {
          const id = queue.current.shift()
          if (id && !next.includes(id)) next.push(id)
        }
        return next
      })
    }
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
