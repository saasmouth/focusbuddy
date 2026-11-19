/**
 * E2E (LIVE, local signal): signing in must never damage server data.
 *
 * Found 2026-11-19 in a 4.3.51 smoke run. On every sign-in and reconnect the
 * signal server replays each CRDT partition's WHOLE log (crdtJoin →
 * changeEventsSince(pk, 0)). Up to 4.3.50 the client applied every replayed
 * event through the user-facing IPC, which marks the row dirty, so the poll
 * then pushed replayed state back to the server:
 *
 *   (a) a replayed row with sync_rev 0 was PUT with no baseRev (a force-write),
 *       overwriting the live server copy with state rebuilt from the log;
 *   (b) a row the server had tombstoned outside the CRDT channel was
 *       force-written back to life;
 *   (c) a desk or widget brought back with Undo (restores emit no CRDT event,
 *       so the log still ends "delete") was re-trashed by the replay and a
 *       DELETE with no baseRev tombstoned it for every device — on a NEW device
 *   (d) and the same on an EXISTING device, at its next sign-in;
 *   (e) a fresh device's pull stalled on rows whose parent sorted into a later
 *       page and, after three cycles, moved its cursor past them for good.
 *
 * The test seeds an account on device A, snapshots the server, then signs in a
 * fresh device B and finally re-signs-in A, and asserts after each that the
 * server is exactly as A left it and B has every live row. It also asserts the
 * CRDT-only kind (widget links) still reaches B, so a fix that drops the replay
 * cannot pass by losing wires.
 *
 * HARNESS (self-skips unless CRDT_LIVE_PROXY_BASE and CRDT_LIVE_API_BASE are set):
 *
 *   cd focusbuddy-signal && npm run build && \
 *     PORT=8811 DB_PATH=<fresh>.db SYNC_LEGACY_PAGE_LIMIT=10 SYNC_PAGE_LIMIT=10 node dist/server.js
 *   node tests/e2e/support/tls-proxy.js 8812 8811
 *   VITE_USE_REMOTE_SIGNAL=true VITE_SIGNAL_HTTP_URL=https://localhost:8812 \
 *     VITE_SIGNAL_WS_URL=wss://localhost:8812/ws npm run build
 *   CRDT_LIVE_PROXY_BASE=https://localhost:8812 CRDT_LIVE_API_BASE=http://localhost:8811 \
 *     npx playwright test tests/e2e/crdtReplayNoDataLossLive.spec.ts
 *
 * The small page limits make a small seeded account page the way a large real
 * one does (the legacy pull's cap is 5,000 rows in production).
 *
 * Rebuild out/ against production afterwards: a bundle pointed at localhost
 * fails every other e2e run on this Mac.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchGuarded } from './_netGuard'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PROXY_BASE = process.env.CRDT_LIVE_PROXY_BASE
const API_BASE = process.env.CRDT_LIVE_API_BASE

test.beforeAll(async () => {
  test.skip(
    !PROXY_BASE || !API_BASE,
    'CRDT_LIVE_PROXY_BASE / CRDT_LIVE_API_BASE not set: needs a local signal server and a bundle pointed at it (see header).'
  )
})

interface Launched {
  app: ElectronApplication
  window: Page
  log: string[]
  close: () => Promise<void>
}

async function launch(label: string, userDataDir: string): Promise<Launched> {
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE
  delete cleanEnv.ANTHROPIC_API_KEY
  const { app } = await launchGuarded({
    args: ['--ignore-certificate-errors', '.'],
    cwd: process.cwd(),
    env: { ...cleanEnv, FB_TEST_USER_DATA: userDataDir, NODE_ENV: 'test' },
    timeout: 20_000
  })
  const log: string[] = []
  const keep = (b: Buffer): void => {
    for (const line of b.toString().split('\n')) if (line.trim()) log.push(line)
  }
  app.process().stdout?.on('data', keep)
  app.process().stderr?.on('data', keep)
  const window = await app.firstWindow()
  // The pull's own warnings ("holding the cursor", "moving past them") are renderer
  // console lines, not main-process output.
  window.on('console', (m) => log.push(`[renderer] ${m.text()}`))
  await window.waitForLoadState('domcontentloaded')
  async function close(): Promise<void> {
    try {
      await Promise.race([app.close(), new Promise<void>((_, r) => setTimeout(() => r(new Error('t')), 8_000))])
    } catch {
      try {
        app.process().kill()
      } catch {
        /* already gone */
      }
    }
  }
  return { app, window, log, close }
}

