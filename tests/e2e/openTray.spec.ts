// The tray of open things, driven in the booted app.
//
// The property that matters most is the one a screenshot cannot show: closing
// a tab removes the TAB and leaves the desk, document or chat alone. A taskbar
// whose × could delete a document would be a trap, so it is asserted against
// the real node store rather than trusted.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

test.setTimeout(180_000)
let launched: LaunchedApp | null = null
test.afterEach(async () => { if (launched) { await launched.dispose(); launched = null } })

async function makeDesks(window: Page, names: string[]): Promise<string[]> {
  return window.evaluate(async (titles) => {
    const w = window as any
    const ids: string[] = []
    for (const title of titles) {
      const n = await w.__fbNodes.getState().create({ kind: 'task', title, parentId: null })
      ids.push(n.id)
    }
    await w.__fbNodes.getState().refresh()
    return ids
  }, names)
}

test('1. opening things fills the tray; places do not', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const ids = await makeDesks(window, ['Ridge St', 'Kipper GTM'])

  await window.evaluate((deskIds) => {
    const w = window as any
    w.__fbView.getState().goTask(deskIds[0])
    w.__fbView.getState().goTask(deskIds[1])
    // Places, not things — these must NOT appear.
    w.__fbView.getState().goHome()
    w.__fbView.getState().goTrash()
    w.__fbView.getState().goTask(deskIds[0])
  }, ids)
  await window.waitForTimeout(900)

  await expect(window.locator('[data-testid="open-tray"]')).toBeVisible({ timeout: 8000 })
  const keys = await window.evaluate(() =>
    (window as any).__fbOpenTray.getState().entries.map((e: any) => e.key)
  )
  expect(keys).toEqual([`task:${ids[0]}`, `task:${ids[1]}`])
  // Revisiting must not reorder: the tray is a set of positions.
  expect(keys[0]).toBe(`task:${ids[0]}`)
})

test('2. closing a tab removes the tab and NOT the desk', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const ids = await makeDesks(window, ['Keep me'])
  await window.evaluate((d) => (window as any).__fbView.getState().goTask(d[0]), ids)
  await window.waitForTimeout(800)

  // Hover first and click for real: the close control is hover-revealed, and a
  // forced click would pass even if it were unreachable.
  await window.locator(`[data-testid="tray-item-task:${ids[0]}"]`).hover()
  await window.locator(`[data-testid="tray-close-task:${ids[0]}"]`).click()
  await window.waitForTimeout(600)

  const after = await window.evaluate(async (deskIds) => {
    const w = window as any
    await w.__fbNodes.getState().refresh()
    return {
      tray: w.__fbOpenTray.getState().entries.length,
      deskStillThere: w.__fbNodes.getState().nodes.some((n: any) => n.id === deskIds[0])
    }
  }, ids)
  expect(after.tray).toBe(0)
  // The whole contract of the close button.
  expect(after.deskStillThere, 'closing a tab must never delete the desk').toBe(true)
})

test('3. a tab switches context, and survives a reload', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const ids = await makeDesks(window, ['Alpha', 'Beta'])
  await window.evaluate((d) => {
    const w = window as any
    w.__fbView.getState().goTask(d[0])
    w.__fbView.getState().goTask(d[1])
  }, ids)
  await window.waitForTimeout(800)

  await window.locator(`[data-testid="tray-item-task:${ids[0]}"]`).click()
  await window.waitForTimeout(500)
  expect(await window.evaluate(() => (window as any).__fbView.getState().view.taskId)).toBe(ids[0])

  // It is window state, so it has to come back.
  await window.reload()
  await waitForReady(window)
  await window.waitForTimeout(800)
  const keys = await window.evaluate(() =>
    (window as any).__fbOpenTray.getState().entries.map((e: any) => e.key)
  )
  expect(keys).toEqual([`task:${ids[0]}`, `task:${ids[1]}`])
})
