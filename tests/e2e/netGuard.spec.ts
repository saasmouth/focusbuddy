/**
 * E2E: the net guard (_netGuard.ts, _netGuardMain.cjs) — no spec reaches a
 * production host. Each test drives one way out of the app and asserts the
 * guard refused it, at the layer that should have caught it, before anything
 * answered.
 *
 * These run the guard in its selfTest mode (record, don't fail the test), so
 * they can assert WHAT was caught. That the ordinary mode fails a spec, names
 * it and names the URL — and that the guard is what catches the original
 * _fakeSignal leak — was proven by mutation when the guard landed
 * (e2e-hermetic-41), with no traffic leaving the machine:
 *
 *  (a) context routes installed AFTER the first document (the hold in
 *      _netGuardMain.cjs bypassed): both signed-in docComments tests FAILED,
 *      each naming wss://api.plexiidesk.com/ws at the session layer. The route
 *      existed; the socket opened before it — the real defect — and the
 *      session layer still caught it. (chatThreadWidget stayed green under that
 *      mutation, correctly: it reloads before signing in, so its document is
 *      created after the late route.)
 *  (b) a spec fetching https://api.plexiidesk.com/health from the renderer:
 *      aborted (the fetch rejected) and the spec FAILED with the URL.
 *  (c) the guard removed: (b) passed, and a local recording route (which
 *      answered instead of letting the request out) showed the request had been
 *      made — i.e. without the guard it would have gone to production.
 */
import { test, expect } from '@playwright/test'
import { ACTIVE, CURRENT, wsUrlFor } from '../../src/shared/productDomains'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { signInWithFakeSignal } from './_fakeSignal'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

async function boot(): Promise<LaunchedApp> {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3' }, netGuardSelfTest: true })
  await waitForReady(launched.window)
  return launched
}

const stacksFor = (l: LaunchedApp, url: string): string[] =>
  l.netGuard.violations.filter((v) => v.url.startsWith(url)).map((v) => v.stack)

test('NG-1 a signed-out boot reaches no production host; its one signal call is answered locally', async () => {
  const l = await boot()
  // Give the boot's deferred work (capabilities, launch modal) a moment.
  await l.window.waitForTimeout(1_500)
  expect(l.netGuard.violations).toEqual([])
  // The launch modal's public-features ask, answered locally, not sent.
  expect(l.netGuard.answeredLocally).toContain('GET /public/server-features')
})

test('NG-2 a renderer fetch to production is aborted and recorded', async () => {
  const l = await boot()
  const url = `${ACTIVE.api}/health`
  const outcome = await l.window.evaluate(async (u) => {
    try {
      const r = await fetch(u)
      return `answered ${r.status}`
    } catch (e) {
      return `rejected: ${String(e)}`
    }
  }, url)
  expect(outcome).toMatch(/^rejected/)
  expect(stacksFor(l, url)).toContain('renderer-http')
})

test('NG-3 a renderer WebSocket to production is closed and recorded', async () => {
  const l = await boot()
  const url = wsUrlFor(ACTIVE.api)
  const outcome = await l.window.evaluate(
    (u) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(u)
        ws.onopen = () => resolve('open')
        ws.onclose = (e) => resolve(`closed ${e.code}`)
        setTimeout(() => resolve('timeout'), 5_000)
      }),
    url
  )
  expect(outcome).not.toBe('timeout')
  expect(stacksFor(l, url)).toContain('renderer-ws')
})

test('NG-4 main-process Electron net.fetch to production is cancelled at the session', async () => {
  const l = await boot()
  // The other name for the same server: derived from productDomains, too.
  const url = `${CURRENT.api}/healthz`
  const outcome = await l.app.evaluate(async ({ net }, u) => {
    try {
      const r = await net.fetch(u)
      return `answered ${r.status}`
    } catch (e) {
      return `rejected: ${String(e)}`
    }
  }, url)
  expect(outcome).toMatch(/^rejected/)
  expect(stacksFor(l, url)).toContain('session')
})

test('NG-5 main-process Node fetch to production is refused at connect', async () => {
  const l = await boot()
  const url = `${ACTIVE.site}/`
  const outcome = await l.app.evaluate(async (_e, u) => {
    try {
      const r = await fetch(u)
      return `answered ${r.status}`
    } catch (e) {
      const cause = (e as { cause?: unknown }).cause
      return `rejected: ${String(e)} ${String(cause)}`
    }
  }, url)
  expect(outcome).toMatch(/^rejected/)
  expect(outcome).toContain('[net-guard]')
  const host = new URL(url).hostname
  expect(l.netGuard.violations.some((v) => v.stack.startsWith('node') && v.url.includes(host))).toBe(true)
})

test('NG-6 a _fakeSignal sign-in: the FIRST socket is the fake route, nothing reaches production, no reload', async () => {
  const l = await boot()
  let sockets = 0
  let authenticated = false
  await signInWithFakeSignal(l.window, {
    name: { firstName: 'Gia', lastName: 'Guard' },
    onSocket: (ws) => {
      sockets++
      ws.onMessage((raw) => {
        if (String(raw).includes('"authenticate"')) authenticated = true
      })
    }
  })
  // The seeded session opens its realtime socket; it must land in onSocket.
  await expect.poll(() => sockets, { timeout: 10_000 }).toBeGreaterThan(0)
  await expect.poll(() => authenticated, { timeout: 10_000 }).toBe(true)
  await l.window.waitForTimeout(1_000)
  expect(l.netGuard.violations).toEqual([])
})

test('NG-7 a page route that continue()s a production URL still cannot reach it (DNS black hole)', async () => {
  const l = await boot()
  const url = `${ACTIVE.api}/healthz`
  // A spec's own page route runs before the guard's context route, and
  // continue() sends the request to the network directly. The session layer has
  // already passed it (window HTTP, routes ready), so the floor is the
  // --host-resolver-rules map: it must fail to resolve, not reach the server.
  await l.window.route(url, (route) => route.continue())
  const failed = l.window.waitForEvent('requestfailed', (r) => r.url() === url)
  const outcome = await l.window.evaluate(async (u) => {
    try {
      const r = await fetch(u)
      return `answered ${r.status}`
    } catch (e) {
      return `rejected: ${String(e)}`
    }
  }, url)
  expect(outcome).toMatch(/^rejected/)
  // Stopped by the resolver map, not the session layer (ERR_BLOCKED_BY_CLIENT)
  // and not a server: it never got as far as a connection.
  expect((await failed).failure()?.errorText).toBe('net::ERR_NAME_NOT_RESOLVED')
})
