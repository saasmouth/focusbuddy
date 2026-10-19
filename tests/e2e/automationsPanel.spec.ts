import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Automations panel (Lever 1c/1d, plexi-4.0):
//   A FAB stacked above the minimap FAB (bottom-right) that blooms into a
//   panel listing every automation on the current desk — reactive wires
//   (transform / mirror only; a plain context wire is passive and must NOT
//   appear) and desk agents. Each row shows what it does, a real status
//   (ran / stale / hasn't run / off / failed), an on/off toggle wired to the
//   underlying enabled flag, and a "Jump" button that centres the canvas via
//   setPan. A footer line is an honest receipt of how AI runs reach the model.
//
// Driven via window.api / __fbWidgets for deterministic setup and content
// edits (the mirror-wire run path, same mechanism as wireTrustLayer.spec.ts),
// plus real UI clicks for the FAB / panel / toggle / jump.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openTask(window: Page, taskTitleRe: RegExp): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: taskTitleRe }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(300)
}

interface Seeded {
  taskId: string
  aId: string
  bId: string
  cId: string
  agentId: string
  mirrorLinkId: string
}

// Seeds a task with three stickies (A, B, C), an agent widget, a mirror wire
// A->B, and a plain context wire B->C — the passive control that must NOT
// show up as an automation.
async function seed(window: Page, title: string): Promise<Seeded> {
  return window.evaluate(async (taskTitle: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: taskTitle })
    const a = await api.widgets.create({
      taskId: task.id, kind: 'sticky', title: 'A', content: 'v0', x: 120, y: 160, width: 220, height: 180
    })
    const b = await api.widgets.create({
      taskId: task.id, kind: 'sticky', title: 'B', content: '', x: 520, y: 160, width: 220, height: 180
    })
    const c = await api.widgets.create({
      taskId: task.id, kind: 'sticky', title: 'C', content: '', x: 920, y: 160, width: 220, height: 180
    })
    const agent = await api.widgets.create({
      taskId: task.id,
      kind: 'agent',
      title: 'Watcher',
      content: JSON.stringify({ instruction: 'watch A', trigger: 'manual', enabled: true }),
      x: 520, y: 560, width: 300, height: 220
    })
    const mirrorLink = await api.widgetLinks.create(a.id, b.id, task.id)
    await api.widgetLinks.update(mirrorLink!.id, { type: 'mirror' })
    await api.widgetLinks.create(b.id, c.id, task.id) // plain context wire — passive control
    return { taskId: task.id, aId: a.id, bId: b.id, cId: c.id, agentId: agent.id, mirrorLinkId: mirrorLink!.id }
  }, title)
}

// Edits a widget's content through the store's `update` (the same path a real
// UI edit goes through), so notifyWireSource actually fires the wire engine —
// exactly the mechanism wireTrustLayer.spec.ts uses to get a deterministic,
// non-AI (mirror) run without any API key.
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

async function linksOf(
  window: Page,
  taskId: string
): Promise<Array<{ id: string; enabled: boolean; type: string }>> {
  return window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const links = await api.widgetLinks.listByTask(tid)
    return links.map((l) => ({ id: l.id, enabled: l.enabled, type: l.type }))
  }, taskId)
}

async function panOf(window: Page): Promise<{ panX: number; panY: number }> {
  return window.evaluate(() => {
    const w = window as unknown as { __fbWidgets?: { getState: () => { panX: number; panY: number } } }
    const s = w.__fbWidgets?.getState()
    return { panX: s?.panX ?? 0, panY: s?.panY ?? 0 }
  })
}

// Best-effort dismiss of the "New feature" corner spotlight (unrelated
// onboarding surface, e.g. "Rooms, Desks and Plans") that can pop up over the
// canvas and intercept clicks on a desk with little else going on.
async function dismissFeatureSpotlight(window: Page): Promise<void> {
  const dismiss = window.locator('[data-testid="feature-spotlight-dismiss"]')
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click().catch(() => {})
  }
}

async function openAutomationsPanel(window: Page): Promise<void> {
  const fab = window.locator('[data-testid="automations-fab"]')
  await expect(fab).toBeVisible({ timeout: 5_000 })
  // Give the async "new feature" spotlight (unrelated onboarding surface) a
  // moment to mount if it's going to, then dismiss it — otherwise it can pop
  // up mid-click and intercept the pointer event on a desk with little else
  // going on to occupy that window.
  await window.waitForTimeout(1_000)
  await dismissFeatureSpotlight(window)
  await fab.click({ timeout: 10_000 })
  await expect(window.locator('[data-testid="automations-panel"]')).toBeVisible({ timeout: 3_000 })
}

// ── (a) fresh desk: FAB present, empty state ────────────────────────────────

test('(a) a fresh desk with no automations shows the FAB and an empty-state panel', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: 'Fresh automations desk' })
  })
  await openTask(window, /Fresh automations desk/)

  await openAutomationsPanel(window)
  await expect(window.locator('[data-testid^="automation-row-"]')).toHaveCount(0)
  await expect(window.getByText('Nothing runs on its own here yet.')).toBeVisible()
})

// ── (b)/(c) exactly the mirror wire + the agent show up; context wire doesn't ──

