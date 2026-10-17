import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  KEEP_SECONDS,
  SelfSetGuard,
  connectedAppIdOf,
  cookieDropVerdict,
  cookieKey,
  cookieUrl,
  createFlushScheduler,
  decideCookieChange,
  isSessionCookie,
  keptCookieDetails,
  partitionFromStoragePath,
  partitionKind,
  type CookieLike,
  type FlushReason,
  type FlushTimers
} from '../../src/main/sessionCookiePolicy'

// Connected apps signed themselves out on every quit: the partitions are
// persistent, but Chromium drops cookies with no expiry ("session cookies") at
// quit, and nothing flushed the stores either. These pin the pure decisions the
// main-process wiring (sessionPersistence.ts) makes on every cookie change.

const APP = 'persist:connectedapp-0b691903-86a7-4237-bea6-7965005bc755'
const NOW = 1_800_000_000

const sessionCookie = (over: Partial<CookieLike> = {}): CookieLike => ({
  name: 'sid',
  value: 'v1',
  domain: 'app.example.com',
  hostOnly: true,
  path: '/',
  secure: true,
  httpOnly: true,
  session: true,
  sameSite: 'lax',
  ...over
})

const on = { enabled: true, nowSeconds: NOW, selfSet: false }

describe('partitions', () => {
  it('classifies connected-app and browser partitions, with or without persist:', () => {
    expect(partitionKind(APP)).toBe('connected-app')
    expect(partitionKind('connectedapp-abc')).toBe('connected-app')
    expect(partitionKind('persist:webview-default')).toBe('browser')
    expect(partitionKind('persist:plexii-browser')).toBe('browser')
    expect(partitionKind('persist:agentic-ops')).toBe('browser')
  })

  it('leaves everything else alone', () => {
    expect(partitionKind(null)).toBeNull()
    expect(partitionKind('')).toBeNull()
    expect(partitionKind('persist:connectedapp-')).toBeNull()
    expect(partitionKind('persist:something-else')).toBeNull()
    expect(partitionKind('webview-default-not')).toBeNull()
  })

  it('reads the app id out of a connected-app partition only', () => {
    expect(connectedAppIdOf(APP)).toBe('0b691903-86a7-4237-bea6-7965005bc755')
    expect(connectedAppIdOf('persist:webview-default')).toBeNull()
  })

  it('recovers the partition name from a session storagePath', () => {
    expect(partitionFromStoragePath('/Users/x/Library/Application Support/plexii/Partitions/connectedapp-abc')).toBe(
      'persist:connectedapp-abc'
    )
    expect(partitionFromStoragePath('C:\\Users\\x\\AppData\\Roaming\\plexii\\Partitions\\webview-default\\')).toBe(
      'persist:webview-default'
    )
    // The default session's path is userData itself, not a partition.
    expect(partitionFromStoragePath('/Users/x/Library/Application Support/plexii')).toBeNull()
    expect(partitionFromStoragePath(null)).toBeNull()
  })
})

