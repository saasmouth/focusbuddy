// The pure half of session persistence: which partitions we look after, what to
// do with a cookie change, and when to flush. No electron import, so the unit
// suite tests every decision directly; sessionPersistence.ts does the wiring.
//
// THE BUG THIS EXISTS FOR. Connected apps run in persist:connectedapp-<id>
// partitions, which DO keep cookies on disk — but only cookies that carry an
// expiry. A cookie set without Expires/Max-Age is a "session cookie", and like
// every Chromium browser Electron drops those when the process quits. Plenty of
// apps keep their sign-in in exactly such a cookie, because a desktop browser
// that restores your tabs also restores session cookies and so they never had to
// care. Electron does not restore them. Every quit, update or crash therefore
// signed those apps out, and an app that is signed out reports no unread count
// to the side menu.
//
// THE FIX, AND ITS LIMITS. For connected-app partitions only, a session cookie
// is re-set with an expiry (KEEP_DAYS from now), which is the cookie a restoring
// browser would effectively have kept. A cookie that already has an expiry is
// never touched — never shortened, never lengthened — and a cookie the site
// removes stays removed, so signing out of an app still signs you out.

/** How long a kept session cookie lives, counted from its last write. */
export const KEEP_DAYS = 30
export const KEEP_SECONDS = KEEP_DAYS * 24 * 60 * 60

/** Partitions the browser surfaces use, by name (without the persist: prefix). */
export const BROWSER_PARTITION_NAMES = ['webview-default', 'plexii-browser', 'agentic-ops'] as const

const CONNECTED_APP_PREFIX = 'connectedapp-'

export type PartitionKind = 'browser' | 'connected-app' | null

/**
 * What a partition is, from its name. Accepts "persist:x" or the bare "x" that a
 * session's storagePath ends in. Anything else — the app's own default session,
 * an in-memory partition — is null and is left alone.
 */
export function partitionKind(name: string | null | undefined): PartitionKind {
  if (!name) return null
  const bare = name.startsWith('persist:') ? name.slice('persist:'.length) : name
  if (bare.startsWith(CONNECTED_APP_PREFIX) && bare.length > CONNECTED_APP_PREFIX.length) return 'connected-app'
  if ((BROWSER_PARTITION_NAMES as readonly string[]).includes(bare)) return 'browser'
  return null
}

/** The connected-app id a partition belongs to, or null. */
export function connectedAppIdOf(name: string | null | undefined): string | null {
  if (partitionKind(name) !== 'connected-app') return null
  const bare = name!.startsWith('persist:') ? name!.slice('persist:'.length) : name!
  return bare.slice(CONNECTED_APP_PREFIX.length)
}

/**
 * The partition name from a session's storagePath: Electron stores persist:<x>
 * under <userData>/Partitions/<x>. Null for an in-memory session (no path) or a
 * path that is not a partition directory.
 */
export function partitionFromStoragePath(storagePath: string | null | undefined): string | null {
  if (!storagePath) return null
  const parts = storagePath.replace(/[\\/]+$/, '').split(/[\\/]/)
  const leaf = parts.pop()
  const parent = parts.pop()
  if (!leaf || parent !== 'Partitions') return null
  return `persist:${leaf}`
}