async function dismissOnboarding(window: Page): Promise<void> {
  await window.waitForFunction(() => typeof (window as unknown as { api?: unknown }).api === 'object', null, {
    timeout: 15_000
  })
  await expect(window.locator('[data-testid="footer-sync-chip"]')).toBeVisible({ timeout: 15_000 })
  const onb = window.locator('[role="dialog"][aria-label="Welcome to PlexiiDesk"]')
  if (await onb.isVisible().catch(() => false)) {
    await window.getByRole('button', { name: 'Get started' }).click().catch(() => {})
    await window.locator('[data-testid="onboarding-key-skip"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-tour-continue"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-start-blank"]').click().catch(() => {})
  }
}

async function clearVerifyEmail(window: Page): Promise<void> {
  // A fresh account is offered "Verify your email" a beat after sign-up, and its
  // scrim swallows clicks. "Later" dismisses it.
  const later = window.locator('[data-testid="verify-email-later"]')
  if (await later.isVisible({ timeout: 3_000 }).catch(() => false)) await later.click().catch(() => {})
}

// Close whatever modal has arrived over the app (a fresh account collects a few a
// beat after sign-up), logging each by name so a new one is easy to recognise.
async function clearScrims(window: Page, label: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    if ((await window.locator('.fb-scrim').count()) === 0) return
    const names = await window
      .locator('[role="dialog"], [role="alertdialog"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || (e.textContent ?? '').trim().slice(0, 60)))
    console.log(`[REPLAY] ${label}: closing modal ${JSON.stringify(names)}`)
    const later = window.locator('[data-testid="verify-email-later"]')
    if (await later.isVisible().catch(() => false)) await later.click().catch(() => {})
    else await window.keyboard.press('Escape')
    await window.waitForTimeout(400)
  }
  await expect(window.locator('.fb-scrim'), `${label}: a modal would not close`).toHaveCount(0)
}

const signInDialog = (w: Page) => w.locator('[role="dialog"][aria-label="Sign in to PlexiiDesk"]')

async function signUp(window: Page, email: string, password: string): Promise<void> {
  const d = signInDialog(window)
  await expect(d).toBeVisible({ timeout: 15_000 })
  await window.getByRole('button', { name: 'Sign up' }).click()
  await window.getByPlaceholder('you@example.com').fill(email)
  // Names are required at sign-up since 4.3.41.
  await window.locator('[data-testid="signup-first-name"]').fill('Replay')
  await window.locator('[data-testid="signup-last-name"]').fill('Tester')
  await window.getByPlaceholder('at least 8 characters').fill(password)
  await window.getByRole('button', { name: 'Create account' }).click()
  await expect(d).not.toBeVisible({ timeout: 15_000 })
  await clearVerifyEmail(window)
}

async function signIn(window: Page, email: string, password: string): Promise<void> {
  const d = signInDialog(window)
  await expect(d).toBeVisible({ timeout: 15_000 })
  await d.getByRole('button', { name: 'Log in', exact: true }).first().click()
  await window.getByPlaceholder('you@example.com').fill(email)
  await window.getByPlaceholder(/password|at least 8/i).first().fill(password)
  await d.locator('button[type="submit"]').click()
  await expect(d).not.toBeVisible({ timeout: 15_000 })
  await clearVerifyEmail(window)
}

interface ServerItem {
  id: string
  itemType: string
  rev: number
  deleted: boolean
  body: Record<string, unknown> | null
}

// The server's view, read by the test process over plain http with paging, so it
// is complete whatever the page limit.
async function serverSnapshot(token: string): Promise<Map<string, ServerItem>> {
  const out = new Map<string, ServerItem>()
  let cursor: string | null = null
  for (let guard = 0; guard < 500; guard++) {
    const qs = new URLSearchParams({ since: '0', limit: '200' })
    if (cursor) qs.set('cursor', cursor)
    const res = await fetch(`${API_BASE}/workspace/sync?${qs}`, { headers: { Authorization: `Bearer ${token}` } })
    expect(res.ok, `GET /workspace/sync ${res.status}`).toBe(true)
    const json = (await res.json()) as { items: ServerItem[]; more?: boolean; nextCursor?: string | null }
    for (const it of json.items) out.set(it.id, it)
    if (!json.more || !json.nextCursor) return out
    cursor = json.nextCursor
  }
  throw new Error('server snapshot did not finish paging')
}

