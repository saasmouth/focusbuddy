/**
 * E2E (LIVE, local signal): a delete made on another device lands in this
 * device's Trash, recoverable (4.3.55; the 16 Nov case).
 *
 * Two fresh devices on one account. Device A deletes; device B shows it and
 * brings it back, and A gets it back:
 *
 *   1. a widget on the desk B has open, deleted on A as a person does (the
 *      store: CRDT event and poll): B says so in the house notice and lights the
 *      Trash dot; the notice's Restore puts it back on B, on the server and on A;
 *   2. a desk deleted on A: B's Trash lists it, labelled "Deleted on another
 *      device"; Restore there puts it back on A;
 *   3. a Drive folder deleted on A (poll only): B's Trash lists it under
 *      "Deleted elsewhere"; Restore puts it back on A;
 *   4. Delete for good on B removes B's copy and sends nothing: the server's
 *      tombstone keeps its rev and A's own Trash is untouched.
 *
 * HARNESS: as crdtReplayNoDataLossLive.spec.ts (local signal on 8811, the
 * tls-proxy on 8812, a bundle built against it); self-skips without
 * CRDT_LIVE_PROXY_BASE and CRDT_LIVE_API_BASE. Rebuild out/ for production
 * afterwards.
 */
import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  PROXY_BASE,
  API_BASE,
  launch,
  dismissOnboarding,
  signUp,
  signIn,
  clearScrims,
  serverSnapshot,
  waitQuiet,
  type Api,
  type Launched
} from './support/liveSignal'

test.beforeAll(async () => {
  test.skip(!PROXY_BASE || !API_BASE, 'CRDT_LIVE_PROXY_BASE / CRDT_LIVE_API_BASE not set (see the header).')
})
test.describe.configure({ mode: 'serial' })

type Store<T> = { getState: () => T }
async function until<T>(label: string, read: () => Promise<T>, ok: (v: T) => boolean, ms = 60_000): Promise<T> {
  const start = Date.now()
  let last: T
  for (;;) {
    last = await read()
    if (ok(last)) return last
    if (Date.now() - start > ms) throw new Error(`${label}: never happened (last ${JSON.stringify(last)})`)
    await new Promise((r) => setTimeout(r, 1_000))
  }
}
// Live on that device's desk: listByTask lists only widgets not in the Trash. (A
// widget read by id carries no trash time, so it cannot say this.)
const liveOn = (w: Page, deskId: string, id: string): Promise<boolean> =>
  w.evaluate(
    async ([d, wid]) => ((await (window as unknown as Api).api.widgets.listByTask(d)) as Array<{ id: string }>).some((x) => x.id === wid),
    [deskId, id] as const
  )
const tokenOf = (w: Page) =>
  w.evaluate(() => (window as unknown as { __fbAccount: Store<{ sessionToken: string | null }> }).__fbAccount.getState().sessionToken)