describe('the keep decision', () => {
  it('extends a session cookie in a connected-app partition by 30 days, changing nothing else', () => {
    const d = decideCookieChange({ partition: APP, cookie: sessionCookie(), cause: 'inserted', removed: false }, on)
    expect(d.action).toBe('extend')
    if (d.action !== 'extend') return
    expect(d.details).toEqual({
      url: 'https://app.example.com/',
      name: 'sid',
      value: 'v1',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: NOW + KEEP_SECONDS
    })
    expect(KEEP_SECONDS).toBe(30 * 24 * 60 * 60)
    // Host-only stays host-only: no domain attribute, which would widen it.
    expect('domain' in d.details).toBe(false)
  })

  it('keeps a domain cookie a domain cookie', () => {
    const d = decideCookieChange(
      {
        partition: APP,
        cookie: sessionCookie({ domain: '.example.com', hostOnly: false, secure: false, sameSite: undefined }),
        cause: 'explicit',
        removed: false
      },
      on
    )
    expect(d.action).toBe('extend')
    if (d.action !== 'extend') return
    expect(d.details.domain).toBe('.example.com')
    expect(d.details.url).toBe('http://example.com/')
    expect(d.details.secure).toBe(false)
    expect('sameSite' in d.details).toBe(false)
  })

  it('treats a cookie with no expirationDate as a session cookie even without the flag', () => {
    const c = sessionCookie({ session: undefined, expirationDate: undefined })
    expect(isSessionCookie(c)).toBe(true)
    expect(decideCookieChange({ partition: APP, cookie: c, cause: 'inserted', removed: false }, on).action).toBe('extend')
  })

  it('never touches a cookie that already has an expiry — not shortened, not lengthened', () => {
    for (const exp of [NOW + 60, NOW + 400 * 24 * 3600]) {
      const c = sessionCookie({ session: false, expirationDate: exp })
      const d = decideCookieChange({ partition: APP, cookie: c, cause: 'inserted', removed: false }, on)
      expect(d.action).not.toBe('extend')
      // If we had been keeping it, the site has now chosen its own lifetime.
      expect(d).toEqual({ action: 'forget', key: cookieKey(APP, c), reason: 'site-set-expiry' })
    }
  })

  it('respects a removal: a deleted cookie is forgotten, never re-set', () => {
    for (const cause of ['explicit', 'expired', 'evicted', 'expired-overwrite']) {
      const d = decideCookieChange({ partition: APP, cookie: sessionCookie(), cause, removed: true }, on)
      expect(d, cause).toEqual({ action: 'forget', key: cookieKey(APP, sessionCookie()), reason: 'removed' })
    }
  })

  it('lets an overwrite in progress pass — the insert that follows decides', () => {
    for (const cause of ['overwrite', 'inserted-no-change-overwrite', 'inserted-no-value-change-overwrite']) {
      expect(decideCookieChange({ partition: APP, cookie: sessionCookie(), cause, removed: true }, on)).toEqual({
        action: 'ignore',
        reason: 'overwrite'
      })
    }
  })

  it('ignores the echo of its own set (the loop guard)', () => {
    expect(
      decideCookieChange(
        { partition: APP, cookie: sessionCookie(), cause: 'inserted', removed: false },
        { ...on, selfSet: true }
      )
    ).toEqual({ action: 'ignore', reason: 'self-set' })
  })

  it('ignores every partition that is not a connected app', () => {
    for (const p of ['persist:webview-default', 'persist:plexii-browser', 'persist:agentic-ops', 'persist:other', '']) {
      expect(decideCookieChange({ partition: p, cookie: sessionCookie(), cause: 'inserted', removed: false }, on)).toEqual({
        action: 'ignore',
        reason: 'not-connected-app'
      })
    }
  })

  it('does nothing at all with the setting off', () => {
    for (const removed of [false, true]) {
      expect(
        decideCookieChange(
          { partition: APP, cookie: sessionCookie(), cause: 'inserted', removed },
          { ...on, enabled: false }
        )
      ).toEqual({ action: 'ignore', reason: 'disabled' })
    }
  })

  it('cannot address a cookie with no domain, so leaves it', () => {
    const c = sessionCookie({ domain: '' })
    expect(cookieUrl(c)).toBeNull()
    expect(decideCookieChange({ partition: APP, cookie: c, cause: 'inserted', removed: false }, on)).toEqual({
      action: 'ignore',
      reason: 'unsettable'
    })
  })

  it('keeps the cookie path in the URL and the details', () => {
    const details = keptCookieDetails(sessionCookie({ path: '/app' }), NOW)
    expect(details?.url).toBe('https://app.example.com/app')
    expect(details?.path).toBe('/app')
  })

  it('keys a cookie by partition, domain, path and name — never its value', () => {
    const a = cookieKey(APP, sessionCookie({ value: 'secret-1' }))
    const b = cookieKey(APP, sessionCookie({ value: 'secret-2' }))
    expect(a).toBe(b)
    expect(a).not.toContain('secret')
  })
})

