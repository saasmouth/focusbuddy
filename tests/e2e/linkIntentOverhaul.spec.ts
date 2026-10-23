import { test, expect, type Page } from '@playwright/test'
import { clickWidgetTool, expectWidgetTool, launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Phase 1 "widget-link overhaul" (plexi-4.0):
//   (a)/(b) drawing a link creates it immediately as a passive `context` wire
//       and opens an intent picker at the drop point; picking "Transform it"
//       sets type=transform AND opens the WireEditor for the verb.
//   (c) picking "Feed in as context" / "Keep in sync" sets the type and
//       closes the picker without opening the editor.
//   (d) dismissing the picker (Escape or outside click) is non-destructive —
//       the link survives as a context wire.
//   (e) right-click "Automate with an agent" spawns an agent widget wired
//       from the source.
//   (f) multi-select "Automate N with an agent" spawns exactly one agent
//       wired from every selected widget.
//   (g) a pinned widget shows the hub button and can be a link endpoint.
//   (h) regressions: two popovers can't coexist; sections / section-children
//       remain valid link endpoints.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

interface SeedWidget {
  taskId: string
  kind?: string
  title?: string
  content?: string
  x: number
  y: number
  width?: number
  height?: number
}

async function openTask(window: Page, taskTitleRe: RegExp): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: taskTitleRe }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(300)
}

// The app restores its last-active task straight into the canvas on reload —
// so once a task is already open (via openTask/seedTaskWithStickies), a
// SECOND reload after an out-of-band API mutation must NOT try to re-click a
// task tile (there isn't one; the breadcrumb title renders as plain text,
// not a button, once inside the canvas). Just reload and re-wait for canvas.
async function reloadIntoSameTask(window: Page): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(300)
}

async function seedTaskWithStickies(
  window: Page,
  taskTitle: string,
  positions: Array<{ x: number; y: number }>
): Promise<{ taskId: string; ids: string[] }> {
  await waitForReady(window)
  const seeded = await window.evaluate(
    async ({ title, pts }: { title: string; pts: Array<{ x: number; y: number }> }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const task = await api.nodes.create({ parentId: null, kind: 'task', title })
      const ids: string[] = []
      for (let i = 0; i < pts.length; i++) {
        const w = await api.widgets.create({
          taskId: task.id,
          kind: 'sticky',
          title: `s${i}`,
          content: `s${i}`,
          x: pts[i].x,
          y: pts[i].y,
          width: 220,
          height: 180
        })
        ids.push(w.id)
      }
      return { taskId: task.id, ids }
    },
    { title: taskTitle, pts: positions }
  )
  await openTask(window, new RegExp(taskTitle))
  for (const id of seeded.ids) {
    await window.waitForSelector(`[data-widget-id="${id}"]`, { timeout: 5_000 })
  }
  await window.waitForTimeout(200)
  return seeded
}

async function linksOf(window: Page, taskId: string): Promise<Array<{ id: string; sourceWidgetId: string; targetWidgetId: string; type: string }>> {
  return window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const links = await api.widgetLinks.listByTask(tid)
    return links.map((l) => ({ id: l.id, sourceWidgetId: l.sourceWidgetId, targetWidgetId: l.targetWidgetId, type: l.type }))
  }, taskId)
}

async function widgetsOf(window: Page, taskId: string): Promise<Array<{ id: string; kind: string; parentSectionId: string | null }>> {
  return window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const ws = await api.widgets.listByTask(tid)
    return ws.map((w) => ({ id: w.id, kind: w.kind, parentSectionId: w.parentSectionId ?? null }))
  }, taskId)
}

