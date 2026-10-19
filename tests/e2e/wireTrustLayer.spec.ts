import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// "Lever 1: the wire trust layer" (plexi-4.0):
//   - Durable wire freshness: widget_links.last_run_at / last_error drive a
//     data-wire-fresh badge attribute (ok | running | disabled | stale |
//     never-run | error) for reactive (transform/mirror) wires. A plain
//     context wire has no freshness at all (attribute absent).
//   - Durable wire run history: a wire_runs row is recorded on every
//     transform/mirror write into a TEXT target, capturing prevContent /
//     nextContent. The WireEditor's "Recent activity" section lists these and
//     offers a one-click "Revert this write" that restores the target's
//     content from prevContent.
//
// Driven via window.api / the exposed __fbWidgets store handle for
// deterministic content edits (a mirror wire — no AI key needed) plus real
// UI clicks for the badge / WireEditor / revert button.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

interface Seeded {
  taskId: string
  aId: string
  bId: string
  cId: string
  linkId: string
  contextLinkId: string
}

// Seeds a task with three stickies (A, B, C), a mirror wire A->B, and a plain
// context wire B->C (for the "context wires have no freshness" assertion).
async function seed(window: Page): Promise<Seeded> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Wire trust layer' })
    const a = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'A',
      content: 'v0',
      x: 120,
      y: 160,
      width: 220,
      height: 180
    })
    const b = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'B',
      content: '',
      x: 520,
      y: 160,
      width: 220,
      height: 180
    })
    const c = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'C',
      content: '',
      x: 920,
      y: 160,
      width: 220,
      height: 180
    })
    const link = await api.widgetLinks.create(a.id, b.id, task.id)
    await api.widgetLinks.update(link!.id, { type: 'mirror' })
    const contextLink = await api.widgetLinks.create(b.id, c.id, task.id)
    return { taskId: task.id, aId: a.id, bId: b.id, cId: c.id, linkId: link!.id, contextLinkId: contextLink!.id }
  })
}

async function openTask(window: Page, taskTitleRe: RegExp): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: taskTitleRe }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(300)
}

async function reloadIntoSameTask(window: Page): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(300)
}

// Edits a widget's content through the store's `update` (the same path a real
// UI edit goes through — WidgetFrame's textarea onBlur ultimately calls this),
// so notifyWireSource actually fires. Calling the raw window.api.widgets.update
// IPC directly would write the DB row but skip the renderer-side wire engine
// entirely, since notifyWireSource is invoked from useWidgetStore's `update`
// wrapper (src/renderer/src/stores/widgets.ts), not from the IPC call itself.
async function editContentViaStore(window: Page, widgetId: string, content: string): Promise<void> {
  await window.evaluate(
    async ({ id, content: c }: { id: string; content: string }) => {
      const w = window as unknown as {
        __fbWidgets?: { getState: () => { update: (id: string, patch: { content: string }) => Promise<unknown> } }
      }
      await w.__fbWidgets?.getState().update(id, { content: c })
    },
    { id: widgetId, content }
  )
}

async function widgetContent(window: Page, taskId: string, widgetId: string): Promise<string | undefined> {
  return window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const ws = await api.widgets.listByTask(tid)
      return ws.find((w) => w.id === wid)?.content
    },
    { tid: taskId, wid: widgetId }
  )
}

async function runsOf(window: Page, linkId: string): Promise<Array<{ id: string; prevContent: string; nextContent: string; at: number }>> {
  return window.evaluate(async (lid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.wireRuns.listByWire(lid)
  }, linkId)
}

async function linkOf(window: Page, taskId: string, linkId: string): Promise<{ lastRunAt: number | null; lastError: string | null } | undefined> {
  return window.evaluate(
    async ({ tid, lid }: { tid: string; lid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const links = await api.widgetLinks.listByTask(tid)
      const l = links.find((x) => x.id === lid)
      return l ? { lastRunAt: l.lastRunAt ?? null, lastError: l.lastError ?? null } : undefined
    },
    { tid: taskId, lid: linkId }
  )
}

test('(a) a fresh mirror wire reports never-run before any edit', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const s = await seed(window)
  await openTask(window, /Wire trust layer/)

  const badge = window.locator(`[data-testid="wire-badge-${s.linkId}"]`)
  await expect(badge).toBeVisible({ timeout: 4_000 })
  await expect(badge).toHaveAttribute('data-wire-fresh', 'never-run')
  // The never-run freshness dot (sky) is also present.
  await expect(window.locator(`[data-testid="wire-fresh-dot-${s.linkId}"]`)).toBeVisible()
})

test('(b) editing the source runs the mirror wire, writes the target, and records a wire_runs row', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const s = await seed(window)
  await openTask(window, /Wire trust layer/)

  await editContentViaStore(window, s.aId, 'v1')

  await expect
    .poll(async () => widgetContent(window, s.taskId, s.bId), { timeout: 6_000, intervals: [200, 300, 500] })
    .toBe('v1')

  const runs = await runsOf(window, s.linkId)
  expect(runs.length, 'at least one run recorded').toBeGreaterThanOrEqual(1)
  const run = runs[0]
  expect(run.prevContent, 'prevContent is B\'s content before the write (empty)').toBe('')
  expect(run.nextContent, 'nextContent is the mirrored value').toBe('v1')
})

