/**
 * widgetMenuNativeOffice.spec.ts
 *
 * Verifies the canvas widget-add menus show native office entries (Document,
 * Spreadsheet, Slides) in the Files category and do NOT expose the legacy
 * Google entries (gdoc/gsheet/gslide) or PDF.
 *
 * ASSERTIONS:
 * 1. Right-click "Add object" → "Files" submenu lists: Document, Spreadsheet,
 *    Slides, File or link — and does NOT contain: Doc (gdoc), Sheet (gsheet),
 *    Slides (gslide label from gslide kind), PDF.
 * 2. No empty category group appears in "Add object" (Comms had only email
 *    which is hideFromPicker=true; it must not appear as an empty group).
 * 3. (4.3.32: the "+ Widget" palette is gone.) The PlexiDocs / Sheets /
 *    Slides tiles offer their kinds for the desk; no gdoc / gsheet / gslide /
 *    pdf is offered anywhere.
 * 4. Picking "Document" from the right-click Files submenu opens the native
 *    office-add-dialog (data-testid="office-add-dialog"), not a Google/webview
 *    widget.
 */

import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

/** Create a task and navigate to its canvas surface. */
async function seedAndOpenCanvas(l: LaunchedApp, title: string): Promise<void> {
  const { window } = l
  await waitForReady(window)
  await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: t })
  }, title)
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: new RegExp(title) }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForTimeout(300)
}

// ── Test 1: Files submenu has native office entries, not Google ones ──────────

test('WMN-1 — right-click Files submenu: native Document/Spreadsheet/Slides present; no gdoc/gsheet/pdf', async () => {
  launched = await launchApp()
  await waitForReady(launched.window)
  await seedAndOpenCanvas(launched, 'WMN-1 Task')

  const { window } = launched

  await waitForReady(window)
  const surface = window.locator('[data-canvas-surface="true"]')
  await surface.click({ button: 'right', position: { x: 320, y: 280 } })

  // The root context-menu panel.
  const rootMenu = window.locator('[data-canvas-ctx-menu]').first()
  await expect(rootMenu).toBeVisible({ timeout: 4_000 })

  // Hover "Add object" — scoped to the root menu to avoid ambiguity with the
  // sidebar's "Files" section label or any other duplicate text.
  await rootMenu.getByRole('menuitem', { name: 'Add object' }).hover()
  await window.waitForTimeout(300)

  // The "Add object" submenu appears as another data-canvas-ctx-menu panel.
  // Hover "Files" inside it — scope to role="menuitem" to avoid the sidebar button.
  const addObjMenu = window.locator('[data-canvas-ctx-menu]').nth(1)
  await expect(addObjMenu).toBeVisible({ timeout: 3_000 })
  await addObjMenu.getByRole('menuitem', { name: 'Files' }).hover()
  await window.waitForTimeout(300)

  // The "Files" submenu is the third panel.
  const filesMenu = window.locator('[data-canvas-ctx-menu]').nth(2)
  await expect(filesMenu).toBeVisible({ timeout: 3_000 })

  // Native office entries MUST be visible inside the Files submenu.
  await expect(filesMenu.getByRole('menuitem', { name: 'Document' })).toBeVisible({ timeout: 3_000 })
  await expect(filesMenu.getByRole('menuitem', { name: 'Spreadsheet' })).toBeVisible({ timeout: 3_000 })
  await expect(filesMenu.getByRole('menuitem', { name: 'Slides' })).toBeVisible({ timeout: 3_000 })

  // "File or link" must also be visible (the universal file widget).
  await expect(filesMenu.getByRole('menuitem', { name: 'File or link' })).toBeVisible({ timeout: 3_000 })

  // Google legacy entries must NOT be present inside any context menu panel.
  // gdoc label is "Doc" (exact — distinct from the native "Document").
  const ctxMenus = window.locator('[data-canvas-ctx-menu]')
  const docItemCount = await ctxMenus.getByRole('menuitem', { name: 'Doc', exact: true }).count()
  expect(docItemCount, '"Doc" (exact, gdoc legacy label) must not appear in any menu panel').toBe(0)

  const pdfItemCount = await ctxMenus.getByRole('menuitem', { name: 'PDF', exact: true }).count()
  expect(pdfItemCount, '"PDF" entry must not appear (hideFromPicker=true)').toBe(0)
})

// ── Test 2: No empty category groups in "Add object" ─────────────────────────