/** The subset of Electron.Cookie the policy reads. */
export interface CookieLike {
  name: string
  value: string
  domain?: string
  hostOnly?: boolean
  path?: string
  secure?: boolean
  httpOnly?: boolean
  session?: boolean
  expirationDate?: number
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

/** The subset of Electron.CookiesSetDetails the policy produces. */
export interface CookieSetDetailsLike {
  url: string
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  expirationDate?: number
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

/** A stable identity for a cookie within its partition. Values never appear. */
export function cookieKey(partition: string, c: Pick<CookieLike, 'name' | 'domain' | 'path'>): string {
  return `${partition}\t${(c.domain ?? '').toLowerCase()}\t${c.path ?? '/'}\t${c.name}`
}

/** Is this a session cookie — one the browser would drop on quit? */
export function isSessionCookie(c: CookieLike): boolean {
  if (c.session === true) return true
  return typeof c.expirationDate !== 'number' || !Number.isFinite(c.expirationDate)
}

/**
 * Removal causes that are an overwrite in progress (an insert follows), as
 * opposed to the site or the browser getting rid of the cookie. Note
 * 'expired-overwrite' is NOT here: that is a site writing an already-expired
 * cookie, which is how sites delete one.
 */
const OVERWRITE_CAUSES = new Set(['overwrite', 'inserted-no-change-overwrite', 'inserted-no-value-change-overwrite'])

export interface CookieChange {
  partition: string
  cookie: CookieLike
  cause: string
  removed: boolean
}

export interface CookiePolicyContext {
  /** Settings → Advanced → "Keep connected apps signed in between launches". */
  enabled: boolean
  /** Unix seconds. */
  nowSeconds: number
  /** True when this change is the echo of our own cookies.set. */
  selfSet: boolean
}

export type CookieDecision =
  | { action: 'extend'; key: string; details: CookieSetDetailsLike }
  | { action: 'forget'; key: string; reason: 'removed' | 'site-set-expiry' }
  | {
      action: 'ignore'
      reason: 'disabled' | 'not-connected-app' | 'self-set' | 'overwrite' | 'has-expiry' | 'unsettable'
    }

/** The URL cookies.set needs to address a cookie: scheme from Secure, host from Domain. */
export function cookieUrl(c: CookieLike): string | null {
  const host = (c.domain ?? '').replace(/^\./, '')
  if (!host) return null
  const path = c.path && c.path.startsWith('/') ? c.path : '/'
  return `${c.secure ? 'https' : 'http'}://${host}${path}`
}

/** The cookies.set call that keeps `c` alive: same everything, plus an expiry. */
export function keptCookieDetails(c: CookieLike, nowSeconds: number): CookieSetDetailsLike | null {
  const url = cookieUrl(c)
  if (!url) return null
  const details: CookieSetDetailsLike = {
    url,
    name: c.name,
    value: c.value,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    expirationDate: Math.floor(nowSeconds) + KEEP_SECONDS
  }
  // A host-only cookie must stay host-only: passing `domain` would widen it to
  // every subdomain (and a __Host- cookie would be rejected outright).
  if (!c.hostOnly && c.domain) details.domain = c.domain
  if (c.sameSite) details.sameSite = c.sameSite
  return details
}

/**
 * What to do about one cookies 'changed' event.
 *
 *   setting off                → nothing (pure browser behaviour)
 *   not a connected-app jar    → nothing
 *   our own set echoing back   → nothing (the loop guard)
 *   removed by an overwrite    → nothing (the insert that follows decides)
 *   removed any other way      → forget it: a site deleting its cookie is a
 *                                sign-out, and we respect it
 *   added WITH an expiry       → leave it; if we were keeping it, stop — the
 *                                site has chosen its own lifetime
 *   added WITHOUT an expiry    → extend: re-set it with KEEP_DAYS of life
 */
export function decideCookieChange(change: CookieChange, ctx: CookiePolicyContext): CookieDecision {
  if (!ctx.enabled) return { action: 'ignore', reason: 'disabled' }
  if (partitionKind(change.partition) !== 'connected-app') return { action: 'ignore', reason: 'not-connected-app' }
  if (ctx.selfSet) return { action: 'ignore', reason: 'self-set' }
  const key = cookieKey(change.partition, change.cookie)
  if (change.removed) {
    if (OVERWRITE_CAUSES.has(change.cause)) return { action: 'ignore', reason: 'overwrite' }
    return { action: 'forget', key, reason: 'removed' }
  }
  if (!isSessionCookie(change.cookie)) return { action: 'forget', key, reason: 'site-set-expiry' }
  const details = keptCookieDetails(change.cookie, ctx.nowSeconds)
  if (!details) return { action: 'ignore', reason: 'unsettable' }
  return { action: 'extend', key, details }
}

/**
 * Remembers the cookies.set calls in flight so their 'changed' echoes can be
 * recognised and ignored — the feedback-loop guard. Keyed by cookie identity and
 * value; the echo of a keep always carries an expiry, so a SESSION cookie with
 * the same value (the site writing it again) is never mistaken for our echo.
 * The expiry itself is not part of the key: Chromium may round it, and a guard
 * that misses its own echo would read our keep as the site choosing a lifetime.
 */
export class SelfSetGuard {
  private pending = new Map<string, number>()

  private sig(key: string, value: string): string {
    return `${key}\n${value}`
  }

  /** Call just before cookies.set. */
  expect(key: string, value: string): void {
    const s = this.sig(key, value)
    this.pending.set(s, (this.pending.get(s) ?? 0) + 1)
  }

  /** Call for every non-removal change. True (and consumed) if it is our echo. */
  consume(key: string, cookie: CookieLike): boolean {
    if (isSessionCookie(cookie)) return false
    const s = this.sig(key, cookie.value)
    const n = this.pending.get(s)
    if (!n) return false
    if (n <= 1) this.pending.delete(s)
    else this.pending.set(s, n - 1)
    return true
  }

  /** A set that failed produces no echo; drop its expectation. */
  cancel(key: string, value: string): void {
    const s = this.sig(key, value)
    const n = this.pending.get(s)
    if (!n) return
    if (n <= 1) this.pending.delete(s)
    else this.pending.set(s, n - 1)
  }

