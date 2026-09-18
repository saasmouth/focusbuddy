// "Send to desk" — the control for everyone who never discovers the drag.
//
// Dragging a tray tab onto a desk tab works, but a gesture with no visible
// affordance is a feature nobody finds, which is exactly what the user hit.
// The tray's own menu offers every desk by name, so the same outcome is
// reachable by pointing at it.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

test.setTimeout(180_000)
let launched: LaunchedApp | null = null
test.afterEach(async () => { if (launched) { await launched.dispose(); launched = null } })

async function openTrayMenu(window: Page, key: string): Promise<void> {
  await window.evaluate((k) => {
    const el = document.querySelector(`[data-testid="tray-item-${k}"]`) as HTMLElement | null
    el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  }, key)
  await window.waitForTimeout(400)
}

test('a document in the tray can be sent to a named desk without dragging', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { deskId, otherId, docId } = await window.evaluate(async () => {
    const w = window as any
    const desk = await w.__fbNodes.getState().create({ kind: 'task', title: 'Q4 launch', parentId: null })
    const other = await w.__fbNodes.getState().create({ kind: 'task', title: 'Somewhere else', parentId: null })
    await w.__fbNodes.getState().refresh()
    const d = await w.api.documents.create({ docType: 'doc', title: 'Launch notes' })
    w.__fbView.getState().goOffice(undefined, d.id)
    return { deskId: desk.id as string, otherId: other.id as string, docId: d.id as string }
  })
  await window.waitForTimeout(1200)

  await openTrayMenu(window, `document:${docId}`)
  const menu = window.locator(`[data-testid="tray-menu-document:${docId}"]`)
  await expect(menu, 'the tray menu should open on right-click').toBeVisible()
  await expect(menu, 'and offer the desks by name').toContainText('Q4 launch')

  await window.locator(`[data-testid="tray-send-document:${docId}-${deskId}"]`).click()
  await window.waitForTimeout(1200)

  const onDesk = await window.evaluate((id) => (window as any).api.widgets.listByTask(id), deskId)
  const onOther = await window.evaluate((id) => (window as any).api.widgets.listByTask(id), otherId)
  expect(onDesk, 'it should land on the desk that was chosen').toHaveLength(1)
  expect(onDesk[0].kind).toBe('doc')
  // Points AT the document rather than copying it.
  expect(onDesk[0].content).toBe(docId)
  expect(onOther, 'and nowhere else').toHaveLength(0)
})

test('a desk tab offers no Send to desk — only documents can be filed', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const w = window as any
    const desk = await w.__fbNodes.getState().create({ kind: 'task', title: 'Q4 launch', parentId: null })
    await w.__fbNodes.getState().refresh()
    w.__fbView.getState().goTask(desk.id)
    return desk.id as string
  })
  await window.waitForTimeout(1200)

  await openTrayMenu(window, `task:${deskId}`)
  const menu = window.locator(`[data-testid="tray-menu-task:${deskId}"]`)
  await expect(menu).toBeVisible()
  // Pin / close the others / close all, and nothing about filing.
  await expect(menu).not.toContainText('Send to desk')
})