describe('the self-set guard', () => {
  const key = cookieKey(APP, sessionCookie())

  it('recognises our own echo exactly once', () => {
    const g = new SelfSetGuard()
    g.expect(key, 'v1')
    const echo = sessionCookie({ session: false, expirationDate: NOW + KEEP_SECONDS })
    expect(g.consume(key, echo)).toBe(true)
    expect(g.consume(key, echo)).toBe(false)
    expect(g.size).toBe(0)
  })

  it('never mistakes the site re-writing a session cookie for our echo', () => {
    const g = new SelfSetGuard()
    g.expect(key, 'v1')
    expect(g.consume(key, sessionCookie())).toBe(false)
    expect(g.size).toBe(1)
  })

  it('does not match a different value', () => {
    const g = new SelfSetGuard()
    g.expect(key, 'v1')
    expect(g.consume(key, sessionCookie({ value: 'v2', session: false, expirationDate: NOW + 5 }))).toBe(false)
  })

  it('drops the expectation when the set fails', () => {
    const g = new SelfSetGuard()
    g.expect(key, 'v1')
    g.cancel(key, 'v1')
    expect(g.size).toBe(0)
  })

  it('breaks the loop end to end: extend, echo, nothing further', () => {
    const g = new SelfSetGuard()
    const first = decideCookieChange({ partition: APP, cookie: sessionCookie(), cause: 'inserted', removed: false }, on)
    expect(first.action).toBe('extend')
    if (first.action !== 'extend') return
    g.expect(first.key, first.details.value)
    // Chromium reports the old copy removed by overwrite, then our insert.
    const removedOld = decideCookieChange(
      { partition: APP, cookie: sessionCookie(), cause: 'overwrite', removed: true },
      on
    )
    expect(removedOld.action).toBe('ignore')
    const echo = sessionCookie({ session: false, expirationDate: first.details.expirationDate })
    const selfSet = g.consume(first.key, echo)
    const second = decideCookieChange({ partition: APP, cookie: echo, cause: 'inserted', removed: false }, { ...on, selfSet })
    expect(second).toEqual({ action: 'ignore', reason: 'self-set' })
  })
})

// ── The flush scheduler ─────────────────────────────────────────────────────

// A real macrotask turn lets every queued promise reaction run, however deep
// the chain — the scheduler's then/catch/finally included.
const drain = (): Promise<void> => new Promise((r) => setImmediate(r))

function fakeTimers(): FlushTimers & { advance: (ms: number) => Promise<void>; pending: () => number } {
  let now = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>()
  return {
    setTimeout: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (h) => void timers.delete(h as number),
    setInterval: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn, every: ms })
      return id
    },
    clearInterval: (h) => void timers.delete(h as number),
    pending: () => timers.size,
    async advance(ms) {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [id, t] = due
        now = t.at
        if (t.every) t.at += t.every
        else timers.delete(id)
        t.fn()
        await drain()
      }
      now = end
      await drain()
    }
  }
}

