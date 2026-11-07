// "Download this desk on Plexii", the app end (main/deskHandoffReceiver.ts,
// components/DeskHandoffEffects.tsx).
//
// A visitor on a public share page installs Plexii; the page hands their copy
// of the desk to the app as plexii://desk?handoff=<id>. The app keeps the id
// until someone is signed in, claims the copy from Signal with that session,
// and imports it under NEW ids -- so it never collides with the desk it was
// copied from, even when the person who opens it is the one who shared it.
//
// Signal's claim is answered here (the copy is packed by the app's own packer,
// standing in for the visitor's browser), and the deep link arrives the way
// macOS delivers it: as an open-url event in the main process.
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { ACTIVE } from '../../src/shared/productDomains'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

const HANDOFF = 'Hx3_kq-9ZpL0aBcD4eFgH1e2e'

/**
 * Signed in, the app talks to Signal (inbox, capabilities, sync). None of that
 * is this spec's business and none of it may reach production (net guard): it
 * is all answered here as "temporarily unavailable", which keeps the session.
 * Registered FIRST: Playwright tries the newest route first, so the claim
 * route each test adds afterwards wins for its own path.
 */
async function signalUnavailable(window: import('@playwright/test').Page): Promise<void> {
  const api = new URL(ACTIVE.api)
  await window.route(
    (u) => u.origin === api.origin,
    (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'unavailable' }) })
  )
  // The realtime socket: accepted and silent, as _fakeSignal answers it.
  await window.routeWebSocket((u) => u.host === api.host, () => {})
}

test('DH-1 a desk handed over by a share page arrives once someone is signed in, under new ids', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { app, window } = launched
  await waitForReady(window)

  // The visitor's copy: a desk with something they dropped on it, packed by
  // the app's own packer (the share page uses the same builder).
  const src = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = (await api.nodes.create({ parentId: null, kind: 'task', title: 'Handed-over desk' })) as { id: string }
    const w = (await api.widgets.create({
      taskId: desk.id, kind: 'sticky', title: '', content: 'dropped by the visitor', x: 40, y: 40, width: 220, height: 160
    } as never)) as { id: string }
    const packed = (await api.shares.buildDeskBundle(desk.id)) as { ok: boolean; json?: string }
    return { deskId: desk.id, widgetId: w.id, bundle: packed.json ?? '' }
  })
  expect(src.bundle.length).toBeGreaterThan(50)

  await signalUnavailable(window)
  let claims = 0
  let auth = ''
  await window.route('**/desk-handoffs/*/claim', async (route) => {
    claims++
    auth = route.request().headers()['authorization'] ?? ''
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ title: 'Handed-over desk', bundle: src.bundle, shareToken: 'T'.repeat(32), kind: 'use', createdAt: new Date().toISOString() })
    })
  })

  // The link arrives before anyone is signed in.
  await app.evaluate(({ app: electronApp }, url) => {
    electronApp.emit('open-url', { preventDefault() {} }, url)
  }, `plexii://desk?handoff=${HANDOFF}`)
  await expect
    .poll(() => window.evaluate(() => (window as unknown as { api: typeof window.api }).api.deskHandoff.pending()))
    .toMatchObject({ id: HANDOFF })
  // Nothing is claimed without a session.
  await window.waitForTimeout(1500)
  expect(claims).toBe(0)

  // Someone signs in: it is claimed once, with their session.
  await window.evaluate(() => {
    const store = (window as unknown as { __fbAccount: { setState: (s: object) => void } }).__fbAccount
    store.setState({
      account: { id: 'acct-e2e-visitor', email: 'visitor@example.com', handle: 'visitor', firstName: 'Sam', lastName: 'Rivera' },
      sessionToken: 'e2e-session-token'
    })
  })
  await expect.poll(() => claims, { timeout: 15_000 }).toBe(1)
  expect(auth).toBe('Bearer e2e-session-token')

  // A second desk of the same name, under a new id, with what was dropped on it.
  await expect
    .poll(
      () =>
        window.evaluate(async (orig: string) => {
          const api = (window as unknown as { api: typeof window.api }).api
          const nodes = (await api.nodes.list()) as Array<{ id: string; title: string }>
          return nodes.some((n) => n.title === 'Handed-over desk' && n.id !== orig)
        }, src.deskId),
      { timeout: 15_000 }
    )
    .toBe(true)
  const copy = await window.evaluate(async (orig: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const nodes = (await api.nodes.list()) as Array<{ id: string; title: string }>
    const c = nodes.find((n) => n.title === 'Handed-over desk' && n.id !== orig)!
    const widgets = (await api.widgets.listByTask(c.id)) as Array<{ id: string; content: string }>
    return { id: c.id, widgetIds: widgets.map((w) => w.id), contents: widgets.map((w) => w.content) }
  }, src.deskId)
  expect(copy.id).not.toBe(src.deskId)
  expect(copy.contents).toEqual(['dropped by the visitor'])
  expect(copy.widgetIds).not.toContain(src.widgetId)

  // It opened, the person was told, and the id is forgotten.
  await expect(window.getByText('“Handed-over desk” is here, with everything you added.')).toBeVisible({ timeout: 10_000 })
  expect(await window.evaluate(() => (window as unknown as { api: typeof window.api }).api.deskHandoff.pending())).toBeNull()
})

test('DH-2 a handoff that is gone is forgotten, and the person is told why', async () => {
  test.setTimeout(60_000)
  launched = await launchApp()
  const { app, window } = launched
  await waitForReady(window)
  await signalUnavailable(window)
  await window.route('**/desk-handoffs/*/claim', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'unknown_handoff' }) })
  )
  await window.evaluate(() => {
    const store = (window as unknown as { __fbAccount: { setState: (s: object) => void } }).__fbAccount
    store.setState({
      account: { id: 'acct-e2e-visitor', email: 'visitor@example.com', handle: 'visitor', firstName: 'Sam', lastName: 'Rivera' },
      sessionToken: 'e2e-session-token'
    })
  })
  await app.evaluate(({ app: electronApp }, url) => {
    electronApp.emit('open-url', { preventDefault() {} }, url)
  }, `plexii://desk?handoff=${HANDOFF}`)
  await expect(window.getByText('That shared desk has expired.', { exact: false })).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(() => window.evaluate(() => (window as unknown as { api: typeof window.api }).api.deskHandoff.pending()))
    .toBeNull()
})
