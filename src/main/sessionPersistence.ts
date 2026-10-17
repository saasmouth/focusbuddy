// Session persistence for the browser surfaces and connected apps — the wiring.
// Every decision lives in sessionCookiePolicy.ts (pure, unit tested); this file
// only connects those decisions to Electron.
//
// Three jobs:
//
//  1. FLUSH. Chromium writes cookies to disk lazily (roughly every 30 s) and on
//     a clean shutdown. A crash, a force-quit or an updater that swaps the app
//     out from under us can lose whatever was written since. So every browser
//     and connected-app partition is flushed on a 60 s cadence, when the main
//     window blurs or hides, before quit (awaited, bounded) and before an update
//     installs.
//
//  2. KEEP CONNECTED APPS SIGNED IN. See sessionCookiePolicy.ts for the whole
//     argument: session cookies in persist:connectedapp-* partitions are re-set
//     with a 30-day expiry, so quitting stops signing those apps out. Cookies
//     that have an expiry are never touched; cookies a site deletes stay
//     deleted. Settings → Advanced turns it off.
//
//  3. DIAGNOSE. Each connected-app partition's cookie count is recorded at every
//     flush, so when the renderer reports that an app has landed on a sign-in
//     page, one log line can say whether the jar lost cookies across the
//     restart — the difference between "we dropped your session" and "the
//     provider expired it". Counts only; never a cookie name or value.

import { app, BrowserWindow, type Cookie, type Session } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getKeepAppsSignedIn, setKeepAppsSignedIn } from './settingsStore'
import { urlForLog } from '../shared/authUrl'
import {
  KEEP_SECONDS,
  QUIT_FLUSH_TIMEOUT_MS,
  SelfSetGuard,
  connectedAppIdOf,
  cookieDropVerdict,
  cookieKey,
  createFlushScheduler,
  decideCookieChange,
  isSessionCookie,
  keptCookieDetails,
  partitionFromStoragePath,
  partitionKind,
  type CookieCountRecord,
  type FlushReason,
  type FlushScheduler
} from './sessionCookiePolicy'

interface PersistFile {
  v: 1
  /** Per connected-app partition: the cookie count at the last flush. */
  counts: Record<string, CookieCountRecord>
  /** Cookie keys (partition/domain/path/name — no values) we are keeping alive. */
  kept: string[]
}

const tracked = new Map<string, Session>()
const trackedSessions = new WeakSet<Session>()
const guard = new SelfSetGuard()
const kept = new Set<string>()
/** Counts from the previous run(s), read once at install — never overwritten. */
let previousCounts: Record<string, CookieCountRecord> = {}
/** Counts as of this run's latest flush. */
const currentCounts: Record<string, CookieCountRecord> = {}
/** Each connected-app partition's count when this launch first opened it. */
const launchCounts = new Map<string, number>()
let keepCache: boolean | null = null
let dirty = false
let scheduler: FlushScheduler | null = null
let installed = false
let quitFlushDone = false
let setFailuresLogged = 0

const persistFile = (): string => join(app.getPath('userData'), 'session-persistence.json')

function readPersist(): PersistFile {
  try {
    if (!existsSync(persistFile())) return { v: 1, counts: {}, kept: [] }
    const raw = JSON.parse(readFileSync(persistFile(), 'utf8')) as Partial<PersistFile>
    const counts: Record<string, CookieCountRecord> = {}
    for (const [k, v] of Object.entries(raw.counts ?? {})) {
      if (v && typeof v.lastCount === 'number' && typeof v.at === 'number') counts[k] = v
    }
    return { v: 1, counts, kept: Array.isArray(raw.kept) ? raw.kept.filter((k) => typeof k === 'string') : [] }
  } catch {
    // A corrupt file costs us one launch's diagnostics, nothing more.
    return { v: 1, counts: {}, kept: [] }
  }
}

function writePersist(): void {
  try {
    const out: PersistFile = { v: 1, counts: { ...previousCounts, ...currentCounts }, kept: [...kept] }
    writeFileSync(persistFile(), JSON.stringify(out), 'utf8')
    dirty = false
  } catch (e) {
    console.warn('[session] could not save session-persistence.json:', e instanceof Error ? e.message : e)
  }
}

export function keepConnectedAppsSignedIn(): boolean {
  if (keepCache === null) {
    try {
      keepCache = getKeepAppsSignedIn()
    } catch {
      keepCache = true
    }
  }
  return keepCache
}

