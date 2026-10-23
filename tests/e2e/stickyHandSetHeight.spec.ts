import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

// A sticky the person grows past its content cap keeps that height (4.3.41).
//
// A sticky's height follows its content up to 640 (GROW_MAX_HEIGHT.sticky), so a
// long paste cannot swallow the desk. But that cap was also pulling back a sticky
// the person had deliberately made taller: typing in it, or simply reloading,
// snapped a 1200px sticky to 640, against the owner's "resize everything to any
// size" ruling. A height above the cap is now the person's, kept up to
// GROW_CEILING. Grown here with the frame's own Grow button, the way a person does.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

const stored = (window: Page, taskId: string, id: string): Promise<number> =>
  window.evaluate(
    async ({ taskId, id }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return ((await api.widgets.listByTask(taskId)) as Array<{ id: string; height: number }>).find((w) => w.id === id)!.height
    },
    { taskId, id }
  )

async function openDesk(window: Page, taskId: string, id: string): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.evaluate((t) => (window as unknown as { __fbView: { getState: () => { goTask: (i: string) => void } } }).__fbView.getState().goTask(t), taskId)
  await window.waitForSelector(`[data-widget-id="${id}"]`, { timeout: 15_000 })
}

test('a sticky grown to 1200 by hand keeps 1200 across a reload and while typing', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, id } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const t = await api.nodes.create({ parentId: null, kind: 'task', title: 'Tall sticky' })
    const w = await api.widgets.create({ taskId: t.id, kind: 'sticky', title: '', content: 'A short note', x: 80, y: 80, width: 240, height: 160 } as never)
    return { taskId: t.id, id: (w as { id: string }).id }
  })
  await suppressFeatureSpotlights(window)
  await window.evaluate(() => localStorage.setItem('fb.nav.prefs', JSON.stringify({ edgePanEnabled: false })))
  await openDesk(window, taskId, id)

  // Grow ×1.5 five times: 160 → 240 → 360 → 540 → 810 → 1215.
  const frame = window.locator(`[data-widget-id="${id}"]`)
  // The header folds its actions into an overflow menu when the widget is narrow
  // (a 240px sticky is), so Grow is either a header button or a menu item; both
  // carry widget-grow-<id>. A pick closes the menu, so it is reopened each time.
  for (let i = 0; i < 5; i++) {
    await frame.hover()
    const grow = window.locator(`[data-testid="widget-grow-${id}"]`)
    if (!(await grow.isVisible().catch(() => false))) await window.locator(`[data-testid="widget-overflow-${id}"]`).click()
    await grow.click()
    await window.waitForTimeout(250)
  }
  await expect.poll(() => stored(window, taskId, id), { timeout: 5_000 }).toBeGreaterThanOrEqual(1200)
  const grown = await stored(window, taskId, id)
  await window.waitForTimeout(1_500) // give auto-grow every chance to pull it back
  expect(await stored(window, taskId, id), 'auto-grow did not pull the hand-set height back to the 640 cap').toBe(grown)

  // Reload: still the person's height.
  await openDesk(window, taskId, id)
  await window.waitForTimeout(1_000)
  expect(await stored(window, taskId, id), 'kept across a reload').toBe(grown)

  // Type: the content is still far shorter than the box; the height must not move.
  await window.locator(`[data-widget-id="${id}"] .fb-sticky-rendered`).click()
  const ta = window.locator(`[data-widget-id="${id}"] textarea`)
  await expect(ta).toBeVisible()
  await ta.type(' and a little more')
  await window.waitForTimeout(1_500) // past the 600 ms save debounce
  expect(await stored(window, taskId, id), 'typing did not shrink it').toBe(grown)
})