// Every server row whose rev or deleted flag moved between two snapshots.
// `labels` names the seeded items, so a failure reads "desk R" rather than a uuid.
function serverChanges(
  before: Map<string, ServerItem>,
  after: Map<string, ServerItem>,
  labels: Map<string, string> = new Map()
): string[] {
  const out: string[] = []
  for (const [id, a] of after) {
    const b = before.get(id)
    const name = `${a.itemType} ${labels.get(id) ?? id}`
    const title = (x: ServerItem | undefined) => (x?.body as { title?: string } | null)?.title
    const retitled = b && title(b) !== title(a) ? ` title "${title(b)}"->"${title(a)}"` : ''
    if (!b) out.push(`NEW ${name} rev ${a.rev}${a.deleted ? ' (deleted)' : ''}`)
    else if (a.rev !== b.rev || a.deleted !== b.deleted)
      out.push(`${name} rev ${b.rev}->${a.rev}${b.deleted !== a.deleted ? ` deleted ${b.deleted}->${a.deleted}` : ''}${retitled}`)
  }
  return out
}

type Api = { api: typeof window.api }

async function pendingCount(window: Page): Promise<number> {
  return window.evaluate(async () => {
    const p = await (window as unknown as Api).api.workspaceSync.pending()
    return p.upserts.length + p.deletes.length
  })
}

async function waitQuiet(window: Page, ms: number): Promise<void> {
  // Wait for the device's own poll pushes to land. Its CRDT events go out live
  // over the open socket as they are emitted; the local outbox only marks them
  // synced at the next (re)connect flush, so its count is not a delivery signal.
  const start = Date.now()
  for (;;) {
    const pending = await pendingCount(window)
    if (pending === 0) break
    if (Date.now() - start > ms) throw new Error(`device never went quiet: ${pending} rows still pending push`)
    await new Promise((r) => setTimeout(r, 1_000))
  }
  await new Promise((r) => setTimeout(r, 3_000))
}

// Watch a device for `ms`: the most rows it ever held pending push (it makes no
// edits of its own, so every pending row is replayed state), sampled every 1.5 s.
async function watchPending(window: Page, ms: number): Promise<number> {
  let max = 0
  const start = Date.now()
  while (Date.now() - start < ms) {
    max = Math.max(max, await pendingCount(window).catch(() => 0))
    await new Promise((r) => setTimeout(r, 1_500))
  }
  return max
}

const fkFailures = (log: string[]): number => log.filter((l) => /\[ipc\] widgets:create failed/.test(l)).length

test.describe.configure({ mode: 'serial' })

