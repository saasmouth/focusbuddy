import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, openNewDesk, type LaunchedApp } from './_helpers'

// History. The header's Add widget menu had use-case columns, a search box and
// a wheel gesture isolated to the menu (asked for 2026-10-09: "group them in to
// logical use cases and also add a quick search bar", "mouse scroll and swipe
// on the widget menu shouldnt move the canvas").
//
// Superseded 4.3.32: that menu was removed with the header button. Its jobs
// moved, and these tests follow them:
//   - grouping → each Widgets tile is coloured by its use-case group, and the
//     list is split into the main eight and a collapsible "Other widgets";
//   - search → the command palette ("Add <widget> to desk"), which matches by
//     label and by kind;
//   - wheel isolation → the side menu is not on the canvas, so a wheel over it
//     must never pan or zoom the desk.
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

test('AW-1 — every widget is in the main list or under Other widgets, coloured by its group', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openNewDesk(window, 'Group desk')

  const main = window.locator('[data-testid="sidemenu-widgets-main"] [data-testid^="sidemenu-widget-"]')
  await expect(main.first()).toBeVisible({ timeout: 8000 })
  expect(await main.count()).toBe(8)

  await window.locator('[data-testid="sidemenu-other-widgets-toggle"]').click()
  const other = window.locator('[data-testid="sidemenu-other-widgets"] [data-testid^="sidemenu-widget-"]')
  await expect(other.first()).toBeVisible()
  expect(await other.count()).toBeGreaterThan(10)

  // Coloured: the icon carries a hue class, not the grey ink of a bare icon.
  const tones = await window.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="sidemenu-widget-"] .material-symbols-rounded, [data-testid^="sidemenu-widget-"] svg, [data-testid^="sidemenu-widget-"] span'))
      .map((n) => (n as HTMLElement).className?.toString() ?? '')
      .filter((c) => /text-(amber|emerald|sky|orange|fuchsia|pink|indigo|violet|slate|lime)-/.test(c)).length
  )
  expect(tones).toBeGreaterThan(8)
})

test('AW-2 — the command palette finds a widget by name or kind', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openNewDesk(window, 'Search desk')

  await window.keyboard.press('ControlOrMeta+k')
  const input = window.locator('[data-testid="command-palette-input"]')
  await expect(input).toBeVisible({ timeout: 4000 })
  await input.fill('add scratchpad')
  await expect(window.locator('[data-testid="palette-row-add-scratchpad"]')).toBeVisible()
  await input.fill('add table')
  // The palette ranks rather than filters ("add" alone matches every Add row),
  // so the asked-for widget must rank above the others.
  await expect(window.locator('[data-testid="palette-row-add-table"]')).toBeVisible()
  const order = await window.evaluate(() =>
    Array.from(document.querySelectorAll('[role="listbox"] [role="option"]')).map((el) => el.getAttribute('data-testid'))
  )
  const tableAt = order.indexOf('palette-row-add-table')
  const stickyAt = order.indexOf('palette-row-add-sticky')
  expect(tableAt).toBeGreaterThanOrEqual(0)
  if (stickyAt >= 0) expect(tableAt).toBeLessThan(stickyAt)
})

test('AW-3 — Enter on the palette adds the highlighted widget', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openNewDesk(window, 'Enter desk')

  const before = await window.evaluate(() => document.querySelectorAll('[data-widget-id]').length)
  await window.keyboard.press('ControlOrMeta+k')
  const input = window.locator('[data-testid="command-palette-input"]')
  await expect(input).toBeVisible({ timeout: 4000 })
  await input.fill('add sticky to desk')
  await expect(window.locator('[data-testid="palette-row-add-sticky"]')).toBeVisible()
  await input.press('Enter')
  await expect
    .poll(async () => window.evaluate(() => document.querySelectorAll('[data-widget-id]').length), { timeout: 6000 })
    .toBeGreaterThan(before)
})

test('AW-4 — a wheel over the Widgets section never moves the canvas', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openNewDesk(window, 'Wheel desk')

  const read = () =>
    window.evaluate(() => {
      const w = window as unknown as { __fbWidgets?: { getState: () => { zoom: number; panX: number; panY: number } } }
      const s = w.__fbWidgets!.getState()
      return { zoom: s.zoom, panX: s.panX, panY: s.panY }
    })
  const before = await read()
  const section = window.locator('[data-testid="sidemenu-widgets"]')
  await section.scrollIntoViewIfNeeded()
  await section.hover()
  await window.mouse.wheel(0, 400)
  await window.mouse.wheel(300, 0)
  await window.waitForTimeout(300)
  expect(await read()).toEqual(before)
})