test('(b)/(c) a mirror wire and an agent appear as automations; a plain context wire does not', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const s = await seed(window, 'Automations rows test')
  await openTask(window, /Automations rows test/)

  await openAutomationsPanel(window)

  const rows = window.locator('[data-testid^="automation-row-"]')
  await expect(rows).toHaveCount(2)

  const mirrorRow = window.locator(`[data-testid="automation-row-${s.mirrorLinkId}"]`)
  await expect(mirrorRow).toBeVisible()
  await expect(mirrorRow).toContainText('A → B')
  await expect(mirrorRow).toContainText('Mirror')

  const agentRow = window.locator(`[data-testid="automation-row-${s.agentId}"]`)
  await expect(agentRow).toBeVisible()
  await expect(agentRow).toContainText('Watcher')
  await expect(agentRow).toContainText('Agent')

  // (c) The plain B->C context wire must not have produced a third row.
  const links = await linksOf(window, s.taskId)
  const contextLink = links.find((l) => l.type === 'context')
  expect(contextLink, 'a passive context link exists between B and C').toBeTruthy()
  await expect(window.locator(`[data-testid="automation-row-${contextLink!.id}"]`)).toHaveCount(0)
})

// ── (d) toggle the mirror wire off/on via the panel switch ─────────────────

test('(d) toggling a wire automation flips widgetLinks.enabled', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const s = await seed(window, 'Automations toggle test')
  await openTask(window, /Automations toggle test/)
  await openAutomationsPanel(window)

  const toggle = window.locator(`[data-testid="automation-toggle-${s.mirrorLinkId}"]`)
  await expect(toggle).toBeVisible()

  await toggle.click()
  await expect
    .poll(async () => (await linksOf(window, s.taskId)).find((l) => l.id === s.mirrorLinkId)?.enabled)
    .toBe(false)

  await toggle.click()
  await expect
    .poll(async () => (await linksOf(window, s.taskId)).find((l) => l.id === s.mirrorLinkId)?.enabled)
    .toBe(true)
})

// ── (e) jump-to centres the canvas on the automation ────────────────────────

test('(e) clicking Jump on an automation row changes the canvas pan', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const s = await seed(window, 'Automations jump test')
  await openTask(window, /Automations jump test/)
  await openAutomationsPanel(window)

  const before = await panOf(window)

  const jump = window.locator(`[data-testid="automation-jump-${s.mirrorLinkId}"]`)
  await expect(jump).toBeVisible()
  await jump.click()

  await expect
    .poll(async () => {
      const after = await panOf(window)
      return after.panX !== before.panX || after.panY !== before.panY
    })
    .toBe(true)
})

// ── (f) status reflects real run state: hasn't-run -> ran -> stale -> ran ──

test('(f) a mirror wire row reports a real run, then stale after a further source edit', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const s = await seed(window, 'Automations status test')
  await openTask(window, /Automations status test/)
  await openAutomationsPanel(window)

  const row = window.locator(`[data-testid="automation-row-${s.mirrorLinkId}"]`)
  await expect(row).toContainText("Hasn't run")

  // Trigger a real run through the same path a UI edit uses (store update ->
  // notifyWireSource) — deterministic because a mirror wire needs no AI call.
  await editContentViaStore(window, s.aId, 'v1')
  await expect
    .poll(async () => widgetContent(window, s.taskId, s.bId), { timeout: 6_000, intervals: [200, 300, 500] })
    .toBe('v1')
  await expect(row).toContainText(/Ran (just now|\d+[mhd] ago)/, { timeout: 3_000 })

  // Edit the source again — before the debounced re-run completes (900ms),
  // source.updatedAt has already moved past link.lastRunAt, so the row must
  // read stale immediately (same window wireTrustLayer.spec.ts relies on).
  await editContentViaStore(window, s.aId, 'v2')
  await expect(row).toContainText('Stale', { timeout: 500 })

  // Once the second run completes, it settles back to a real "ran" state.
  await expect
    .poll(async () => widgetContent(window, s.taskId, s.bId), { timeout: 6_000, intervals: [200, 300, 500] })
    .toBe('v2')
  await expect(row).toContainText(/Ran (just now|\d+[mhd] ago)/, { timeout: 3_000 })
})

// ── (g) the data-receipt footer is present with real, non-empty text ───────

test('(g) the data-receipt footer line is present with non-empty text', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await seed(window, 'Automations receipt test')
  await openTask(window, /Automations receipt test/)
  await openAutomationsPanel(window)

  const panel = window.locator('[data-testid="automations-panel"]')
  await expect(panel).toContainText(
    /your key, sent directly to Anthropic|PlexiDesk credits, relayed through our server/,
    { timeout: 4_000 }
  )
})

// ── (h) regression: minimap FAB still opens/works alongside the new FAB ────

test('(h) regression: the minimap FAB still opens and closes alongside the automations FAB', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await seed(window, 'Automations regression test')
  await openTask(window, /Automations regression test/)

  const minimapIcon = window.locator('[data-minimap-fab]').getByTitle('Show minimap')
  await expect(minimapIcon).toBeVisible({ timeout: 5_000 })
  await minimapIcon.click()
  await expect(window.locator('[data-minimap-fab] svg.cursor-crosshair')).toBeVisible({ timeout: 3_000 })
  await window.locator('[data-minimap-fab]').getByTitle('Close minimap').click()
  await expect(window.locator('[data-minimap-fab] svg.cursor-crosshair')).not.toBeVisible()

  // The automations FAB is unaffected and still opens too.
  await openAutomationsPanel(window)
  await expect(window.locator('[data-testid^="automation-row-"]')).toHaveCount(2)
})