test('signing in on a new device, then again on an existing one, leaves the server exactly as it was', async () => {
  test.setTimeout(540_000)
  const rand = Date.now()
  const email = `crdt.replay.${rand}@example.com`
  const password = 'Test-Account-123!'
  const profileA = mkdtempSync(join(tmpdir(), 'fb-replay-A-'))
  const profileB = mkdtempSync(join(tmpdir(), 'fb-replay-B-'))
  let A: Launched | null = await launch('A', profileA)
  let B: Launched | null = null
  try {
    // ── Device A: sign up and seed ─────────────────────────────────────────────
    await dismissOnboarding(A.window)
    await signUp(A.window, email, password)
    await dismissOnboarding(A.window)
    // Seed past the Free plan's desk limit (the limit is not what is under test).
    await A.window.evaluate(() => {
      const caps = (window as unknown as {
        __fbCapabilities?: { getState: () => { capabilities: Record<string, unknown> }; setState: (p: unknown) => void }
      }).__fbCapabilities
      caps?.setState({ capabilities: { ...caps.getState().capabilities, multiple_desks: true } })
    })
    const seed = await A.window.evaluate(async () => {
      type Store<T> = { getState: () => T }
      const w = window as unknown as {
        __fbNodes: Store<{ create: (d: unknown) => Promise<{ id: string }>; update: (id: string, p: unknown) => Promise<void> }>
        __fbWidgets: Store<{ create: (d: unknown) => Promise<{ id: string }> }>
        __fbLinks: Store<{ create: (s: string, t: string, task: string, type?: string) => Promise<{ id: string } | null> }>
      }
      const nodes = w.__fbNodes.getState()
      const folder = await nodes.create({ parentId: null, kind: 'folder', title: 'Replay folder' })
      const desks: string[] = []
      for (let i = 1; i <= 4; i++) {
        const d = await nodes.create({ parentId: i <= 2 ? folder.id : null, kind: 'task', title: `Replay desk ${i}` })
        desks.push(d.id)
      }
      const widgets: Record<string, string[]> = {}
      for (const d of desks) {
        widgets[d] = []
        for (let j = 0; j < 6; j++) {
          const wd = await w.__fbWidgets
            .getState()
            .create({ taskId: d, kind: 'sticky', content: `note ${j}`, x: 40 + j * 30, y: 40 + j * 30, width: 200, height: 140 })
          widgets[d].push(wd.id)
        }
      }
      // A wire: the kind that reaches other devices ONLY through the CRDT replay.
      const link = await w.__fbLinks.getState().create(widgets[desks[0]][0], widgets[desks[0]][1], desks[0], 'note')
      // (c) desk R, to be deleted and brought back with Undo.
      const r = await nodes.create({ parentId: null, kind: 'task', title: 'Restored desk R' })
      const rWidget = await w.__fbWidgets.getState().create({ taskId: r.id, kind: 'sticky', content: 'on R', x: 60, y: 60, width: 200, height: 140 })
      // (b) desk Z, deleted below once the server has it.
      const z = await nodes.create({ parentId: null, kind: 'task', title: 'Deleted desk Z' })
      return { folder: folder.id, desks, widgets, link: link?.id ?? null, r: r.id, rWidget: rWidget.id, z: z.id }
    })
    expect(seed.link, 'the seed wire was created').not.toBeNull()
    await waitQuiet(A.window, 90_000)

    // (b) Writes that bypass the CRDT channel, as every pre-flag build and the
    // main-side cascades do, so the log never hears of them:
    //   Z  — deleted after the server has it: the server holds a tombstone, the
    //        log only Z's create;
    //   Z2 — created through the store and deleted before its first push: the
    //        server never has it, the log has its create;
    //   desk 4 renamed: the server holds the new title, the log the old one (a).
    const z2 = await A.window.evaluate(async ([zId, d4]) => {
      const api = (window as unknown as Api).api
      await api.nodes.delete(zId)
      await api.nodes.update(d4, { title: 'Renamed outside CRDT' })
      const nodes = (window as unknown as { __fbNodes: { getState: () => { create: (d: unknown) => Promise<{ id: string }> } } }).__fbNodes
      const n = await nodes.getState().create({ parentId: null, kind: 'task', title: 'Never-synced desk Z2' })
      await api.nodes.delete(n.id)
      return n.id
    }, [seed.z, seed.desks[3]] as const)

    // (c) delete desk R through the store, then Undo it from the toast — the
    // user's real path. Same for one widget on desk 3.
    await clearScrims(A.window, 'A before undo')
    await A.window.evaluate(async (id) => {
      const nodes = (window as unknown as { __fbNodes: { getState: () => { remove: (id: string) => Promise<void> } } }).__fbNodes
      await nodes.getState().remove(id)
    }, seed.r)
    await A.window.locator('[data-testid="undo-toast-undo"]').click({ timeout: 10_000 })
    const restoredWidget = seed.widgets[seed.desks[2]][0]
    await clearScrims(A.window, 'A before widget undo')
    await A.window.evaluate(async (id) => {
      const ws = (window as unknown as { __fbWidgets: { getState: () => { remove: (id: string) => Promise<void> } } }).__fbWidgets
      await ws.getState().remove(id)
    }, restoredWidget)
    await A.window.locator('[data-testid="undo-toast-undo"]').click({ timeout: 10_000 })
    await A.window.evaluate(() => (window as unknown as { __fbNodes: { getState: () => { refresh: () => Promise<void> } } }).__fbNodes.getState().refresh())

    // Let A push everything and flush its CRDT outbox.
    await new Promise((r) => setTimeout(r, 2_000))
    await waitQuiet(A.window, 90_000)
    const token = await A.window.evaluate(
      () => (window as unknown as { __fbAccount: { getState: () => { sessionToken: string | null } } }).__fbAccount.getState().sessionToken
    )
    expect(token, 'A is signed in').toBeTruthy()

    const s0 = await serverSnapshot(token!)
    const labels = new Map<string, string>([
      [seed.folder, "folder"],
      ...seed.desks.map((d, i) => [d, `desk ${i + 1}`] as [string, string]),
      [seed.r, "desk R (deleted, then Undo)"],
      [seed.z, "desk Z (deleted outside CRDT)"],
      [z2, "desk Z2 (never synced)"],
      [restoredWidget, "widget W (deleted, then Undo)"]
    ])
    const live0 = [...s0.values()].filter((i) => !i.deleted)
    console.log(`[REPLAY] server after seeding: ${s0.size} items, ${live0.length} live`)
    // The seed is what the scenarios need it to be.
    expect(s0.get(seed.r)?.deleted, 'R is live after Undo').toBe(false)
    expect(s0.get(restoredWidget)?.deleted, 'the restored widget is live after Undo').toBe(false)
    expect(s0.get(seed.z)?.deleted, 'Z is tombstoned on the server').toBe(true)
    expect(s0.has(z2), 'Z2 never reached the server').toBe(false)
    expect((s0.get(seed.desks[3])?.body as { title?: string } | null)?.title).toBe('Renamed outside CRDT')
    await A.close()
    A = null

    // ── Device B: a new computer signs in ────────────────────────────────────
    B = await launch('B', profileB)
    await dismissOnboarding(B.window)
    await signIn(B.window, email, password)
    // Long enough for the replay, the create-retry budget (~60 s) and several
    // 20 s poll cycles, each of which pushes before it pulls.
    const maxPendingB = await watchPending(B.window, 85_000)
    const s1 = await serverSnapshot(token!)
    const changedByB = serverChanges(s0, s1, labels)
    console.log(`[REPLAY] B max pending ${maxPendingB}; FK failures ${fkFailures(B.log)}; server changes ${changedByB.length}`)
    for (const c of changedByB.slice(0, 40)) console.log(`[REPLAY]   B changed ${c}`)

    // What B holds locally. (e) B must END with every live row; how long that
    // takes depends on the page size, so wait for it (bounded) and say how long
    // it took and whether the pull ever gave up on rows.
    const readLocal = () =>
      B!.window.evaluate(async (ids) => {
        const api = (window as unknown as Api).api
        const nodes = (await api.nodes.list()) as Array<{ id: string; trashedAt?: number | null }>
        const liveNode = (id: string) => nodes.some((n) => n.id === id && !n.trashedAt)
        const widgetIds = new Set<string>()
        for (const d of ids.desks) for (const w of (await api.widgets.listByTask(d)) as Array<{ id: string }>) widgetIds.add(w.id)
        const links = (await api.widgetLinks.listByTask(ids.desk0)) as Array<{ id: string }>
        return {
          nodes: Object.fromEntries(ids.allNodes.map((id) => [id, liveNode(id)])) as Record<string, boolean>,
          widgets: [...widgetIds],
          link: links.some((l) => l.id === ids.link)
        }
      }, {
        desks: [...seed.desks, seed.r],
        desk0: seed.desks[0],
        link: seed.link,
        allNodes: [seed.folder, ...seed.desks, seed.r, seed.z, z2]
      })
    const liveNodeIds = [seed.folder, ...seed.desks, seed.r].filter((id) => s1.get(id) && !s1.get(id)!.deleted)
    const liveWidgetIds = [...s1.values()].filter((i) => i.itemType === 'widget' && !i.deleted).map((i) => i.id)
    const completeAt = Date.now()
    let local = await readLocal()
    const isComplete = (l: typeof local) =>
      liveNodeIds.every((id) => l.nodes[id]) && liveWidgetIds.every((id) => l.widgets.includes(id))
    while (!isComplete(local) && Date.now() - completeAt < 120_000) {
      await new Promise((r) => setTimeout(r, 5_000))
      local = await readLocal()
    }
    const syncNotes = B.log.filter((l) => /\[sync\] .*(holding the cursor|moving past)/.test(l))
    console.log(
      `[REPLAY] B complete: ${isComplete(local)} (${Math.round((Date.now() - completeAt) / 1000)} s after the watch); ` +
        `pull held ${syncNotes.filter((l) => /holding/.test(l)).length}×, gave up ${syncNotes.filter((l) => /moving past/.test(l)).length}×`
    )

    // (a)(b)(c) on a NEW device: the server is exactly as A left it.
    expect.soft(changedByB, 'signing in on a new device changed nothing on the server').toEqual([])
    expect.soft(s1.get(seed.r)?.deleted, '(c) desk R stays live').toBe(false)
    expect.soft(s1.get(restoredWidget)?.deleted, '(c) the restored widget stays live').toBe(false)
    expect.soft(s1.get(seed.z)?.deleted, '(b) desk Z stays deleted').toBe(true)
    expect.soft(s1.has(z2), '(b) desk Z2 is not created on the server').toBe(false)
    expect.soft((s1.get(seed.desks[3])?.body as { title?: string } | null)?.title, '(a) the rename survives').toBe(
      'Renamed outside CRDT'
    )
    // B makes no edits, so it must never queue replayed rows for push.
    expect.soft(maxPendingB, 'B queued replayed rows for push').toBe(0)
    // (e) B ends with every live row: all live desks, and every live widget.
    for (const id of liveNodeIds) expect.soft(local.nodes[id], `(e) B has live node ${labels.get(id) ?? id}`).toBe(true)
    expect.soft(local.nodes[seed.z], 'B does not show deleted desk Z').toBe(false)
    expect.soft(local.nodes[z2], 'B does not show deleted desk Z2').toBe(false)
    const missing = liveWidgetIds.filter((id) => !local.widgets.includes(id))
    if (missing.length) {
      // Say where the missing rows are, so a pull gap reads as one.
      const byDesk = new Map<string, number>()
      for (const id of missing) {
        const body = s1.get(id)?.body as { taskId?: string; task_id?: string } | null
        const desk = String(body?.task_id ?? body?.taskId ?? '?')
        byDesk.set(desk, (byDesk.get(desk) ?? 0) + 1)
      }
      console.log(`[REPLAY] B is missing ${missing.length} live widgets: ${[...byDesk].map(([d, n]) => `${labels.get(d) ?? d} ×${n}`).join(', ')}`)
      for (const l of B.log.filter((x) => /\[sync\]/.test(x)).slice(-25)) console.log(`[REPLAY]   B log: ${l.slice(0, 200)}`)
    }
    expect.soft(missing, '(e) B has every live widget').toEqual([])
    expect.soft(syncNotes.filter((l) => /moving past/.test(l)), '(e) the pull never gave up on rows').toEqual([])
    // The CRDT-only kind still arrives.
    expect.soft(local.link, 'the wire reached B').toBe(true)
    // No create storm.
    expect.soft(fkFailures(B.log), 'widgets:create FK failures on B').toBeLessThan(25)
    await B.close()
    B = null

    // ── (d) Device A again: an existing device signs in at its next launch ───
    A = await launch('A2', profileA)
    await dismissOnboarding(A.window)
    await signIn(A.window, email, password)
    const maxPendingA = await watchPending(A.window, 50_000)
    const s2 = await serverSnapshot(token!)
    const changedByA = serverChanges(s1, s2, labels)
    console.log(`[REPLAY] A relaunch max pending ${maxPendingA}; server changes ${changedByA.length}`)
    for (const c of changedByA.slice(0, 40)) console.log(`[REPLAY]   A changed ${c}`)
    expect.soft(changedByA, 'signing in again on an existing device changed nothing on the server').toEqual([])
    expect.soft(s2.get(seed.r)?.deleted, '(d) desk R stays live').toBe(false)
    expect.soft(s2.get(restoredWidget)?.deleted, '(d) the restored widget stays live').toBe(false)
    expect.soft(maxPendingA, 'A queued replayed rows for push').toBe(0)
  } finally {
    await B?.close()
    await A?.close()
    rmSync(profileA, { recursive: true, force: true })
    rmSync(profileB, { recursive: true, force: true })
  }
})