function extend(ses: Session, key: string, details: Electron.CookiesSetDetails): void {
  kept.add(key)
  dirty = true
  guard.expect(key, details.value ?? '')
  ses.cookies.set(details).catch((e) => {
    guard.cancel(key, details.value ?? '')
    kept.delete(key)
    // A cookie Chromium refuses to re-set (an odd prefix, a partitioned cookie)
    // stays a session cookie: the browser's behaviour, not a failure to report
    // loudly. A few lines are enough to diagnose; never the value.
    if (setFailuresLogged < 5) {
      setFailuresLogged++
      console.warn(`[session] could not keep a session cookie (${details.name}):`, e instanceof Error ? e.message : e)
    }
  })
}

function onCookieChanged(partition: string, ses: Session, cookie: Cookie, cause: string, removed: boolean): void {
  const key = cookieKey(partition, cookie)
  const selfSet = !removed && guard.consume(key, cookie)
  const decision = decideCookieChange(
    { partition, cookie, cause, removed },
    { enabled: keepConnectedAppsSignedIn(), nowSeconds: Date.now() / 1000, selfSet }
  )
  if (decision.action === 'extend') {
    extend(ses, decision.key, decision.details as Electron.CookiesSetDetails)
  } else if (decision.action === 'forget') {
    if (kept.delete(decision.key)) dirty = true
  }
}

async function countCookies(ses: Session): Promise<number | null> {
  try {
    return (await ses.cookies.get({})).length
  } catch {
    return null
  }
}

/**
 * Start looking after a session, if it is one of ours. Idempotent; safe to call
 * from session-created and again from web-contents-created.
 */
export function trackSession(ses: Session | null | undefined): void {
  if (!ses || trackedSessions.has(ses)) return
  let partition: string | null = null
  try {
    partition = partitionFromStoragePath(ses.storagePath)
  } catch {
    partition = null
  }
  const kind = partitionKind(partition)
  if (!partition || !kind) return
  trackedSessions.add(ses)
  tracked.set(partition, ses)
  if (kind !== 'connected-app') return
  const name = partition
  ses.cookies.on('changed', (_e, cookie, cause, removed) => onCookieChanged(name, ses, cookie, cause, removed))
  void countCookies(ses).then((n) => {
    if (n !== null && !launchCounts.has(name)) launchCounts.set(name, n)
  })
}

async function flushAll(reason: FlushReason): Promise<void> {
  const jobs: Promise<unknown>[] = []
  for (const [partition, ses] of tracked) {
    jobs.push(
      ses.cookies.flushStore().catch((e) => {
        console.warn(`[session] flush failed for ${partition} (${reason}):`, e instanceof Error ? e.message : e)
      })
    )
    if (partitionKind(partition) === 'connected-app') {
      jobs.push(
        countCookies(ses).then((n) => {
          if (n === null) return
          const prev = currentCounts[partition]
          if (!prev || prev.lastCount !== n) dirty = true
          currentCounts[partition] = { lastCount: n, at: Date.now() }
        })
      )
    }
  }
  await Promise.all(jobs)
  if (dirty) writePersist()
}

/**
 * Install once, after app ready and BEFORE anything opens a browser partition
 * (restoreExtensions does, at boot), so session-created sees every one.
 */
export function installSessionPersistence(): void {
  if (installed) return
  installed = true
  const persisted = readPersist()
  previousCounts = persisted.counts
  for (const k of persisted.kept) kept.add(k)
  app.on('session-created', (ses) => trackSession(ses))
  scheduler = createFlushScheduler({
    flush: flushAll,
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
      setInterval: (fn, ms) => {
        const t = setInterval(fn, ms)
        // The cadence must never be what keeps a quitting process alive.
        t.unref?.()
        return t
      },
      clearInterval: (h) => clearInterval(h as NodeJS.Timeout)
    }
  })
  scheduler.start()
}

/** Hook a window's blur/hide to a (debounced) flush. */
export function flushOnWindowBackground(win: BrowserWindow): void {
  win.on('blur', () => scheduler?.request('blur'))
  win.on('hide', () => scheduler?.request('hide'))
}