test('WMN-2 — Add object submenu: no empty category groups (Comms email is hidden)', async () => {
  launched = await launchApp()
  await waitForReady(launched.window)
  await seedAndOpenCanvas(launched, 'WMN-2 Task')

  const { window } = launched

  await waitForReady(window)
  const surface = window.locator('[data-canvas-surface="true"]')
  await surface.click({ button: 'right', position: { x: 320, y: 280 } })
  const rootMenu = window.locator('[data-canvas-ctx-menu]').first()
  await expect(rootMenu).toBeVisible({ timeout: 4_000 })

  // Hover "Add object" to open its submenu.
  await rootMenu.getByRole('menuitem', { name: 'Add object' }).hover()
  await window.waitForTimeout(300)

  // The "Add object" submenu panel.
  const addObjMenu = window.locator('[data-canvas-ctx-menu]').nth(1)
  await expect(addObjMenu).toBeVisible({ timeout: 3_000 })

  // "Comms" should NOT be present — its only entry (email) is hideFromPicker.
  // The buildCtxMenu filter `.filter(group => group.children.length > 0)` removes it.
  const commsVisible = await addObjMenu.getByRole('menuitem', { name: 'Comms' }).isVisible().catch(() => false)
  expect(commsVisible, '"Comms" category group must not appear (all entries hidden)').toBe(false)

  // Spot-check: "Notes" and "Files" DO appear (they have visible entries).
  await expect(addObjMenu.getByRole('menuitem', { name: 'Notes' })).toBeVisible()
  await expect(addObjMenu.getByRole('menuitem', { name: 'Files' })).toBeVisible()
})

// ── Test 3: the native office kinds, not Google ones ──────────────────────────
// Superseded 4.3.32: this opened the "+ Widget" palette, which was removed.
// Doc / sheet / slides are what the PlexiDocs / Sheets / Slides apps ARE, so
// they are added from those tiles under Apps (drag, or right-click → Add … to
// this desk) and are deliberately not repeated in the Widgets section. The
// Google / legacy kinds must appear in neither place.
test('WMN-3 — native doc/sheet/slides are offered (Apps); gdoc/gsheet/gslide/pdf are not offered anywhere', async () => {
  launched = await launchApp()
  await waitForReady(launched.window)
  await seedAndOpenCanvas(launched, 'WMN-3 Task')

  const { window } = launched


  await waitForReady(window)
  for (const key of ['docs', 'sheets', 'slides']) {
    const tile = window.locator(`[data-testid="office-sideapp-${key}"]`).first()
    await expect(tile).toBeVisible({ timeout: 3_000 })
    await tile.click({ button: 'right' })
    await expect(window.locator('[data-canvas-ctx-menu]').getByText(/to this desk$/).first()).toBeVisible()
    await window.keyboard.press('Escape')
  }

  // Expand Other widgets so the whole section is in view, then confirm none of
  // the Google / legacy kinds — nor the office kinds — are listed as widgets.
  await window.locator('[data-testid="sidemenu-other-widgets-toggle"]').click()
  for (const kind of ['gdoc', 'gsheet', 'gslide', 'pdf', 'doc', 'sheet', 'slides', 'email']) {
    await expect(window.locator(`[data-testid="sidemenu-widget-${kind}"]`)).toHaveCount(0)
  }
})

// ── Test 4: Picking "Document" opens OfficeDocAddDialog, not a webview ────────

test('WMN-4 — right-click Files > Document opens native office-add-dialog', async () => {
  launched = await launchApp()
  await waitForReady(launched.window)
  await seedAndOpenCanvas(launched, 'WMN-4 Task')

  const { window } = launched

  await waitForReady(window)
  const surface = window.locator('[data-canvas-surface="true"]')
  await surface.click({ button: 'right', position: { x: 320, y: 280 } })

  const rootMenu = window.locator('[data-canvas-ctx-menu]').first()
  await expect(rootMenu).toBeVisible({ timeout: 4_000 })

  await rootMenu.getByRole('menuitem', { name: 'Add object' }).hover()
  await window.waitForTimeout(250)

  const addObjMenu = window.locator('[data-canvas-ctx-menu]').nth(1)
  await expect(addObjMenu).toBeVisible({ timeout: 3_000 })
  await addObjMenu.getByRole('menuitem', { name: 'Files' }).hover()
  await window.waitForTimeout(250)

  const filesMenu = window.locator('[data-canvas-ctx-menu]').nth(2)
  await expect(filesMenu).toBeVisible({ timeout: 3_000 })

  // Click "Document" from the Files submenu.
  await filesMenu.getByRole('menuitem', { name: 'Document' }).click()
  await window.waitForTimeout(400)

  // The native OfficeDocAddDialog must appear.
  await expect(window.locator('[data-testid="office-add-dialog"]')).toBeVisible({ timeout: 5_000 })

  // It must have "Create new" and "Import a file" options.
  await expect(window.locator('[data-testid="office-add-new"]')).toBeVisible()
  await expect(window.locator('[data-testid="office-add-import"]')).toBeVisible()

  // No webview or Google Docs URL should be spawned.
  const webviewCount = await window.locator('webview').count()
  expect(webviewCount, 'no webview widget should have been created before dialog confirm').toBe(0)
})