async function bodyPoint(window: Page, id: string): Promise<{ x: number; y: number }> {
  const box = await window.locator(`[data-widget-id="${id}"]`).boundingBox()
  if (!box) throw new Error(`no bounding box for widget ${id}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// Arms the link from `sourceId` via its hub button, then completes the drop
// by clicking the given screen point. Returns the (x, y) actually clicked so
// callers can cross-check the picker's anchor.
async function armAndDrop(
  window: Page,
  sourceId: string,
  drop: { x: number; y: number }
): Promise<{ x: number; y: number }> {
  // At narrow widths the hub folds into the header's "…" menu
  // (lib/widgetHeaderActions); clickWidgetTool presses it wherever it is.
  await clickWidgetTool(window, sourceId, 'Link to another work widget')
  await window.mouse.click(drop.x, drop.y)
  await window.waitForTimeout(150)
  return drop
}

// ── (a)/(b) draw → picker appears → Transform opens the WireEditor ─────────

test('(a)(b) drawing a link creates a context wire immediately, opens the intent picker, and Transform opens the WireEditor', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, ids } = await seedTaskWithStickies(window, 'Intent picker AB', [
    { x: 120, y: 120 },
    { x: 480, y: 120 }
  ])
  const [srcId, tgtId] = ids

  const drop = await bodyPoint(window, tgtId)
  await armAndDrop(window, srcId, drop)

  // Link exists immediately as a context wire (created synchronously on drop).
  const afterDrop = await linksOf(window, taskId)
  expect(afterDrop.length, 'a link exists right after the drop').toBe(1)
  expect(afterDrop[0].sourceWidgetId).toBe(srcId)
  expect(afterDrop[0].targetWidgetId).toBe(tgtId)
  expect(afterDrop[0].type, 'defaults to context before any pick').toBe('context')

  // Picker is visible with all three choices + close button.
  const picker = window.locator('[data-testid="link-intent-picker"]')
  await expect(picker).toBeVisible({ timeout: 3_000 })
  await expect(picker.locator('[data-testid="link-intent-context"]')).toBeVisible()
  await expect(picker.locator('[data-testid="link-intent-transform"]')).toBeVisible()
  await expect(picker.locator('[data-testid="link-intent-mirror"]')).toBeVisible()
  await expect(picker.getByLabel('Dismiss')).toBeVisible()

  // Pick "Transform it" → type becomes transform AND the WireEditor opens
  // with the verb input, anchored at the same drop point.
  await picker.locator('[data-testid="link-intent-transform"]').click()
  await window.waitForTimeout(200)

  await expect(picker, 'picker closes once a choice is made').toBeHidden()
  await expect(window.locator('[data-testid="wire-editor"]')).toBeVisible({ timeout: 3_000 })
  await expect(window.locator('[data-testid="wire-verb-input"]')).toBeVisible()

  const afterPick = await linksOf(window, taskId)
  expect(afterPick[0].type).toBe('transform')
})

// ── (c) context / mirror choices set the type and close, no editor ─────────

test('(c) picking "Keep in sync" or "Feed in as context" sets the type and closes the picker without opening the editor', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, ids } = await seedTaskWithStickies(window, 'Intent picker C', [
    { x: 120, y: 120 }, // source
    { x: 480, y: 120 }, // mirror target
    { x: 480, y: 380 } // context target
  ])
  const [srcId, mirrorTgtId, contextTgtId] = ids

  // Mirror choice.
  const dropMirror = await bodyPoint(window, mirrorTgtId)
  await armAndDrop(window, srcId, dropMirror)
  const pickerMirror = window.locator('[data-testid="link-intent-picker"]')
  await expect(pickerMirror).toBeVisible({ timeout: 3_000 })
  await pickerMirror.locator('[data-testid="link-intent-mirror"]').click()
  await window.waitForTimeout(150)
  await expect(pickerMirror, 'picker closes on mirror pick').toBeHidden()
  await expect(window.locator('[data-testid="wire-editor"]'), 'mirror pick does not open the editor').not.toBeVisible()

  // Context choice.
  const dropContext = await bodyPoint(window, contextTgtId)
  await armAndDrop(window, srcId, dropContext)
  const pickerContext = window.locator('[data-testid="link-intent-picker"]')
  await expect(pickerContext).toBeVisible({ timeout: 3_000 })
  await pickerContext.locator('[data-testid="link-intent-context"]').click()
  await window.waitForTimeout(150)
  await expect(pickerContext, 'picker closes on context pick').toBeHidden()
  await expect(window.locator('[data-testid="wire-editor"]'), 'context pick does not open the editor').not.toBeVisible()

  const links = await linksOf(window, taskId)
  const mirrorLink = links.find((l) => l.targetWidgetId === mirrorTgtId)
  const contextLink = links.find((l) => l.targetWidgetId === contextTgtId)
  expect(mirrorLink?.type).toBe('mirror')
  expect(contextLink?.type).toBe('context')
})

// ── (d) dismiss is non-destructive ──────────────────────────────────────────

test('(d) dismissing the picker with Escape keeps the link as a context wire', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, ids } = await seedTaskWithStickies(window, 'Intent picker Escape', [
    { x: 120, y: 120 },
    { x: 480, y: 120 }
  ])
  const [srcId, tgtId] = ids

  const drop = await bodyPoint(window, tgtId)
  await armAndDrop(window, srcId, drop)
  const picker = window.locator('[data-testid="link-intent-picker"]')
  await expect(picker).toBeVisible({ timeout: 3_000 })

  await window.keyboard.press('Escape')
  await window.waitForTimeout(150)
  await expect(picker, 'Escape closes the picker').toBeHidden()

  const links = await linksOf(window, taskId)
  expect(links.length, 'the link is NOT deleted by dismissing the picker').toBe(1)
  expect(links[0].sourceWidgetId).toBe(srcId)
  expect(links[0].targetWidgetId).toBe(tgtId)
  expect(links[0].type, 'stays the passive default').toBe('context')
})

test('(d) dismissing the picker by clicking empty canvas keeps the link as a context wire', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, ids } = await seedTaskWithStickies(window, 'Intent picker OutsideClick', [
    { x: 120, y: 120 },
    { x: 480, y: 120 }
  ])
  const [srcId, tgtId] = ids

  const drop = await bodyPoint(window, tgtId)
  await armAndDrop(window, srcId, drop)
  const picker = window.locator('[data-testid="link-intent-picker"]')
  await expect(picker).toBeVisible({ timeout: 3_000 })

  // Click on a blank part of the canvas, well away from both widgets and the
  // picker itself.
  const surf = window.locator('[data-canvas-surface="true"]')
  const box = await surf.boundingBox()
  if (!box) throw new Error('no canvas surface box')
  await window.mouse.click(box.x + box.width - 60, box.y + box.height - 60)
  await window.waitForTimeout(150)
  await expect(picker, 'outside click closes the picker').toBeHidden()

  const links = await linksOf(window, taskId)
  expect(links.length, 'the link is NOT deleted by an outside click').toBe(1)
  expect(links[0].type).toBe('context')
})

// ── (e) single-widget "Automate with an agent" ──────────────────────────────

test('(e) right-click "Automate with an agent" spawns an agent widget wired from the source', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, ids } = await seedTaskWithStickies(window, 'Automate single', [{ x: 200, y: 200 }])
  const [sourceId] = ids

  const sourceFrame = window.locator(`[data-widget-id="${sourceId}"]`)
  await sourceFrame.locator('.widget-handle').first().click({ button: 'right' })

  // "Automate with an agent" is the first child of the "Create" submenu
  // (CREATE_AND_CONNECT_MENU) — hover Create to open it, same as the
  // existing createConnectedTool.spec.ts pattern.
  await window.locator('[data-canvas-ctx-menu]').getByText('Create', { exact: true }).hover()
  const menuItem = window.locator('[data-canvas-ctx-menu]').getByText('Automate with an agent', { exact: true }).first()
  await expect(menuItem, 'Automate with an agent appears in the Create menu').toBeVisible({ timeout: 4_000 })
  await menuItem.click()
  await window.waitForTimeout(500)

  const widgets = await widgetsOf(window, taskId)
  const agents = widgets.filter((w) => w.kind === 'agent')
  expect(agents.length, 'exactly one agent widget was spawned').toBe(1)

  const links = await linksOf(window, taskId)
  const fromSource = links.filter((l) => l.sourceWidgetId === sourceId)
  expect(fromSource.length, 'exactly one link from the source').toBe(1)
  expect(fromSource[0].targetWidgetId, 'the link points INTO the agent').toBe(agents[0].id)
})

// ── (f) bulk "Automate N with an agent" ─────────────────────────────────────

async function shiftClickHeader(window: Page, id: string): Promise<void> {
  const pt = await window.evaluate((wid: string) => {
    const h = document.querySelector(`[data-widget-id="${wid}"] .widget-handle`)
    const target = h ?? document.querySelector(`[data-widget-id="${wid}"]`)
    const b = (target as HTMLElement).getBoundingClientRect()
    return { x: b.left + 26, y: b.top + (h ? b.height / 2 : 44) }
  }, id)
  await window.keyboard.down('Shift')
  await window.mouse.click(pt.x, pt.y)
  await window.keyboard.up('Shift')
  await window.waitForTimeout(150)
}

test('(f) selecting 3 widgets and "Automate 3 with an agent" spawns exactly one agent wired from every selected widget', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, ids } = await seedTaskWithStickies(window, 'Automate bulk', [
    { x: 120, y: 120 },
    { x: 400, y: 120 },
    { x: 120, y: 380 }
  ])

  await shiftClickHeader(window, ids[0])
  await shiftClickHeader(window, ids[1])
  await shiftClickHeader(window, ids[2])
  await expect(window.locator('body')).toContainText('3 selected')

  // Right-click one of the selected widgets' headers to open the multi menu.
  const header = window.locator(`[data-widget-id="${ids[0]}"] .widget-handle`)
  await header.click({ button: 'right' })

  const organiseParent = window.getByRole('menuitem', { name: /^Organise$/ })
  if (await organiseParent.isVisible().catch(() => false)) {
    await organiseParent.hover()
  }
  const automateItem = window.getByRole('menuitem', { name: 'Automate 3 with an agent' })
  await expect(automateItem, 'bulk automate entry shows the selection count').toBeVisible({ timeout: 4_000 })
  await automateItem.click()
  await window.waitForTimeout(500)

  const widgets = await widgetsOf(window, taskId)
  const agents = widgets.filter((w) => w.kind === 'agent')
  expect(agents.length, 'exactly one agent was spawned for the whole selection').toBe(1)

  const links = await linksOf(window, taskId)
  const intoAgent = links.filter((l) => l.targetWidgetId === agents[0].id)
  expect(intoAgent.length, 'all three selected widgets are wired into the one agent').toBe(3)
  const sourceIds = intoAgent.map((l) => l.sourceWidgetId).sort()
  expect(sourceIds).toEqual([...ids].sort())
})

// ── (g) pinned widgets are valid link endpoints ─────────────────────────────

test('(g) a pinned widget shows the hub button and can be linked to another widget', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, ids } = await seedTaskWithStickies(window, 'Pinned link endpoint', [
    { x: 120, y: 120 },
    { x: 480, y: 120 }
  ])
  const [pinnedId, otherId] = ids

  // Pin the first widget to a zone via the API (equivalent of PinControl's
  // pinToZone action) and reload so the pinned layer renders it.
  await window.evaluate(
    async ({ id }: { id: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      // 'br' (not 'tl') — the top-left zone collides with the app's own
      // top-left floating chrome bar (data-floating-menu, z-45), which
      // intercepts pointer events there. 'br' is clear (g-target already
      // uses it successfully for the pinned-as-target case).
      await api.widgets.update(id, { pinned: true, pinnedZone: 'br' })
    },
    { id: pinnedId }
  )
  await reloadIntoSameTask(window)
  await window.waitForSelector(`[data-widget-id="${pinnedId}"]`, { timeout: 5_000 })
  await window.waitForSelector(`[data-widget-id="${otherId}"]`, { timeout: 5_000 })

  // The pinned widget shows the "Link to another work widget" hub button.
  await expectWidgetTool(window, pinnedId, 'Link to another work widget', 'pinned widget offers the hub')

  // Arm from the pinned widget, drop onto the other (unpinned) widget.
  const drop = await bodyPoint(window, otherId)
  await armAndDrop(window, pinnedId, drop)

  const links = await linksOf(window, taskId)
  expect(links.length, 'a link was created from the pinned source').toBe(1)
  expect(links[0].sourceWidgetId).toBe(pinnedId)
  expect(links[0].targetWidgetId).toBe(otherId)

  // The connecting line actually renders (a real <line>/<path> element tied
  // to this link, not just a DB row).
  const rendered = await window.evaluate((linkId: string) => {
    return !!document.querySelector(`[data-link-line][data-link-id="${linkId}"]`)
      || !!document.querySelector(`[data-testid="wire-badge-${linkId}"]`)
  }, links[0].id)
  expect(rendered, 'the link line/badge renders for the pinned endpoint').toBe(true)
})

test('(g-target) an unpinned widget can drop a link ONTO a pinned widget', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, ids } = await seedTaskWithStickies(window, 'Pinned as target', [
    { x: 120, y: 120 },
    { x: 480, y: 120 }
  ])
  const [normalId, pinnedId] = ids

  await window.evaluate(
    async ({ id }: { id: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.update(id, { pinned: true, pinnedZone: 'br' })
    },
    { id: pinnedId }
  )
  await reloadIntoSameTask(window)
  await window.waitForSelector(`[data-widget-id="${normalId}"]`, { timeout: 5_000 })
  await window.waitForSelector(`[data-widget-id="${pinnedId}"]`, { timeout: 5_000 })

  const drop = await bodyPoint(window, pinnedId)
  await armAndDrop(window, normalId, drop)

  const links = await linksOf(window, taskId)
  expect(links.length, 'a link lands on the pinned target').toBe(1)
  expect(links[0].targetWidgetId).toBe(pinnedId)
})

// ── (h) regressions ──────────────────────────────────────────────────────────

test('(h) opening the WireEditor from an existing badge dismisses an open intent picker', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, ids } = await seedTaskWithStickies(window, 'Two popovers A', [
    { x: 120, y: 120 },
    { x: 480, y: 120 },
    { x: 120, y: 380 },
    { x: 480, y: 380 }
  ])
  const [srcA, tgtA, srcB, tgtB] = ids

  // Pre-existing link (created via API, like an earlier session), so its
  // wire badge is already on screen.
  const existingLinkId = await window.evaluate(
    async ({ a, b, taskId: tid }: { a: string; b: string; taskId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const link = await api.widgetLinks.create(a, b, tid)
      return link!.id
    },
    { a: srcB, b: tgtB, taskId }
  )
  await reloadIntoSameTask(window)

  // Draw a NEW link, opening the intent picker.
  const drop = await bodyPoint(window, tgtA)
  await armAndDrop(window, srcA, drop)
  const picker = window.locator('[data-testid="link-intent-picker"]')
  await expect(picker).toBeVisible({ timeout: 3_000 })

  // Click the pre-existing link's wire badge — this must dismiss the picker
  // and open the WireEditor instead. Only one popover on screen at a time.
  await window.locator(`[data-testid="wire-badge-${existingLinkId}"]`).click()
  await expect(window.locator('[data-testid="wire-editor"]'), 'wire editor opens').toBeVisible({ timeout: 3_000 })
  await expect(picker, 'intent picker is dismissed').toBeHidden()

  // The link the picker was pending on was NOT deleted by this dismissal.
  const links = await linksOf(window, taskId)
  const pendingLink = links.find((l) => l.sourceWidgetId === srcA && l.targetWidgetId === tgtA)
  expect(pendingLink, 'the picker-pending link still exists').toBeTruthy()
  expect(pendingLink?.type).toBe('context')
})

test('(h) arming+dropping a new link dismisses an open WireEditor', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, ids } = await seedTaskWithStickies(window, 'Two popovers B', [
    { x: 120, y: 120 },
    { x: 480, y: 120 },
    { x: 120, y: 380 },
    { x: 480, y: 380 }
  ])
  const [srcA, tgtA, srcB, tgtB] = ids

  const existingLinkId = await window.evaluate(
    async ({ a, b, taskId: tid }: { a: string; b: string; taskId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const link = await api.widgetLinks.create(a, b, tid)
      return link!.id
    },
    { a: srcB, b: tgtB, taskId }
  )
  await reloadIntoSameTask(window)

  // Open the WireEditor first.
  await window.locator(`[data-testid="wire-badge-${existingLinkId}"]`).click()
  await expect(window.locator('[data-testid="wire-editor"]')).toBeVisible({ timeout: 3_000 })

  // Now draw a brand new link. Per the implementation, the reciprocal
  // dismissal is keyed on `pendingPick` (set once the drop lands and the
  // link is created) — not on the arm alone. So the editor is only
  // guaranteed gone once the arm+drop gesture completes.
  await clickWidgetTool(window, srcA, 'Link to another work widget')
  await window.waitForTimeout(100)

  const drop = await bodyPoint(window, tgtA)
  await window.mouse.click(drop.x, drop.y)
  await window.waitForTimeout(150)
  await expect(window.locator('[data-testid="link-intent-picker"]')).toBeVisible({ timeout: 3_000 })
  await expect(window.locator('[data-testid="wire-editor"]'), 'completing arm+drop dismisses the previously-open editor').toBeHidden()
})

test('(h) a link can still be drawn onto a section itself', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // An EMPTY section: computeSectionFrame (sectionGeometry.ts) auto-fits a
  // section tightly to its children's bounding box regardless of the
  // width/height passed to widgets.create, so a section WITH a child leaves
  // only a sliver of clickable chrome around it. Zero children instead gives
  // the section's predictable SECTION_MIN_W/H rect with no child fighting
  // for the same pixels — a clean, deterministic drop target.
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Section link regression' })
    const source = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'source',
      content: 'source',
      x: 60,
      y: 400,
      width: 200,
      height: 140
    })
    const section = await api.widgets.create({
      taskId: task.id,
      kind: 'section',
      title: 'Target section',
      content: '',
      x: 450,
      y: 60,
      width: 380,
      height: 260,
      color: '#3b82f6'
    })
    return { taskId: task.id, sourceId: source.id, sectionId: section.id }
  })

  await openTask(window, /Section link regression/)
  await window.waitForSelector(`[data-widget-id="${seeded.sourceId}"]`, { timeout: 5_000 })
  await window.waitForSelector(`[data-widget-id="${seeded.sectionId}"]`, { timeout: 5_000 })

  const drop = await bodyPoint(window, seeded.sectionId)
  await armAndDrop(window, seeded.sourceId, drop)

  const links = await linksOf(window, seeded.taskId)
  const toSection = links.find((l) => l.sourceWidgetId === seeded.sourceId && l.targetWidgetId === seeded.sectionId)
  expect(toSection, 'a link to the section itself was created').toBeTruthy()
})

test('(h) a link can still be drawn onto a widget nested inside a section', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Section child link regression' })
    const source = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'source',
      content: 'source',
      x: 60,
      y: 400,
      width: 200,
      height: 140
    })
    const section = await api.widgets.create({
      taskId: task.id,
      kind: 'section',
      title: 'Target section',
      content: '',
      x: 450,
      y: 60,
      width: 380,
      height: 260,
      color: '#3b82f6'
    })
    await api.widgets.update(section.id, { layout: 'free' as never })
    const child = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'child',
      content: 'child',
      x: 20,
      y: 20,
      width: 160,
      height: 100
    })
    await api.widgets.update(child.id, { parentSectionId: section.id })
    return { taskId: task.id, sourceId: source.id, sectionId: section.id, childId: child.id }
  })

  await openTask(window, /Section child link regression/)
  await window.waitForSelector(`[data-widget-id="${seeded.sourceId}"]`, { timeout: 5_000 })
  await window.waitForSelector(`[data-widget-id="${seeded.childId}"]`, { timeout: 5_000 })

  const childDrop = await bodyPoint(window, seeded.childId)
  await armAndDrop(window, seeded.sourceId, childDrop)

  const links = await linksOf(window, seeded.taskId)
  const toChild = links.find((l) => l.sourceWidgetId === seeded.sourceId && l.targetWidgetId === seeded.childId)
  expect(toChild, 'a link to the section child was created').toBeTruthy()
})

test('(h) a user-drawn link mirrors into the relationship graph (context.related)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, ids } = await seedTaskWithStickies(window, 'Graph mirror regression', [
    { x: 120, y: 120 },
    { x: 480, y: 120 }
  ])
  const [srcId, tgtId] = ids

  const drop = await bodyPoint(window, tgtId)
  await armAndDrop(window, srcId, drop)
  await window.keyboard.press('Escape') // dismiss the picker; link must survive
  await window.waitForTimeout(150)

  const related = await window.evaluate(async (id: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.context.related(id)
  }, srcId)
  expect(related, 'the UI-drawn link feeds context.related').toContain(tgtId)

  const links = await linksOf(window, taskId)
  expect(links.length).toBe(1)
  expect(links[0].type).toBe('context')
})
