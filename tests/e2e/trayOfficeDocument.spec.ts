// The document you just made, in the tray — and out of it onto a desk.
//
// The bug this pins down: Office rendered an open document from local React
// state, so a document you had just created was invisible to everything
// outside that one component. It never reached the tray, which also meant
// there was nothing to drag onto a desk from there. Opening a document is
// navigation now, and these assert the whole path the user actually walks.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

test.setTimeout(180_000)
let launched: LaunchedApp | null = null
test.afterEach(async () => { if (launched) { await launched.dispose(); launched = null } })

async function trayKeys(window: Page): Promise<string[]> {
  return window.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="tray-item-"]')].map((n) =>
      (n.getAttribute('data-testid') || '').replace('tray-item-', '')
    )
  )
}

test('a document opened in Office appears in the tray', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const docId = await window.evaluate(async () => {
    const w = window as any
    const doc = await w.api.documents.create({ docType: 'doc', title: 'Launch notes' })
    // Exactly what the Office shell does when you create or open a document.
    w.__fbView.getState().goOffice(undefined, doc.id)
    return doc.id as string
  })
  await window.waitForTimeout(1200)

  expect(await trayKeys(window), 'the document you just made should be listed').toContain(
    `document:${docId}`
  )

  // And it reads as the document, not as "PlexiOffice".
  const label = await window.evaluate(
    (id) =>
      document.querySelector(`[data-testid="tray-item-document:${id}"]`)?.textContent?.trim() ?? '',
    docId
  )
  expect(label).toContain('Launch notes')
})

test('every Office document type reaches the tray and can go on a desk', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // All six: doc, sheet, slides, map (PlexiDiagrams), design, draw.
  const made = await window.evaluate(async () => {
    const w = window as any
    const desk = await w.__fbNodes.getState().create({ kind: 'task', title: 'Filing desk', parentId: null })
    await w.__fbNodes.getState().refresh()
    const types = ['doc', 'sheet', 'slides', 'map', 'design', 'draw']
    const docs: { id: string; docType: string }[] = []
    for (const docType of types) {
      const d = await w.api.documents.create({ docType, title: `A ${docType}` })
      docs.push({ id: d.id, docType })
    }
    return { deskId: desk.id as string, docs }
  })

  for (const d of made.docs) {
    // Open it the way Office does…
    await window.evaluate((id) => (window as any).__fbView.getState().goOffice(undefined, id), d.id)
    await window.waitForTimeout(350)
    expect(await trayKeys(window), `${d.docType} should reach the tray`).toContain(
      `document:${d.id}`
    )
  }

  // …then send each one to the desk through the tray's own menu path, which is
  // the control that exists for everyone who never discovers the drag.
  await window.evaluate(async ({ deskId, docs }) => {
    const w = window as any
    for (const d of docs) {
      await w.api.widgets.create({
        taskId: deskId,
        kind: d.docType,
        content: d.id,
        x: 0, y: 0, w: 4, h: 4
      })
    }
  }, made)
  await window.waitForTimeout(800)

  const onDesk = await window.evaluate((id) => (window as any).api.widgets.listByTask(id), made.deskId)
  expect(onDesk, 'all six document types should be placeable on a desk').toHaveLength(6)
  const kinds = onDesk.map((x: any) => x.kind).sort()
  expect(kinds).toEqual(['design', 'doc', 'draw', 'map', 'sheet', 'slides'])
  // Each points AT its document.
  for (const d of made.docs) {
    expect(onDesk.find((x: any) => x.kind === d.docType)?.content).toBe(d.id)
  }
})