describe('the flush scheduler', () => {
  it('flushes on a 60 s cadence once started, and stops when stopped', async () => {
    const t = fakeTimers()
    const flush = vi.fn(async (_r: FlushReason) => {})
    const s = createFlushScheduler({ flush, timers: t })
    await t.advance(120_000)
    expect(flush).not.toHaveBeenCalled()
    s.start()
    s.start() // idempotent: one cadence, not two
    await t.advance(60_000)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenLastCalledWith('interval')
    await t.advance(120_000)
    expect(flush).toHaveBeenCalledTimes(3)
    s.stop()
    await t.advance(600_000)
    expect(flush).toHaveBeenCalledTimes(3)
  })

  it('collapses a burst of blur/hide into one debounced flush', async () => {
    const t = fakeTimers()
    const flush = vi.fn(async (_r: FlushReason) => {})
    const s = createFlushScheduler({ flush, timers: t, debounceMs: 1_000 })
    s.request('blur')
    await t.advance(500)
    s.request('blur')
    s.request('hide')
    await t.advance(999)
    expect(flush).not.toHaveBeenCalled()
    await t.advance(1)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenLastCalledWith('hide')
  })

  it('flushNow resolves "flushed" when the flush completes in time', async () => {
    const t = fakeTimers()
    const flush = vi.fn(async (_r: FlushReason) => {})
    const s = createFlushScheduler({ flush, timers: t })
    await expect(s.flushNow('quit', 1_500)).resolves.toBe('flushed')
    expect(flush).toHaveBeenCalledWith('quit')
  })

  it('flushNow never holds quitting hostage: a stuck flush times out', async () => {
    const t = fakeTimers()
    const s = createFlushScheduler({ flush: () => new Promise<void>(() => {}), timers: t })
    let result: string | null = null
    void s.flushNow('quit', 1_500).then((r) => (result = r))
    await t.advance(1_499)
    expect(result).toBeNull()
    await t.advance(1)
    expect(result).toBe('timed-out')
  })

  it('flushNow reports a failed flush instead of throwing', async () => {
    const t = fakeTimers()
    const s = createFlushScheduler({
      flush: async () => {
        throw new Error('store gone')
      },
      timers: t
    })
    await expect(s.flushNow('update', 1_500)).resolves.toBe('failed')
  })

  it('flushNow supersedes a pending debounced flush', async () => {
    const t = fakeTimers()
    const flush = vi.fn(async (_r: FlushReason) => {})
    const s = createFlushScheduler({ flush, timers: t, debounceMs: 1_000 })
    s.request('blur')
    await s.flushNow('quit', 1_500)
    await t.advance(5_000)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenLastCalledWith('quit')
  })

  it('a failing cadence flush is swallowed and the cadence carries on', async () => {
    const t = fakeTimers()
    let calls = 0
    const s = createFlushScheduler({
      flush: async () => {
        calls++
        throw new Error('transient')
      },
      timers: t
    })
    s.start()
    await t.advance(180_000)
    expect(calls).toBe(3)
  })
})

describe('cookie-count diagnostics', () => {
  it('says when the jar shrank across the restart, in counts only', () => {
    expect(cookieDropVerdict({ lastCount: 14, at: 1 }, 3)).toBe('cookie count DROPPED since last launch (14 -> 3)')
    expect(cookieDropVerdict({ lastCount: 3, at: 1 }, 3)).toBe('cookie count did not drop since last launch (3 -> 3)')
    expect(cookieDropVerdict(undefined, 3)).toBe('no count from a previous launch')
    expect(cookieDropVerdict({ lastCount: 3, at: 1 }, undefined)).toMatch(/not counted yet/)
  })
})

describe('wiring pins', () => {
  const root = resolve(__dirname, '../..')
  const read = (p: string): string => readFileSync(resolve(root, p), 'utf8')

  it('before-quit flushes (deferring the quit once) before closing the database', () => {
    const src = read('src/main/index.ts')
    const block = src.slice(src.indexOf("app.on('before-quit'"))
    expect(block).toMatch(/beginQuitFlush\(\)/)
    expect(block).toMatch(/event\.preventDefault\(\)/)
    expect(block.indexOf('beginQuitFlush')).toBeLessThan(block.indexOf('closeDb()'))
  })

  it('session persistence is installed before extensions open the partitions', () => {
    const src = read('src/main/index.ts')
    expect(src.indexOf('installSessionPersistence()')).toBeGreaterThan(0)
    expect(src.indexOf('installSessionPersistence()')).toBeLessThan(src.indexOf('void restoreExtensions()'))
    expect(src).toMatch(/flushOnWindowBackground\(win\)/)
    expect(src).toMatch(/trackSession\(contents\.session\)/)
  })

  it('an update flushes before quitAndInstall', () => {
    const src = read('src/main/autoUpdate.ts')
    const fn = src.slice(src.indexOf('export async function installUpdateAndRestart'))
    expect(fn.indexOf('await flushBeforeUpdate()')).toBeGreaterThan(0)
    expect(fn.indexOf('await flushBeforeUpdate()')).toBeLessThan(fn.indexOf('autoUpdater.quitAndInstall('))
  })

  it('the diagnostic logs no query strings and no cookie values', () => {
    const src = read('src/main/sessionPersistence.ts')
    const fn = src.slice(src.indexOf('export async function logConnectedAppSignedOut'))
    expect(fn).toMatch(/urlForLog\(url\)/)
    expect(fn).not.toMatch(/\.value/)
  })
})