/** Flush now, bounded by `timeoutMs`. Never rejects. */
export async function flushSessionsNow(
  reason: FlushReason,
  timeoutMs = QUIT_FLUSH_TIMEOUT_MS
): Promise<'flushed' | 'timed-out' | 'failed' | 'not-installed'> {
  if (!scheduler) return 'not-installed'
  const result = await scheduler.flushNow(reason, timeoutMs)
  if (result !== 'flushed') console.warn(`[session] ${reason} flush ${result}`)
  return result
}

/**
 * The before-quit hook. Returns true when the caller must preventDefault and
 * quit again once the returned promise settles; false when quitting can proceed
 * now (already flushed — e.g. the updater flushed first — or nothing to flush).
 */
export function beginQuitFlush(): { deferQuit: false } | { deferQuit: true; done: Promise<unknown> } {
  if (quitFlushDone || !scheduler || tracked.size === 0) {
    quitFlushDone = true
    return { deferQuit: false }
  }
  quitFlushDone = true
  scheduler.stop()
  return { deferQuit: true, done: flushSessionsNow('quit') }
}

/** Before an update installs: flush, and tell before-quit it need not again. */
export async function flushBeforeUpdate(): Promise<void> {
  scheduler?.stop()
  await flushSessionsNow('update')
  quitFlushDone = true
}

// ── The setting ─────────────────────────────────────────────────────────────

export interface KeepSignedInState {
  keep: boolean
}

export function getKeepSignedInState(): KeepSignedInState {
  return { keep: keepConnectedAppsSignedIn() }
}

/**
 * Turn keeping on or off, and make the change true now rather than next launch:
 *  - on: every session cookie already in an open connected-app jar is kept;
 *  - off: every cookie we extended goes back to being a session cookie, so it
 *    ends at quit like it would in a plain browser. Cookies the sites gave
 *    their own expiry were never ours and are untouched.
 */
export async function setKeepSignedIn(keep: boolean): Promise<KeepSignedInState> {
  setKeepAppsSignedIn(keep)
  keepCache = keep
  const now = Date.now() / 1000
  for (const [partition, ses] of tracked) {
    if (partitionKind(partition) !== 'connected-app') continue
    let cookies: Cookie[] = []
    try {
      cookies = await ses.cookies.get({})
    } catch {
      continue
    }
    for (const c of cookies) {
      const key = cookieKey(partition, c)
      if (keep) {
        if (!isSessionCookie(c)) continue
        const details = keptCookieDetails(c, now)
        if (details) extend(ses, key, details as Electron.CookiesSetDetails)
      } else {
        if (!kept.has(key)) continue
        kept.delete(key)
        // Only revert what still looks like our keep (an expiry within our
        // window); a cookie the site has since re-set on its own terms is left.
        if (isSessionCookie(c) || (c.expirationDate ?? 0) > now + KEEP_SECONDS + 60) continue
        const details = keptCookieDetails(c, now)
        if (!details) continue
        delete details.expirationDate
        try {
          await ses.cookies.set(details as Electron.CookiesSetDetails)
        } catch {
          // Left as it was; it expires on its own within KEEP_DAYS.
        }
      }
    }
  }
  if (!keep) kept.clear()
  writePersist()
  return getKeepSignedInState()
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

/**
 * One line when the renderer sees a connected app land on a sign-in page after
 * it had been signed in. Origin + path only, no query; counts only, no cookies.
 */
export async function logConnectedAppSignedOut(appId: string, url: string, signal: string): Promise<void> {
  const safeId = String(appId).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64)
  const partition = `persist:connectedapp-${safeId}`
  if (connectedAppIdOf(partition) !== safeId || !safeId) return
  const ses = tracked.get(partition)
  const now = ses ? await countCookies(ses) : null
  const verdict = cookieDropVerdict(previousCounts[partition], launchCounts.get(partition))
  const safeSignal = String(signal).replace(/[^a-z-]/gi, '').slice(0, 24) || 'unknown'
  console.log(
    `[session] connected app ${safeId} looks signed out at ${urlForLog(url)} (signal: ${safeSignal}); ` +
      `keep-signed-in ${keepConnectedAppsSignedIn() ? 'on' : 'off'}; cookies now ${now ?? 'unknown'}; ${verdict}`
  )
}

/** Test/diagnostic view of what is being looked after. Never cookie values. */
export function sessionPersistenceStatus(): { partitions: string[]; kept: number; keep: boolean } {
  return { partitions: [...tracked.keys()].sort(), kept: kept.size, keep: keepConnectedAppsSignedIn() }
}
