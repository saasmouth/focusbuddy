import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// A prominent, centred Add widget button whose menu teaches the quick-add keys.
// Asked for 2026-10-09: "add a purple add widget button to the header menu in
// the centre. It should drop down and be horizontal, with references to the
// quick add keyboard shortcuts in lighter grey".
//
// Revised later the same day: "for grouped widgets, organise vertically in
// columns based on category they belong to". So the menu is no longer one flat
// horizontal row. It is a row OF COLUMNS: the columns sit side by side and
// each column's items are stacked. The horizontal-ness now lives in the group
// axis, which is what the geometry check below asserts.
// Grouping, search and scroll isolation are covered in
// headerAddWidgetGroups.spec.ts.
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

test('the add button is centred, purple, and its menu teaches the shortcuts', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const id = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.nodes.create({ parentId: null, kind: 'task', title: 'Add desk' })).id
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate((i) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
    w.__fbView?.getState().goTask(i)
  }, id)

  const btn = window.locator('[data-testid="header-add-widget"]')
  await expect(btn).toBeVisible({ timeout: 8000 })

  const look = await btn.evaluate((el) => {
    const header = document.querySelector('header')!
    const b = el.getBoundingClientRect()
    const h = header.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return {
      inHeader: header.contains(el),
      // Centred on the header, within a couple of pixels.
      offCentre: Math.abs((b.left + b.width / 2) - (h.left + h.width / 2)),
      bg: cs.backgroundColor,
      fg: cs.color,
      text: el.textContent || ''
    }
  })
  expect(look.inHeader, 'lives in the header').toBe(true)
  expect(look.offCentre, 'is centred on the header').toBeLessThan(3)
  expect(look.fg).toMatch(/rgb\(255,\s*255,\s*255\)/)
  expect(look.bg).not.toBe('rgba(0, 0, 0, 0)')
  expect(look.text).toContain('Add widget')

  await btn.click()
  const menu = window.locator('[data-testid="header-add-widget-menu"]')
  await expect(menu).toBeVisible()

  // A row of columns: group columns side by side, items stacked inside one.
  const geo = await menu.evaluate((el) => {
    const cols = Array.from(el.querySelectorAll('[data-testid="add-widget-group"]'))
    const c0 = cols[0].getBoundingClientRect()
    const c1 = cols[1].getBoundingClientRect()
    const items = Array.from(cols[0].querySelectorAll('[data-testid^="add-widget-"]'))
    const a = items[0].getBoundingClientRect()
    const b = items[1].getBoundingClientRect()
    return {
      columnsSideBySide: Math.abs(c0.top - c1.top) < 2 && c1.left > c0.left,
      itemsStacked: b.top > a.top && Math.abs(a.left - b.left) < 2,
      total: el.querySelectorAll('[data-testid^="add-widget-"]').length
    }
  })
  expect(geo.columnsSideBySide, 'group columns sit side by side').toBe(true)
  expect(geo.itemsStacked, "a column's items are stacked vertically").toBe(true)
  expect(geo.total).toBeGreaterThan(5)

  // The shortcut keys are shown, they are the REAL ones, and they are quieter
  // than the label beside them.
  const keys = await menu.evaluate((el) => {
    const sticky = el.querySelector('[data-testid="add-widget-sticky"]')!
    const spans = Array.from(sticky.querySelectorAll('span'))
    const keySpan = spans[spans.length - 1]
    const labelSpan = spans[spans.length - 2]
    const lum = (c: string): number => {
      const m = c.match(/\d+/g)!.map(Number)
      return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]
    }
    return {
      key: (keySpan.textContent || '').trim(),
      keyLum: lum(getComputedStyle(keySpan).color),
      labelLum: lum(getComputedStyle(labelSpan).color),
      dark: document.documentElement.classList.contains('dark')
    }
  })
  // 'S' is the shipped default for a sticky (WIDGET_SHORTCUTS).
  expect(keys.key).toBe('S')
  // Lighter than the label: in a dark theme "lighter grey" means dimmer, in a
  // light theme it means paler. Either way the key must be the quieter of the two.
  if (keys.dark) expect(keys.keyLum).toBeLessThan(keys.labelLum)
  else expect(keys.keyLum).toBeGreaterThan(keys.labelLum)

  // And it actually adds one.
  const before = await window.evaluate(() => document.querySelectorAll('[data-widget-id]').length)
  await menu.locator('[data-testid="add-widget-sticky"]').click()
  await expect(menu).toHaveCount(0)
  await expect
    .poll(async () => window.evaluate(() => document.querySelectorAll('[data-widget-id]').length), {
      timeout: 6000
    })
    .toBeGreaterThan(before)
})
