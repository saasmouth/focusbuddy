// Shapes drawn with the same current paint must save, and survive a reload.
//
// 4.3.39-local.6 shipped a drawing that would not save: the editor handed each
// new shape the SAME fill object (the current fill), Electron's IPC carries a
// shared reference across as a shared reference, and the main process's
// argument check refused the second sighting of that object as "cyclic data"
// ("Couldn't save" in the editor). Edit › Duplicate did the same with a shallow
// copy. This spec draws in the real app, waits for the save, reloads, and reads
// the drawing back from the main process.
//
// It records the renderer's save failure line and the main-process log
// verbatim, so a run on a build without the fix shows exactly what was refused.
// Throwaway profile only (launchApp + PLEXI_APP=preview3).

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, readStored, runMenu, seedDrawDoc, stagePoint, v1Body, pickTool } from './_drawHelpers'

let app: LaunchedApp
let window: Page
const mainLog: string[] = []
const rendererLog: string[] = []

test.beforeAll(async () => {
  app = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  window = app.window
  app.app.process().stdout?.on('data', (b) => mainLog.push(String(b)))
  app.app.process().stderr?.on('data', (b) => mainLog.push(String(b)))
  window.on('console', (m) => rendererLog.push(`[${m.type()}] ${m.text()}`))
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
})

test.afterAll(async () => {
  // Print what was refused, verbatim, for the run's report.
  const refusals = [...rendererLog, ...mainLog.join('').split('\n')].filter((l) => /documents:update|persist failed|cyclic|refus/i.test(l))
  // eslint-disable-next-line no-console
  console.log(`[drawSaveSharedPaint] refusal lines (${refusals.length}):\n${refusals.join('\n') || '(none)'}`)
  await app.dispose()
})

type Obj = { id: string; type: string; shapeKind?: string; fill?: { type: string; color?: string } }
type Layer = { kind: string; objects?: Obj[] }

async function storedObjects(id: string): Promise<Obj[]> {
  return ((await readStored(window, id)).raw as { layers: Layer[] }).layers.flatMap((l) => l.objects ?? [])
}

async function drag(from: [number, number], to: [number, number]): Promise<void> {
  const a = await stagePoint(window, 800, { x: from[0], y: from[1] })
  const b = await stagePoint(window, 800, { x: to[0], y: to[1] })
  await window.mouse.move(a.x, a.y)
  await window.mouse.down()
  for (let i = 1; i <= 4; i++) await window.mouse.move(a.x + ((b.x - a.x) * i) / 4, a.y + ((b.y - a.y) * i) / 4)
  await window.mouse.up()
}

/** The save went through: no "Couldn't save" badge and no failed write logged by the renderer. */
async function expectSaved(): Promise<void> {
  // The editor debounces saves (600 ms); give the write time to land, then look.
  await window.waitForTimeout(1_500)
  await expect(window.locator('[data-testid="doc-save-error"]')).toHaveCount(0)
  expect(rendererLog.filter((l) => /persist failed|documents:update/i.test(l))).toEqual([])
}

test('SP-0 a body in which two shapes hold the SAME paint object crosses window.api to documents:update', async () => {
  // The question behind the local.6 bug: does a shared reference survive the
  // preload's contextBridge + IPC as a shared reference (and so meet main's
  // argument check)? Sent directly, with the exact error recorded if refused.
  const id = await seedDrawDoc(window, v1Body([]), 'Shared reference')
  const result = await window.evaluate(async (docId) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const paint = { type: 'solid', color: '#6d5dfc' }
    const rect = (oid: string, x: number) => ({
      id: oid,
      type: 'path',
      shapeKind: 'rect',
      path: { subpaths: [{ closed: true, nodes: [{ x, y: 0 }, { x: x + 10, y: 0 }, { x: x + 10, y: 10 }, { x, y: 10 }] }] },
      fill: paint
    })
    const body = {
      schemaVersion: 1,
      width: 800,
      height: 600,
      background: { type: 'solid', color: '#ffffff' },
      activeLayerId: 'L1',
      layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [rect('a', 0), rect('b', 20)] }]
    }
    try {
      await api.documents.update(docId, { body: body as never })
      return 'accepted'
    } catch (e) {
      return `refused: ${e instanceof Error ? e.message : String(e)}`
    }
  }, id)
  // eslint-disable-next-line no-console
  console.log(`[drawSaveSharedPaint] SP-0 documents:update with a shared paint object: ${result}`)
  expect(result).toBe('accepted')
  const stored = await storedObjects(id)
  expect(stored).toHaveLength(2)
})

async function reloadInto(id: string): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await openDocument(window, id)
}

test('SP-1 three rectangles drawn with the current fill save, and are all there after a reload', async () => {
  const id = await seedDrawDoc(window, v1Body([]), 'Shared paint')
  await openDocument(window, id)
  // The studio returns to the Selection tool after each shape, so pick Rectangle each time.
  for (const x of [50, 200, 350]) {
    await pickTool(window, 'rect')
    await drag([x, 50], [x + 100, 150])
  }
  await expectSaved()
  const before = (await storedObjects(id)).filter((o) => o.type === 'path')
  expect(before, 'all three rectangles reached the main process').toHaveLength(3)

  await reloadInto(id)
  const after = (await storedObjects(id)).filter((o) => o.type === 'path')
  expect(after).toHaveLength(3)
  const fills = after.map((o) => JSON.stringify(o.fill))
  // Drawn with the same current fill, so all three carry the same (equal, not shared) paint, and it is a real one.
  expect(new Set(fills).size).toBe(1)
  expect(after[0].fill?.type).not.toBe('none')
  await expect(window.locator('[data-testid="doc-save-error"]')).toHaveCount(0)
})

test('SP-2 Edit › Duplicate saves, and the copy is there after a reload', async () => {
  const id = await seedDrawDoc(window, v1Body([]), 'Duplicated paint')
  await openDocument(window, id)
  await pickTool(window, 'rect')
  await drag([50, 50], [150, 150])
  await expectSaved()
  // The new rectangle is selected; Duplicate it from the Edit menu.
  await runMenu(window, 'edit', 'Duplicate')
  await expectSaved()
  expect((await storedObjects(id)).filter((o) => o.type === 'path')).toHaveLength(2)

  await reloadInto(id)
  const after = (await storedObjects(id)).filter((o) => o.type === 'path')
  expect(after).toHaveLength(2)
  expect(JSON.stringify(after[0].fill)).toBe(JSON.stringify(after[1].fill))
  await expect(window.locator('[data-testid="doc-save-error"]')).toHaveCount(0)
})
