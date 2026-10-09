import { test, expect } from '@playwright/test'
import { hoverToolbar, launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Chrome layout — verifies three coordinated changes:
//   1. The "Desk objects" palette is now a single "+ Add" button that
//      opens a popover, not a full-width horizontal strip.
//   2. The picker shows the universal File entry but no longer shows
//      the folded-away kinds (image, video, pdf, gdoc, gsheet, gslide,
//      email) — those still render correctly when an existing widget
//      uses them, but they're hidden from the picker.
//   3. The pinned-BR minimap shifts left to clear the AI Assistant rail
//      when the rail is open. When the rail collapses, the minimap
//      glides back toward the corner.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function bootAndOpenTask(launched: LaunchedApp): Promise<string> {
  const { window } = launched
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})

  const taskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Chrome test'
    })
    return task.id
  })

  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip2.isVisible().catch(() => false)) await skip2.click().catch(() => {})
  await window.getByRole('button', { name: 'Chrome test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  return taskId
}

test('Palette renders as a single "+ Add" button — the legacy full-width strip is gone', async () => {
  launched = await launchApp()
  await bootAndOpenTask(launched)

  // The new compact palette is a single button with data-testid.
  // The rail only mounts the palette while hovered — see hoverToolbar.
  await hoverToolbar(launched.window)
  const addBtn = launched.window.locator('[data-testid="palette-add-button"]').first()
  await expect(addBtn).toBeVisible({ timeout: 5_000 })

  // The legacy full-width strip carried a persistent "Desk objects" heading.
  // The popover's visible heading is now "Add to this desk" — "Desk objects"
  // survives only as the dialog's aria-label — so that is what this asserts:
  // nothing before the click, and a heading inside the popover after it.
  const popoverHeading = launched.window.getByText('Add to this desk', { exact: true }).first()
  await expect(popoverHeading).toHaveCount(0)

  await addBtn.click()
  await expect(popoverHeading).toBeVisible({ timeout: 2000 })
  // The picker is still announced as the desk-objects dialog.
  await expect(
    launched.window.locator('[role="dialog"][aria-label="Desk objects"]')
  ).toBeVisible()
})

test('Picker shows File or link but hides the folded redundant kinds (image / video / pdf / gdoc / gsheet / gslide / email)', async () => {
  launched = await launchApp()
  await bootAndOpenTask(launched)

  // The rail only mounts the palette while hovered — see hoverToolbar.
  await hoverToolbar(launched.window)
  const addBtn = launched.window.locator('[data-testid="palette-add-button"]').first()
  await addBtn.click()
  await launched.window.waitForTimeout(150)

  // The universal File entry exists in the picker.
  await expect(
    launched.window.locator('[data-testid="palette-add-file"]').first()
  ).toBeVisible({ timeout: 3000 })

  // Each folded-away kind must NOT have a picker tile any more. We use
  // the per-kind data-testid since label-based lookups would race with
  // partial-text matches across the rest of the chrome.
  const foldedKinds = ['image', 'video', 'pdf', 'gdoc', 'gsheet', 'gslide', 'email']
  for (const kind of foldedKinds) {
    const count = await launched.window
      .locator(`[data-testid="palette-add-${kind}"]`)
      .count()
    expect({ kind, count }).toEqual({ kind, count: 0 })
  }
})

test('a right-pinned widget reaches the right edge — no phantom rail inset', async () => {
  launched = await launchApp()
  const taskId = await bootAndOpenTask(launched)
  const { window } = launched

  // This replaces a test that opened and collapsed the AI rail and asserted
  // the BR-pinned minimap glided by >100px. That rail no longer exists —
  // nothing renders it and nothing could set its collapsed flag — yet the
  // pinned layer still reserved 292px of the right edge for it, so everything
  // pinned right sat 292px short of where it belonged. The inset is now zero,
  // and this is the assertion that keeps it honest.
  const widgetId = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const w = await api.widgets.create({
      taskId: tid,
      kind: 'sticky',
      title: 'pinned BR',
      content: '',
      x: 40,
      y: 40,
      width: 240,
      height: 180
    })
    await api.widgets.update(w.id, { pinned: true, pinnedZone: 'br' })
    return w.id
  }, taskId)

  // The widget was created through IPC, so the renderer's store only learns
  // about it on a reload.
  await window.reload()
  await waitForReady(window)
  await window.evaluate((tid: string) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
    w.__fbView?.getState().goTask(tid)
  }, taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8000 })
  await window.waitForTimeout(800)

  const geo = await window.evaluate((id: string) => {
    const el = document.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)
    const surf = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')
    if (!el || !surf) return null
    return {
      gapRight: Math.round(surf.getBoundingClientRect().right - el.getBoundingClientRect().right)
    }
  }, widgetId)

  expect(geo, 'the pinned widget and the surface are both present').not.toBeNull()
  // PADDING in pinLayout is 16; allow for a scrollbar gutter. Anything near
  // 292 would mean the phantom rail inset is back.
  expect(geo!.gapRight).toBeLessThan(64)
})
