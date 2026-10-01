import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// The table's two header rows must not sit on top of each other.
//
// They did. The view switcher carried `sticky top-[44px]`, an offset meant to
// clear the widget frame's 44px header -- but that header is OUTSIDE the table's
// scroll container, so the offset was measured from a container that already
// begins below it. The switcher was pinned 44px down from the moment it
// rendered, while the filter bar that FOLLOWS it in the DOM stayed at its
// natural position above, and the switcher (z-[9]) painted over it: "Filter" sat
// behind the Table pill and "Group" behind List.
//
// A unit test cannot see this -- both rows exist, both render, and every class
// name is spelled correctly. Only geometry shows it, which is why this is an
// e2e spec that measures boxes.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

interface Box {
  top: number
  bottom: number
  left: number
  right: number
  z: string
}

async function boxes(window: Page): Promise<{ tabs: Box | null; filters: Box | null }> {
  return window.evaluate(() => {
    const read = (el: Element | null): Box | null => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        right: Math.round(r.right),
        z: getComputedStyle(el).zIndex
      }
    }
    // The view switcher is the row holding the Table/List/Cards buttons; the
    // filter row is identified by its own control.
    const tabBtn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Table' && b.getAttribute('aria-pressed') !== null
    )
    const filterBtn = document.querySelector('[data-testid="table-filter-button"]')
    return {
      tabs: read(tabBtn?.parentElement ?? null),
      filters: read(filterBtn?.closest('div')?.parentElement ?? null)
    }
  })
}

test('the table view switcher and the filter row do not overlap', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Table layers' })
    await api.widgets.create({
      taskId: desk.id,
      kind: 'table',
      title: 'Episodes',
      content: '',
      x: 40,
      y: 40,
      width: 820,
      height: 560
    })
    return desk.id as string
  })

  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)

  await expect(window.locator('[data-testid="table-filter-button"]').first()).toBeVisible({
    timeout: 15_000
  })

  const { tabs, filters } = await boxes(window)
  expect(tabs, 'could not find the view switcher row').toBeTruthy()
  expect(filters, 'could not find the filter row').toBeTruthy()

  // The filter row sits BELOW the tabs, with no vertical overlap. Stated as
  // "starts at or after the tabs end" rather than comparing midpoints, because
  // the failure was a partial overlap of a few pixels, which a midpoint test
  // would have sailed straight through.
  expect(
    filters!.top,
    `the filter row (top ${filters!.top}) overlaps the view switcher (bottom ${tabs!.bottom})`
  ).toBeGreaterThanOrEqual(tabs!.bottom)
})