test('(c) the badge goes ok after a run, stale immediately after a further source edit, and back to ok once that run completes', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const s = await seed(window)
  await openTask(window, /Wire trust layer/)

  const badge = window.locator(`[data-testid="wire-badge-${s.linkId}"]`)

  await editContentViaStore(window, s.aId, 'v1')
  await expect
    .poll(async () => widgetContent(window, s.taskId, s.bId), { timeout: 6_000, intervals: [200, 300, 500] })
    .toBe('v1')
  // React needs a tick to re-render the badge with the new lastRunAt.
  await expect(badge).toHaveAttribute('data-wire-fresh', 'ok', { timeout: 3_000 })

  // Edit A again — within the 900ms debounce window the badge must already
  // read stale (source.updatedAt just moved past link.lastRunAt), before the
  // next run has had a chance to fire.
  await editContentViaStore(window, s.aId, 'v2')
  await expect(badge).toHaveAttribute('data-wire-fresh', 'stale', { timeout: 500 })
  await expect(window.locator(`[data-testid="wire-fresh-dot-${s.linkId}"]`)).toBeVisible()

  // Once the second run completes and B is updated, it settles back to ok.
  await expect
    .poll(async () => widgetContent(window, s.taskId, s.bId), { timeout: 6_000, intervals: [200, 300, 500] })
    .toBe('v2')
  await expect(badge).toHaveAttribute('data-wire-fresh', 'ok', { timeout: 3_000 })
})

test('(d) the WireEditor lists recent activity and "Revert this write" restores the target\'s prior content', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const s = await seed(window)
  await openTask(window, /Wire trust layer/)

  // Two writes: '' -> 'v1' -> 'v2', two wire_runs rows.
  await editContentViaStore(window, s.aId, 'v1')
  await expect
    .poll(async () => widgetContent(window, s.taskId, s.bId), { timeout: 6_000, intervals: [200, 300, 500] })
    .toBe('v1')
  await editContentViaStore(window, s.aId, 'v2')
  await expect
    .poll(async () => widgetContent(window, s.taskId, s.bId), { timeout: 6_000, intervals: [200, 300, 500] })
    .toBe('v2')

  const runs = await runsOf(window, s.linkId)
  expect(runs.length).toBeGreaterThanOrEqual(2)
  const latestRun = runs[0] // ORDER BY at DESC — newest first
  expect(latestRun.nextContent).toBe('v2')
  expect(latestRun.prevContent).toBe('v1')

  await window.locator(`[data-testid="wire-badge-${s.linkId}"]`).click()
  await expect(window.locator('[data-testid="wire-editor"]')).toBeVisible({ timeout: 3_000 })

  const activity = window.locator('[data-testid="wire-activity"]')
  await expect(activity).toBeVisible({ timeout: 3_000 })
  const runRow = window.locator(`[data-testid="wire-run-${latestRun.id}"]`)
  await expect(runRow).toBeVisible()

  await window.locator(`[data-testid="wire-run-revert-${latestRun.id}"]`).click()

  await expect
    .poll(async () => widgetContent(window, s.taskId, s.bId), { timeout: 4_000, intervals: [150, 250] })
    .toBe('v1')
})

test('(e) last_run_at is durable across a reload', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const s = await seed(window)
  await openTask(window, /Wire trust layer/)

  await editContentViaStore(window, s.aId, 'v1')
  await expect
    .poll(async () => widgetContent(window, s.taskId, s.bId), { timeout: 6_000, intervals: [200, 300, 500] })
    .toBe('v1')

  const beforeReload = await linkOf(window, s.taskId, s.linkId)
  expect(beforeReload?.lastRunAt, 'lastRunAt is set before reload').not.toBeNull()

  await reloadIntoSameTask(window)

  const afterReload = await linkOf(window, s.taskId, s.linkId)
  expect(afterReload?.lastRunAt, 'lastRunAt survives a reload').not.toBeNull()
  expect(afterReload?.lastRunAt).toBe(beforeReload?.lastRunAt)

  const badge = window.locator(`[data-testid="wire-badge-${s.linkId}"]`)
  await expect(badge).toBeVisible({ timeout: 4_000 })
  const fresh = await badge.getAttribute('data-wire-fresh')
  expect(fresh, 'badge is not never-run after reload').not.toBe('never-run')
})

test('(f) a plain context wire carries no data-wire-fresh attribute', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const s = await seed(window)
  await openTask(window, /Wire trust layer/)

  const contextBadge = window.locator(`[data-testid="wire-badge-${s.contextLinkId}"]`)
  await expect(contextBadge).toBeVisible({ timeout: 4_000 })
  expect(await contextBadge.getAttribute('data-wire-fresh')).toBeNull()
  // No freshness dot either.
  await expect(window.locator(`[data-testid="wire-fresh-dot-${s.contextLinkId}"]`)).toHaveCount(0)
})
