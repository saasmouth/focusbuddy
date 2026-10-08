// The desk trail and the presence bar belong in the header, not floating on the
// desk. Asked for 2026-10-09: "move both top floating bars containing
// breadcrumbs and red border menu to the header bar and combine them".
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

test('the trail and presence render inside the header, not over the canvas', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const id = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.nodes.create({ parentId: null, kind: 'task', title: 'Header chrome desk' })).id
  })
  // Reload so the node store actually holds the desk that was created through
  // the API — Canvas derives activeTask from the store, and without this the
  // breadcrumb has no task and correctly renders nothing.
  await window.reload()
  await waitForReady(window)
  await window.evaluate((i) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
    w.__fbView?.getState().goTask(i)
  }, id)

  const crumb = window.locator('[data-testid="canvas-breadcrumb"]').first()
  await expect(crumb).toBeVisible({ timeout: 8000 })

  const placement = await window.evaluate(() => {
    const header = document.querySelector('header')
    const trailSlot = document.getElementById('fb-header-trail')
    const presenceSlot = document.getElementById('fb-header-presence')
    const crumbEl = document.querySelector('[data-testid="canvas-breadcrumb"]')
    return {
      slotsExist: !!trailSlot && !!presenceSlot,
      slotsInHeader: !!header && !!trailSlot && header.contains(trailSlot) && !!presenceSlot && header.contains(presenceSlot),
      crumbInHeader: !!header && !!crumbEl && header.contains(crumbEl),
      // The old floating wrappers must not also be painting.
      floatingTrailCount: document.querySelectorAll(
        '[data-floating-menu].absolute.top-4'
      ).length,
      // The trail must sit left of presence, reading as one row.
      trailLeftOfPresence:
        !!trailSlot && !!presenceSlot &&
        trailSlot.getBoundingClientRect().left < presenceSlot.getBoundingClientRect().left
    }
  })

  expect(placement.slotsExist, 'the header exposes both slots').toBe(true)
  expect(placement.slotsInHeader, 'both slots are inside the header element').toBe(true)
  expect(placement.crumbInHeader, 'the breadcrumb renders into the header').toBe(true)
  expect(placement.floatingTrailCount, 'the old floating trail bar is not also rendered').toBe(0)
  expect(placement.trailLeftOfPresence, 'trail reads before presence').toBe(true)
})
