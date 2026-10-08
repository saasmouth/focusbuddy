// The desk trail and the presence bar belong in the header as ONE menu, not as
// two controls and not floating on the desk.
//
// First pass put them side by side in the header, which was relocation rather
// than combination and was corrected: "for both the red border floating menu
// and the one with breadcrumbs to be combined into a menu that utilises
// vertical lists and is more user friendly". So there is one slot, one trigger,
// and the lists live inside it.
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

  const trigger = window.locator('[data-testid="desk-context-trigger"]').first()
  await expect(trigger).toBeVisible({ timeout: 8000 })

  const placement = await window.evaluate(() => {
    const header = document.querySelector('header')
    const trailSlot = document.getElementById('fb-header-trail')
    const triggerEl = document.querySelector('[data-testid="desk-context-trigger"]')
    return {
      slotExists: !!trailSlot,
      slotInHeader: !!header && !!trailSlot && header.contains(trailSlot),
      triggerInHeader: !!header && !!triggerEl && header.contains(triggerEl),
      // There is no second slot any more — presence is a section in the menu.
      presenceSlotGone: !document.getElementById('fb-header-presence'),
      // And neither old floating wrapper is painting.
      floatingBars: document.querySelectorAll(
        '[data-floating-menu].absolute.top-4, [data-floating-menu].absolute.top-3'
      ).length
    }
  })

  expect(placement.slotExists, 'the header exposes the slot').toBe(true)
  expect(placement.slotInHeader, 'the slot is inside the header element').toBe(true)
  expect(placement.triggerInHeader, 'the desk context trigger renders into the header').toBe(true)
  expect(placement.presenceSlotGone, 'there is no separate presence slot — it is one menu').toBe(true)
  expect(placement.floatingBars, 'neither old floating bar is rendered').toBe(0)
})
