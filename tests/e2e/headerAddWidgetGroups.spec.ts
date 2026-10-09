// The header's Add widget menu: use-case columns, a search box, and a wheel
// gesture that stays inside the menu.
//
// Asked for 2026-10-09: "group them in to logical use cases and also add a
// quick search bar to find the widget they are looking for", then "mouse scroll
// and swipe on the widget menu shouldnt move the canvas they should be isolated
// to just move the widget menu if it goes beyond the width. Also, for grouped
// widgets, organise vertically in columns based on category they belong to".

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

async function openMenu(window: LaunchedApp['window']) {
  const id = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.nodes.create({ parentId: null, kind: 'task', title: 'Group desk' })).id
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate((i) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
    w.__fbView?.getState().goTask(i)
  }, id)
  const btn = window.locator('[data-testid="header-add-widget"]')
  await expect(btn).toBeVisible({ timeout: 8000 })
  await btn.click()
  const menu = window.locator('[data-testid="header-add-widget-menu"]')
  await expect(menu).toBeVisible()
  return menu
}

test('AW-1 — widgets are grouped into named use-case columns', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const menu = await openMenu(window)

  const names = await menu.evaluate((el) =>
    Array.from(el.querySelectorAll('[data-testid="add-widget-group"]')).map(
      (g) => g.getAttribute('data-group') || ''
    )
  )
  // Several real groups, and the ones a desk is usually built from.
  expect(names.length).toBeGreaterThan(4)
  expect(names).toContain('Write & capture')
  expect(names).toContain('Numbers & data')

  // Nothing is stranded: every widget button lives inside a column.
  // Only the item affordances are buttons — the search box is an input and the
  // strip and the columns are divs, which is what keeps this count honest.
  const placement = await menu.evaluate((el) => ({
    buttons: el.querySelectorAll('button[data-testid^="add-widget-"]').length,
    inColumns: el.querySelectorAll(
      '[data-testid="add-widget-group"] button[data-testid^="add-widget-"]'
    ).length
  }))
  expect(placement.buttons).toBeGreaterThan(40)
  expect(placement.inColumns).toBe(placement.buttons)
  // "More" is the fallback bucket for an ungrouped kind — it should be empty.
  expect(names).not.toContain('More')
})

test('AW-2 — the search box narrows by label, by hint and by group name', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const menu = await openMenu(window)
  const search = menu.locator('[data-testid="add-widget-search"]')
  await expect(search).toBeVisible()

  // By label.
  await search.fill('sticky')
  await expect(menu.locator('[data-testid="add-widget-sticky"]')).toBeVisible()
  await expect(menu.locator('[data-testid="add-widget-table"]')).toHaveCount(0)

  // By hint: the Scratchpad's label contains no "sketch", its hint does.
  await search.fill('sketch')
  await expect(menu.locator('[data-testid="add-widget-scratchpad"]')).toBeVisible()

  // By group name: a whole column at once.
  await search.fill('numbers')
  await expect(menu.locator('[data-testid="add-widget-table"]')).toBeVisible()
  await expect(menu.locator('[data-testid="add-widget-chart"]')).toBeVisible()
  await expect(menu.locator('[data-testid="add-widget-sticky"]')).toHaveCount(0)

  // An honest empty state rather than a blank panel.
  await search.fill('zzzznotathing')
  await expect(menu.locator('[data-testid="add-widget-no-matches"]')).toBeVisible()
})

test('AW-3 — Enter adds the first match', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const menu = await openMenu(window)

  const before = await window.evaluate(() => document.querySelectorAll('[data-widget-id]').length)
  await menu.locator('[data-testid="add-widget-search"]').fill('sticky')
  await menu.locator('[data-testid="add-widget-search"]').press('Enter')
  await expect(menu).toHaveCount(0)
  await expect
    .poll(async () => window.evaluate(() => document.querySelectorAll('[data-widget-id]').length), {
      timeout: 6000
    })
    .toBeGreaterThan(before)
})

test('AW-4 — a wheel over the menu scrolls the menu and never the canvas', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const menu = await openMenu(window)

  const read = () =>
    window.evaluate(() => {
      const w = window as unknown as {
        __fbWidgets?: { getState: () => { zoom: number; panX: number; panY: number } }
      }
      const s = w.__fbWidgets!.getState()
      const strip = document.querySelector<HTMLElement>('[data-testid="add-widget-groups"]')!
      return {
        zoom: s.zoom,
        panX: s.panX,
        panY: s.panY,
        scrollLeft: Math.round(strip.scrollLeft),
        overflows: strip.scrollWidth > strip.clientWidth + 1
      }
    })

  const before = await read()
  // The strip must actually have somewhere to go, or this proves nothing.
  expect(before.overflows, 'the group strip overflows its width').toBe(true)

  const strip = menu.locator('[data-testid="add-widget-groups"]')
  await strip.hover()
  await window.mouse.wheel(0, 240)
  await window.waitForTimeout(250)

  const after = await read()
  // The canvas did not move.
  expect(after.zoom).toBeCloseTo(before.zoom, 5)
  expect(after.panX).toBeCloseTo(before.panX, 5)
  expect(after.panY).toBeCloseTo(before.panY, 5)
  // The menu did — a vertical gesture walks the columns sideways.
  expect(after.scrollLeft).toBeGreaterThan(before.scrollLeft)
})
