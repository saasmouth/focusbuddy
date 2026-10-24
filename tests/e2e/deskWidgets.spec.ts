/**
 * Widgets are added from the side menu's Widgets section (4.3.32): its tiles
 * (`sidemenu-widget-<kind>`) can be dragged onto the canvas to create that
 * widget, or clicked to make a standalone widget file. (History: a left-sidebar
 * "Widgets" section, then the floating WidgetPalette with `palette-add-<kind>`
 * chips, which 4.3.32 removed in favour of this section — see
 * docs/widget-files.md.)
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

test('DW-1 dragging a Widgets tile onto the desk creates that widget', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    const taskId = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const t = await api.nodes.create({ parentId: null, kind: 'task', title: 'Widget Desk' })
      return t.id
    })
    await window.reload()
    await waitForReady(window)
    await window.getByRole('button', { name: /Widget Desk/ }).first().click()
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })

    // The office kinds stay draggable from their app tiles under Apps.
    await expect(window.locator('[data-testid="office-sideapp-docs"]')).toHaveAttribute('draggable', 'true')
    await expect(window.locator('[data-testid="office-sideapp-sheets"]')).toHaveAttribute('draggable', 'true')

    // Drive the tile's real dragstart, then drop onto the canvas with the same
    // DataTransfer (the renderer reads dataTransfer.getData in its handlers).
    await expect(window.locator('[data-testid="sidemenu-widget-sticky"]')).toBeVisible({ timeout: 4_000 })
    const result = await window.evaluate(() => {
      const chip = document.querySelector('[data-testid="sidemenu-widget-sticky"]')
      const surface = document.querySelector('[data-canvas-surface="true"]')
      if (!chip || !surface) return { ok: false, kind: '' }
      const dt = new DataTransfer()
      chip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      const kind = dt.getData('application/x-plexii-widget-new-file')
      const rect = surface.getBoundingClientRect()
      const clientX = rect.left + rect.width / 2
      const clientY = rect.top + rect.height / 2
      for (const type of ['dragenter', 'dragover', 'drop']) {
        surface.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY })
        )
      }
      return { ok: true, kind }
    })
    // The tile's dragstart set the widget kind, so the drop knows what to create.
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('sticky')

    await window.waitForTimeout(800)
    const stickies = await window.evaluate(async (id: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const ws = await api.widgets.listByTask(id)
      return ws.filter((w) => w.kind === 'sticky').length
    }, taskId)
    expect(stickies).toBeGreaterThanOrEqual(1)
  } finally {
    await dispose()
  }
})

// Superseded 4.3.32: "the widget palette is desk-only". The palette is gone;
// the Widgets section is in the menu everywhere, because a widget no longer
// needs a desk — clicking one makes a widget file. What stays desk-only is
// putting one ON a desk: "Add to this desk" only works when a desk is open (off
// a desk it is shown disabled with the reason, SPEC §9.5).
test('DW-2 Widgets work without a desk; "Add to this desk" works only on a desk', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await expect(window.locator('[data-testid="palette-add-button"]')).toHaveCount(0)
    const tile = window.locator('[data-testid="sidemenu-widget-sticky"]')
    await expect(tile).toBeVisible({ timeout: 4_000 })
    await tile.click({ button: 'right' })
    const menu = window.locator('[data-canvas-ctx-menu]')
    await expect(menu.getByText('New sticky work widget')).toBeVisible()
    // SPEC §9.5 (menu contract): an action that applies but not right now stays
    // in the menu, disabled, saying why — it used to be left out.
    const add = menu.locator('[data-testid="ctx-add-to-this-desk"]')
    await expect(add).toBeDisabled()
    await expect(add).toContainText('Open a desk first')
  } finally {
    await dispose()
  }
})

test('DW-3 a top-level folder-desk opens as a canvas, with the Widgets section beside it', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    // Create a top-level folder (a desk) and open it via the view store.
    const id = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const f = await api.nodes.create({ parentId: null, kind: 'folder', title: 'Folder Desk' })
      return f.id
    })
    // Reload so the node store hydrates the new folder, then open it.
    await window.reload()
    await waitForReady(window)
    await window.evaluate((pid: string) => {
      const w = window as unknown as { __fbView?: { getState: () => { goProject: (p: string) => void } } }
      w.__fbView?.getState().goProject(pid)
    }, id)
    // A folder-desk opens as a canvas with the floating toolbar. (Until 4.3.32
    // the toolbar held the widget palette; widgets are added from the side
    // menu's Widgets section now.)
    await expect(window.locator('[data-canvas-surface="true"]')).toBeVisible({ timeout: 8_000 })
    await expect(window.locator('[data-testid="sidemenu-widgets"]')).toBeVisible({ timeout: 4_000 })
  } finally {
    await dispose()
  }
})
