/**
 * E2E (LIVE, local signal): turning a link off really ends it on the server
 * (4.3.55).
 *
 * Since signal v123 (8 Sept 2026) the server ends a share only for its owner,
 * signed in. Up to 4.3.54 the app's revoke sent no session: the server answered
 * 401, the app listed the link as off anyway, and the link went on opening.
 *
 * 1. Signed in, A makes a read link for a desk in the real share sheet, sees it
 *    open (a view-free ?meta=1 read), turns it off with the sheet's own button,
 *    and the link no longer opens.
 * 2. A link the old app "turned off" (marked off on this computer only, the
 *    server never told) still opens; at the next launch, signed in, the app sends
 *    that revoke again and the link stops opening.
 *
 * HARNESS: as syncDeletesToTrashLive.spec.ts (a local signal, the tls-proxy in
 * front of it, a bundle built against the proxy); self-skips without
 * CRDT_LIVE_PROXY_BASE and CRDT_LIVE_API_BASE. Rebuild out/ for production
 * afterwards.
 */
import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PROXY_BASE, API_BASE, launch, dismissOnboarding, signUp, signIn, clearScrims, type Launched } from './support/liveSignal'

test.beforeAll(async () => {
  test.skip(!PROXY_BASE || !API_BASE, 'CRDT_LIVE_PROXY_BASE / CRDT_LIVE_API_BASE not set (see the header).')
})

// The test process reads the plain-http port: no TLS to relax, and ?meta=1 counts no view.
const opens = async (token: string): Promise<number> => (await fetch(`${API_BASE}/share/${encodeURIComponent(token)}?meta=1`)).status

