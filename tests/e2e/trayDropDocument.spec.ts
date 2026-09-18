// Dragging a document onto a desk tab in the tray.
//
// Driven through the real DataTransfer rather than by calling the handler, so
// what is asserted is that the gesture works: the tab accepts the drop, the
// widget lands on the RIGHT desk, and it points at the document rather than
// copying it.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

test.setTimeout(180_000)
let launched: LaunchedApp | null = null
test.afterEach(async () => { if (launched) { await launched.dispose(); launched = null } })

async function setup(window: Page): Promise<{ deskA: string; deskB: string; docId: string }> {
  return window.evaluate(async () => {
    const w = window as any
    const a = await w.__fbNodes.getState().create({ kind: 'task', title: 'Desk A', parentId: null })
    const b = await w.__fbNodes.getState().create({ kind: 'task', title: 'Desk B', parentId: null })
    await w.__fbNodes.getState().refresh()
    const created = await (window as any).api.documents.create({
      docType: 'sheet',
      title: 'Budget tracker'
    })
    // Both desks and the document go in the tray.
    w.__fbView.getState().goTask(a.id)
    w.__fbView.getState().goTask(b.id)
    return { deskA: a.id, deskB: b.id, docId: created.id }
  })
}

test('a document dropped on a desk tab lands on THAT desk', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { deskA, deskB, docId } = await setup(window)
  await window.waitForTimeout(1000)

  // A real drag: write our payload into a DataTransfer and dispatch the events
  // the browser would.
  const dropped = await window.evaluate(
    ({ deskId, docId }) => {
      const tab = document.querySelector(`[data-testid="tray-item-task:${deskId}"]`)
      if (!tab) return 'no tab'
      const target = tab.parentElement as HTMLElement // the row that carries the handlers
      const dt = new DataTransfer()
      dt.setData(
        'application/x-plexii-document',
        JSON.stringify({ documentId: docId, docType: 'sheet', title: 'Budget tracker' })
      )
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      return 'dispatched'
    },
    { deskId: deskA, docId }
  )
  expect(dropped).toBe('dispatched')
  await window.waitForTimeout(1200)

  const onA = await window.evaluate((d) => (window as any).api.widgets.listByTask(d), deskA)
  const onB = await window.evaluate((d) => (window as any).api.widgets.listByTask(d), deskB)

  expect(onA, 'the document should be on the desk it was dropped on').toHaveLength(1)
  expect(onA[0].kind).toBe('sheet')
  // Points AT the document rather than copying it.
  expect(onA[0].content).toBe(docId)
  expect(onB, 'and not on the other desk').toHaveLength(0)
})

test('a drag from outside the app is ignored', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { deskA } = await setup(window)
  await window.waitForTimeout(1000)

  await window.evaluate((deskId) => {
    const tab = document.querySelector(`[data-testid="tray-item-task:${deskId}"]`)
    const target = tab!.parentElement as HTMLElement
    const dt = new DataTransfer()
    dt.setData('text/plain', 'https://example.com')
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, deskA)
  await window.waitForTimeout(800)

  const onA = await window.evaluate((d) => (window as any).api.widgets.listByTask(d), deskA)
  expect(onA, 'a foreign drag must create nothing').toHaveLength(0)
})