  get size(): number {
    return this.pending.size
  }
}

// ── Flushing ────────────────────────────────────────────────────────────────

/** Why a flush was asked for; only shows up in logs and tests. */
export type FlushReason = 'interval' | 'blur' | 'hide' | 'quit' | 'update' | 'manual'

export interface FlushTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

export interface FlushSchedulerOptions {
  /** Flushes every partition; resolves when done. Errors are swallowed by the scheduler. */
  flush: (reason: FlushReason) => Promise<void>
  timers: FlushTimers
  /** The standing cadence. */
  intervalMs?: number
  /** Blur/hide bursts (a window flicking focus) collapse into one flush. */
  debounceMs?: number
}

export interface FlushScheduler {
  start: () => void
  stop: () => void
  /** Debounced: blur/hide. */
  request: (reason: FlushReason) => void
  /**
   * Immediate, bounded: quit/update. Resolves when the flush finishes or the
   * timeout passes, whichever is first, and reports which — so quitting is never
   * held hostage by a stuck cookie store.
   */
  flushNow: (reason: FlushReason, timeoutMs: number) => Promise<'flushed' | 'timed-out' | 'failed'>
}

export const FLUSH_INTERVAL_MS = 60_000
export const FLUSH_DEBOUNCE_MS = 1_500
export const QUIT_FLUSH_TIMEOUT_MS = 1_500

export function createFlushScheduler(opts: FlushSchedulerOptions): FlushScheduler {
  const { timers } = opts
  const intervalMs = opts.intervalMs ?? FLUSH_INTERVAL_MS
  const debounceMs = opts.debounceMs ?? FLUSH_DEBOUNCE_MS
  let interval: unknown = null
  let debounce: unknown = null
  let pendingReason: FlushReason | null = null
  let inFlight: Promise<void> | null = null

  const run = (reason: FlushReason): Promise<void> => {
    // One flush at a time; a request during one rides on it rather than
    // stacking a second walk over every cookie store.
    if (inFlight) return inFlight
    const p = Promise.resolve()
      .then(() => opts.flush(reason))
      .catch(() => {
        // A failed flush is retried by the next tick of the cadence; it must
        // never surface as an unhandled rejection in the main process.
      })
      .finally(() => {
        if (inFlight === p) inFlight = null
      })
    inFlight = p
    return p
  }

  return {
    start() {
      if (interval !== null) return
      interval = timers.setInterval(() => void run('interval'), intervalMs)
    },
    stop() {
      if (interval !== null) timers.clearInterval(interval)
      interval = null
      if (debounce !== null) timers.clearTimeout(debounce)
      debounce = null
      pendingReason = null
    },
    request(reason) {
      pendingReason = reason
      if (debounce !== null) timers.clearTimeout(debounce)
      debounce = timers.setTimeout(() => {
        debounce = null
        const r = pendingReason ?? reason
        pendingReason = null
        void run(r)
      }, debounceMs)
    },
    flushNow(reason, timeoutMs) {
      if (debounce !== null) {
        timers.clearTimeout(debounce)
        debounce = null
        pendingReason = null
      }
      let failed = false
      const work = Promise.resolve()
        .then(() => opts.flush(reason))
        .catch(() => {
          failed = true
        })
      return new Promise((resolve) => {
        let done = false
        const t = timers.setTimeout(() => {
          if (done) return
          done = true
          resolve('timed-out')
        }, timeoutMs)
        void work.then(() => {
          if (done) return
          done = true
          timers.clearTimeout(t)
          resolve(failed ? 'failed' : 'flushed')
        })
      })
    }
  }
}

// ── Cookie-count diagnostics ────────────────────────────────────────────────

export interface CookieCountRecord {
  /** Cookies in the partition at the last flush of the previous run(s). */
  lastCount: number
  /** When that count was taken (ms). */
  at: number
}

/**
 * The one-line verdict on whether a partition lost cookies across the restart:
 * compares the count at the last flush before quitting with the count when this
 * launch first opened the partition. Numbers only — never names or values.
 */
export function cookieDropVerdict(previous: CookieCountRecord | undefined, atLaunch: number | undefined): string {
  if (!previous) return 'no count from a previous launch'
  if (atLaunch === undefined) return `last launch ended with ${previous.lastCount}, this launch not counted yet`
  const delta = atLaunch - previous.lastCount
  if (delta < 0) return `cookie count DROPPED since last launch (${previous.lastCount} -> ${atLaunch})`
  return `cookie count did not drop since last launch (${previous.lastCount} -> ${atLaunch})`
}