// A read link for a new desk, made in the real share sheet. Returns its token.
async function makeReadLink(w: Page, title: string): Promise<string> {
  const deskId = await w.evaluate(async (t) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.nodes.create({ parentId: null, kind: 'task', title: t })).id
  }, title)
  await w.reload()
  await dismissOnboarding(w)
  await clearScrims(w, 'A')
  await w.locator('[data-testid="desk-sidebar"]').getByRole('button', { name: 'All desks', exact: true }).click()
  const card = w.locator(`[data-testid="index-card-${deskId}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await card.locator('button[title="Create a public link — anyone with it can view this desk"]').click()
  await w.locator('[data-testid="share-audience-link"]').click()
  await w.getByRole('radio', { name: /A snapshot they can read/ }).click()
  await w.locator('[data-testid="share-create-link"]').click()
  const url = w.locator('[data-testid="share-url"]')
  await expect(url).toHaveValue(/\/share\//, { timeout: 30_000 })
  const text = await url.inputValue()
  const token = /\/share\/([A-Za-z0-9_-]+)/.exec(text)?.[1]
  expect(token, `a token in "${text}"`).toBeTruthy()
  await expect.poll(() => opens(token!), { message: 'the new link opens', timeout: 30_000 }).toBe(200)
  return token!
}

test('a read link turned off in the share sheet no longer opens', async () => {
  test.setTimeout(300_000)
  const profile = mkdtempSync(join(tmpdir(), 'fb-revoke-'))
  let A: Launched | null = await launch('A', profile)
  try {
    const w = A.window
    await dismissOnboarding(w)
    await signUp(w, `revoke.${Date.now()}@example.com`, 'Test-Account-123!')
    await dismissOnboarding(w)
    await clearScrims(w, 'A')
    const token = await makeReadLink(w, 'Pricing notes')

    // Turned off with the sheet's own button.
    await w.locator('[data-testid="share-revoke-snapshot"]').first().click()
    await expect
      .poll(() => opens(token), { message: 'turned off, it no longer opens', timeout: 20_000 })
      .toBe(404)
    await expect(w.locator('[data-testid="share-error"]'), 'and nothing says it failed').toHaveCount(0)
  } finally {
    await A?.close().catch(() => undefined)
    A = null
    rmSync(profile, { recursive: true, force: true })
  }
})

test('a link the old app only marked off on this computer stops opening at the next launch', async () => {
  test.setTimeout(300_000)
  const profile = mkdtempSync(join(tmpdir(), 'fb-revoke-repair-'))
  const email = `revoke.repair.${Date.now()}@example.com`
  const password = 'Test-Account-123!'
  let A: Launched | null = await launch('A', profile)
  try {
    await dismissOnboarding(A.window)
    await signUp(A.window, email, password)
    await dismissOnboarding(A.window)
    await clearScrims(A.window, 'A')
    const token = await makeReadLink(A.window, 'Old link desk')
    // What the old app's revoke left: marked off on this computer only.
    await A.window.evaluate(async (t) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const row = ((await api.shares.listAll()) as Array<{ id: string; token: string }>).find((r) => r.token === t)
      if (!row) throw new Error('the link is not in the list')
      await api.shares.revoke(row.id)
    }, token)
    expect(await opens(token), 'marked off here, it still opens').toBe(200)
    await A.close()
    A = null

    // The next launch, signed in: the revoke goes again, and lands.
    A = await launch('A', profile)
    await dismissOnboarding(A.window)
    await signIn(A.window, email, password)
    await dismissOnboarding(A.window)
    await expect
      .poll(() => opens(token), { message: 'after the next launch it no longer opens', timeout: 60_000 })
      .toBe(404)
  } finally {
    await A?.close().catch(() => undefined)
    A = null
    rmSync(profile, { recursive: true, force: true })
  }
})

// A link an old app minted SIGNED OUT has no owner on the server. Before a0's
// revoke rescue nobody could end it (a 404 to everyone, while it still opened);
// with the rescue its token alone ends it. LIVE_SIGNAL_REVOKE_RESCUE=1 says the
// local signal has the rescue; without it, the app must keep the link live and
// say once that it still works, never claim it ended.
const RESCUE = process.env.LIVE_SIGNAL_REVOKE_RESCUE === '1'

test(`a link made signed out and marked off here: ${RESCUE ? 'the next launch ends it' : 'it still opens, and the app says so once'}`, async () => {
  test.setTimeout(300_000)
  const profile = mkdtempSync(join(tmpdir(), 'fb-revoke-anon-'))
  const email = `revoke.anon.${Date.now()}@example.com`
  const password = 'Test-Account-123!'
  const token = `anon${Date.now()}${Math.random().toString(36).slice(2, 14)}`
  // Minted with no session, as an app signed out did.
  const minted = await fetch(`${API_BASE}/share`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, kind: 'task', snapshot: { title: 'Old anonymous link' }, fromHandle: 'anonymous', scope: 'view', expiresAt: null })
  })
  expect(minted.status, 'minted signed out').toBe(200)
  expect(await opens(token)).toBe(200)
  let A: Launched | null = await launch('A', profile)
  try {
    await dismissOnboarding(A.window)
    await signUp(A.window, email, password)
    await dismissOnboarding(A.window)
    await clearScrims(A.window, 'A')
    // On this computer: the link's row, marked off by the old app.
    await A.window.evaluate(async (t) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const row = await api.shares.create({ token: t, kind: 'task', entityId: 'desk_old', label: 'Old anonymous link', scope: 'view', expiresAt: null, createdBy: null })
      await api.shares.revoke(row.id)
    }, token)
    await A.close()
    A = null

    A = await launch('A', profile)
    await dismissOnboarding(A.window)
    await signIn(A.window, email, password)
    if (RESCUE) {
      await expect.poll(() => opens(token), { message: 'the rescue lets the next launch end it', timeout: 60_000 }).toBe(404)
    } else {
      await expect(A.window.getByText(/1 link you turned off still works/), 'said, once').toBeVisible({ timeout: 30_000 })
      expect(await opens(token), 'and it really does still open').toBe(200)
    }
  } finally {
    await A?.close().catch(() => undefined)
    A = null
    rmSync(profile, { recursive: true, force: true })
  }
})