test('a delete from another device is in the Trash, said once on the open desk, and comes back everywhere', async () => {
  test.setTimeout(600_000)
  const email = `trash.elsewhere.${Date.now()}@example.com`
  const password = 'Test-Account-123!'
  const profileA = mkdtempSync(join(tmpdir(), 'fb-trash-A-'))
  const profileB = mkdtempSync(join(tmpdir(), 'fb-trash-B-'))
  let A: Launched | null = await launch('A', profileA)
  let B: Launched | null = null
  try {
    await dismissOnboarding(A.window)
    await signUp(A.window, email, password)
    await dismissOnboarding(A.window)
    await clearScrims(A.window, 'A')
    const seed = await A.window.evaluate(async () => {
      const w = window as unknown as {
        __fbCapabilities?: Store<{ capabilities: Record<string, unknown> }> & { setState: (p: unknown) => void }
        __fbNodes: Store<{ create: (d: unknown) => Promise<{ id: string }> }>
        __fbWidgets: Store<{ create: (d: unknown) => Promise<{ id: string }> }>
      }
      const grant = (): void => {
        const caps = w.__fbCapabilities
        caps?.setState({ capabilities: { ...caps.getState().capabilities, multiple_desks: true } })
      }
      grant()
      const desk = await w.__fbNodes.getState().create({ parentId: null, kind: 'task', title: 'Launch plan' })
      grant()
      const spare = await w.__fbNodes.getState().create({ parentId: null, kind: 'task', title: 'Spare desk' })
      const budget = await w.__fbWidgets
        .getState()
        .create({ taskId: desk.id, kind: 'sticky', title: 'Budget', content: 'numbers', x: 40, y: 40, width: 200, height: 140 })
      const scratch = await w.__fbWidgets
        .getState()
        .create({ taskId: desk.id, kind: 'sticky', title: 'Scratch', content: 'old', x: 300, y: 40, width: 200, height: 140 })
      const folder = await (window as unknown as Api).api.fileManager.createFolder(null, 'Receipts')
      return { desk: desk.id, spare: spare.id, budget: budget.id, scratch: scratch.id, folder: folder.id }
    })
    await waitQuiet(A.window, 90_000)
    const token = await tokenOf(A.window)
    expect(token, 'A is signed in').toBeTruthy()

    // ── Device B: sign in, have everything, open the desk ──────────────────────
    B = await launch('B', profileB)
    await dismissOnboarding(B.window)
    await signIn(B.window, email, password)
    await dismissOnboarding(B.window)
    await clearScrims(B.window, 'B')
    await until('B has the widgets', () => liveOn(B!.window, seed.desk, seed.scratch), (live) => live, 120_000)
    await B.window.evaluate((id) => (window as unknown as { __fbView: Store<{ goTask: (id: string) => void }> }).__fbView.getState().goTask(id), seed.desk)
    await until(
      'B shows the desk',
      () => B!.window.evaluate(() => (window as unknown as { __fbWidgets: Store<{ widgets: Array<{ id: string }> }> }).__fbWidgets.getState().widgets.map((x) => x.id)),
      (ids) => ids.includes(seed.budget)
    )

    // ── 1. A deletes the widget, as a person does ─────────────────────────────
    await A.window.evaluate((id) => (window as unknown as { __fbWidgets: Store<{ remove: (id: string) => Promise<void> }> }).__fbWidgets.getState().remove(id), seed.budget)
    await until('A deleted it', () => liveOn(A!.window, seed.desk, seed.budget), (live) => !live, 10_000)
    const notice = B.window.getByText('“Budget” was deleted on another device.')
    await expect(notice, 'B says so, once').toBeVisible({ timeout: 30_000 })
    await expect(B.window.locator('[data-testid="trash-dot"]').first(), 'and the Trash has its dot').toBeAttached()
    await B.window.getByRole('button', { name: 'Restore', exact: true }).click()
    await until('the widget is back on B', () => liveOn(B!.window, seed.desk, seed.budget), (live) => live, 20_000)
    await waitQuiet(B.window, 60_000)
    await until('the server has it live', async () => (await serverSnapshot(token!)).get(seed.budget)?.deleted, (d) => d === false, 60_000)
    await until('A has it back', () => liveOn(A!.window, seed.desk, seed.budget), (live) => live, 90_000)

    // ── 2. A deletes a desk: B's Trash lists it, labelled; Restore there ──────
    await A.window.evaluate((id) => (window as unknown as { __fbNodes: Store<{ remove: (id: string) => Promise<void> }> }).__fbNodes.getState().remove(id), seed.spare)
    await waitQuiet(A.window, 60_000)
    await until(
      'B has the desk in its Trash, deleted elsewhere',
      () => B!.window.evaluate(async () => (await (window as unknown as Api).api.nodes.listTrash()) as Array<{ id: string; deletedElsewhere: boolean }>),
      (list) => list.some((e) => e.id === seed.spare && e.deletedElsewhere),
      90_000
    )
    await B.window.evaluate(() => (window as unknown as { __fbView: Store<{ goTrash: () => void }> }).__fbView.getState().goTrash())
    const deskRow = B.window.locator(`[data-testid="trash-row-${seed.spare}"]`)
    await expect(deskRow).toContainText('Deleted on another device')
    await expect(B.window.locator('[data-testid="trash-dot"]'), 'opening the Trash clears the dot').toHaveCount(0)
    await deskRow.getByRole('button', { name: 'Restore' }).click()
    await waitQuiet(B.window, 60_000)
    await until(
      'A has the desk back',
      () => A!.window.evaluate(async (id) => ((await (window as unknown as Api).api.nodes.listTrash()) as Array<{ id: string }>).some((e) => e.id === id), seed.spare),
      (inTrash) => !inTrash,
      90_000
    )

    // ── 3. A deletes a Drive folder (poll only): B lists and restores it ──────
    await A.window.evaluate((id) => (window as unknown as Api).api.fileManager.delete(id), seed.folder)
    await waitQuiet(A.window, 60_000)
    await B.window.evaluate(() => (window as unknown as { __fbView: Store<{ goHome?: () => void; goTrash: () => void }> }).__fbView.getState().goTrash())
    const folderRow = B.window.locator(`[data-testid="trash-elsewhere-${seed.folder}"]`)
    await until('B lists the folder', async () => folderRow.count(), (n) => n === 1, 90_000).catch(async () => {
      // The Trash reads its lists when it opens: open it again once the pull has landed.
      await B!.window.evaluate(() => (window as unknown as { __fbView: Store<{ goTask: (id: string) => void }> }).__fbView.getState().goTask('none'))
      await B!.window.evaluate(() => (window as unknown as { __fbView: Store<{ goTrash: () => void }> }).__fbView.getState().goTrash())
      await expect(folderRow).toHaveCount(1, { timeout: 30_000 })
    })
    await expect(folderRow).toContainText('Receipts')
    await folderRow.getByRole('button', { name: 'Restore' }).click()
    await expect(folderRow).toHaveCount(0)
    await waitQuiet(B.window, 60_000)
    await until(
      'A has the folder back',
      () => A!.window.evaluate(async (id) => ((await (window as unknown as Api).api.fileManager.listTrashed()) as Array<{ id: string }>).some((e) => e.id === id), seed.folder),
      (inTrash) => !inTrash,
      90_000
    )

    // ── 4. Delete for good on B sends nothing ─────────────────────────────────
    await A.window.evaluate((id) => (window as unknown as { __fbWidgets: Store<{ remove: (id: string) => Promise<void> }> }).__fbWidgets.getState().remove(id), seed.scratch)
    await waitQuiet(A.window, 60_000)
    const before = await until('the server holds the delete', async () => (await serverSnapshot(token!)).get(seed.scratch), (s) => !!s?.deleted, 60_000)
    await until(
      'B lists the widget',
      () => B!.window.evaluate(async () => (await (window as unknown as Api).api.trash.listDeletedElsewhere()).map((e) => e.id)),
      (ids) => ids.includes(seed.scratch),
      90_000
    )
    await B.window.evaluate(() => (window as unknown as { __fbView: Store<{ goTask: (id: string) => void }> }).__fbView.getState().goTask('none'))
    await B.window.evaluate(() => (window as unknown as { __fbView: Store<{ goTrash: () => void }> }).__fbView.getState().goTrash())
    const scratchRow = B.window.locator(`[data-testid="trash-elsewhere-${seed.scratch}"]`)
    await scratchRow.getByRole('button', { name: 'Delete for good' }).click()
    await B.window.getByRole('button', { name: 'Delete for good' }).last().click()
    await expect(scratchRow).toHaveCount(0)
    await waitQuiet(B.window, 30_000)
    await new Promise((r) => setTimeout(r, 5_000))
    const after = (await serverSnapshot(token!)).get(seed.scratch)
    expect({ deleted: after?.deleted, rev: after?.rev }, 'the server is as A left it').toEqual({ deleted: true, rev: before!.rev })
    expect(await liveOn(A.window, seed.desk, seed.scratch), "A's own delete still stands on A").toBe(false)
    expect(await liveOn(B.window, seed.desk, seed.scratch), 'and B did not bring it back').toBe(false)
  } finally {
    await B?.close()
    await A?.close()
    A = null
    B = null
    rmSync(profileA, { recursive: true, force: true })
    rmSync(profileB, { recursive: true, force: true })
  }
})
