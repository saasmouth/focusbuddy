import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, openNewDesk, type LaunchedApp } from './_helpers'

// History. 2026-10-09: "add a purple add widget button to the header menu in
// the centre. It should drop down and be horizontal, with references to the
// quick add keyboard shortcuts in lighter grey" — then grouped into columns.
//
// Superseded 4.3.32: the owner removed the header Add widget button (and the
// hover palette). Widgets are added from the side menu's Widgets section —
// click for a widget file, drag onto the desk, right-click → Add to this desk —
// with the command palette as the keyboard path ("Add <widget> to desk").
//
// What survives of the original ask is that the quick-add keys are TAUGHT
// where a widget is added by keyboard: the palette row for a kind prints its
// real shortcut, quieter than the label. This spec now pins that, plus the
// removal itself.
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

test('the header has no Add widget button; the side menu Widgets section is there instead', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openNewDesk(window, 'Add desk')

  await expect(window.locator('[data-testid="header-add-widget"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="header-add-widget-menu"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="sidemenu-widgets"]')).toBeVisible({ timeout: 8000 })
  // The load meter kept the header's centre slot.
  await expect(window.locator('header [data-testid="load-meter"]')).toHaveCount(1)
})

test('the command palette adds a widget to the desk and teaches its quick-add key', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const deskId = await openNewDesk(window, 'Palette desk')

  await window.keyboard.press('ControlOrMeta+k')
  const input = window.locator('[data-testid="command-palette-input"]')
  await expect(input).toBeVisible({ timeout: 4000 })
  await input.fill('add sticky')
  const row = window.locator('[data-testid="palette-row-add-sticky"]')
  await expect(row).toBeVisible()
  await expect(row).toContainText('Add Sticky work widget to desk')

  // 'S' is the shipped default for a sticky (WIDGET_SHORTCUTS), shown quieter
  // than the label beside it.
  const keys = await row.evaluate((el) => {
    const kbd = Array.from(el.querySelectorAll('kbd, span')).find((n) => (n.textContent || '').trim() === 'S')
    return { hasKey: !!kbd }
  })
  expect(keys.hasKey, 'the S quick-add key is shown on the row').toBe(true)

  await row.click()
  // It made a widget FILE and placed it: the desk holds a linked sticky.
  await expect
    .poll(
      async () =>
        window.evaluate(async (id) => {
          const ws = await (window as unknown as { api: typeof window.api }).api.widgets.listByTask(id)
          return ws.filter((w) => w.kind === 'sticky' && (w.syncGroupId ?? '').startsWith('wf:')).length
        }, deskId),
      { timeout: 6000 }
    )
    .toBe(1)
})
