/**
 * WP-PATH end to end: anchor editing in the real app. Every result is read
 * back from the main process (the stored body), never eyeballed.
 *
 *   DA-1 add an anchor mid-segment (Add Anchor Point) and drag it (Direct Selection)
 *   DA-2 join two open lines into one path with ⌘J
 *   DA-3 the pen continues an open path from its end
 *   DA-4 Object › Path › Simplify… previews, cancels cleanly, and applies
 *   DA-5 the knife cuts a filled shape in two
 *   DA-6 the Anchor points panel rounds a selected corner
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, readStored, rectObject, seedDrawDoc, stagePoint, v1Body, waitForSave } from './_drawHelpers'

let app: LaunchedApp
let window: Page

test.beforeAll(async () => {
  app = await launchApp()
  window = app.window
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
})

test.afterAll(async () => {
  await app.dispose()
})

type StoredNode = { x: number; y: number; inX?: number; outX?: number }
type StoredObject = { id: string; type: string; path?: { subpaths: Array<{ closed: boolean; nodes: StoredNode[] }> } }

function objectsOf(raw: unknown): StoredObject[] {
  const layers = (raw as { layers: Array<{ kind: string; objects?: StoredObject[] }> }).layers
  return layers.filter((l) => l.kind === 'vector').flatMap((l) => l.objects ?? [])
}

function lineObject(id: string, pts: Array<[number, number]>): Record<string, unknown> {
  return {
    id,
    type: 'path',
    path: { subpaths: [{ closed: false, nodes: pts.map(([x, y]) => ({ x, y })) }] },
    fill: { type: 'none' },
    stroke: { paint: { type: 'solid', color: '#1c1917' }, width: 3 }
  }
}

const W = 800

async function at(p: { x: number; y: number }): Promise<{ x: number; y: number }> {
  return stagePoint(window, W, p)
}

async function click(p: { x: number; y: number }): Promise<void> {
  const s = await at(p)
  await window.mouse.click(s.x, s.y)
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }, steps = 6): Promise<void> {
  const a = await at(from)
  const b = await at(to)
  await window.mouse.move(a.x, a.y)
  await window.mouse.down()
  for (let i = 1; i <= steps; i++) await window.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps)
  await window.mouse.up()
}

async function tool(id: string): Promise<void> {
  await window.locator(`[data-testid="draw-tool-${id}"]`).click()
}

/** Hover a submenu of a top-level menu and run one of its items. */
async function runSubmenu(menuId: string, submenu: string, label: string): Promise<void> {
  await window.locator(`[data-testid="draw-studio-menubar-${menuId}"]`).click()
  const list = window.locator(`[data-testid="draw-studio-menubar-${menuId}-list"]`)
  await list.locator('button').filter({ hasText: submenu }).first().hover()
  await list.locator('button').filter({ hasText: label }).first().click()
}

test('DA-1 add an anchor mid-segment, then drag it with Direct Selection', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('r', 200, 200, 200, 200)]), 'Anchors 1')
  await openDocument(window, id)
  await tool('addAnchor')
  await click({ x: 300, y: 200 })
  await tool('direct')
  await drag({ x: 300, y: 200 }, { x: 300, y: 140 })
  await waitForSave(window)
  const r = objectsOf((await readStored(window, id)).raw).find((o) => o.id === 'r')!
  const nodes = r.path!.subpaths[0].nodes
  expect(nodes).toHaveLength(5)
  const added = nodes[1]
  expect(Math.abs(added.x - 300)).toBeLessThan(2)
  expect(Math.abs(added.y - 140)).toBeLessThan(2)
  // The other anchors did not move.
  expect(nodes[0]).toMatchObject({ x: 200, y: 200 })
  expect(nodes[2]).toMatchObject({ x: 400, y: 200 })
})

test('DA-2 ⌘J joins two open lines into one path', async () => {
  const id = await seedDrawDoc(window, v1Body([lineObject('a', [[100, 300], [300, 300]]), lineObject('b', [[500, 300], [340, 300]])]), 'Anchors 2')
  await openDocument(window, id)
  await tool('select')
  await click({ x: 200, y: 300 })
  const b = await at({ x: 420, y: 300 })
  await window.keyboard.down('Shift')
  await window.mouse.click(b.x, b.y)
  await window.keyboard.up('Shift')
  await window.keyboard.press('ControlOrMeta+j')
  await waitForSave(window)
  const objs = objectsOf((await readStored(window, id)).raw)
  expect(objs).toHaveLength(1)
  expect(objs[0].path!.subpaths[0].nodes.map((n) => n.x)).toEqual([100, 300, 340, 500])
  expect(objs[0].path!.subpaths[0].closed).toBe(false)
})

test('DA-3 the pen continues an open path from its end', async () => {
  const id = await seedDrawDoc(window, v1Body([lineObject('l', [[100, 100], [300, 100]])]), 'Anchors 3')
  await openDocument(window, id)
  await tool('pen')
  await click({ x: 300, y: 100 })
  await click({ x: 300, y: 300 })
  await window.keyboard.press('Enter')
  await waitForSave(window)
  const objs = objectsOf((await readStored(window, id)).raw)
  expect(objs).toHaveLength(1)
  const pts = objs[0].path!.subpaths[0].nodes.map((n) => [Math.round(n.x), Math.round(n.y)])
  expect(pts).toEqual([
    [100, 100],
    [300, 100],
    [300, 300]
  ])
})

test('DA-4 Simplify previews, cancels cleanly, and applies', async () => {
  const dense = lineObject(
    'w',
    Array.from({ length: 120 }, (_, k): [number, number] => [100 + k * 5, 300 + 80 * Math.sin(k / 12)])
  )
  const id = await seedDrawDoc(window, v1Body([dense]), 'Anchors 4')
  await openDocument(window, id)
  await tool('select')
  await click({ x: 100, y: 300 })
  await runSubmenu('object', 'Path', 'Simplify…')
  await expect(window.locator('[data-testid="draw-simplify-dialog"]')).toBeVisible()
  await expect(window.locator('[data-testid="draw-simplify-counts"]')).toContainText('Original: 120 points')
  // Cancel: the path is back exactly as it was.
  await window.locator('[data-testid="draw-simplify-cancel"]').click()
  await waitForSave(window)
  expect(objectsOf((await readStored(window, id)).raw)[0].path!.subpaths[0].nodes).toHaveLength(120)
  // Apply.
  await runSubmenu('object', 'Path', 'Simplify…')
  const counts = await window.locator('[data-testid="draw-simplify-counts"]').textContent()
  const current = Number(/Current: (\d+)/.exec(counts ?? '')?.[1])
  expect(current).toBeLessThan(120)
  await window.locator('[data-testid="draw-simplify-apply"]').click()
  await waitForSave(window)
  const nodes = objectsOf((await readStored(window, id)).raw)[0].path!.subpaths[0].nodes
  expect(nodes.length).toBe(current)
  expect(nodes[0]).toMatchObject({ x: 100, y: 300 })
})

test('DA-5 the knife cuts a filled rectangle in two', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('r', 200, 200, 200, 200)]), 'Anchors 5')
  await openDocument(window, id)
  await tool('knife')
  await drag({ x: 300, y: 160 }, { x: 300, y: 440 }, 10)
  await waitForSave(window)
  const objs = objectsOf((await readStored(window, id)).raw)
  expect(objs).toHaveLength(2)
  for (const o of objs) expect(o.path!.subpaths[0].closed).toBe(true)
})

test('DA-6 the Anchor points panel rounds a selected corner', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('r', 200, 200, 200, 200)]), 'Anchors 6')
  await openDocument(window, id)
  await tool('direct')
  await click({ x: 400, y: 200 })
  await expect(window.locator('[data-testid="draw-anchors-panel"]')).toBeVisible()
  await expect(window.locator('[data-testid="draw-anchors-count"]')).toHaveText('1 selected')
  await window.locator('[data-testid="draw-anchor-radius"]').fill('30')
  await window.locator('[data-testid="draw-anchor-round"]').click()
  await waitForSave(window)
  const nodes = objectsOf((await readStored(window, id)).raw)[0].path!.subpaths[0].nodes
  expect(nodes).toHaveLength(5)
  expect(nodes[1]).toMatchObject({ x: 370, y: 200 })
  expect(nodes[2].x).toBeCloseTo(400, 6)
  expect(nodes[2].y).toBeCloseTo(230, 6)
})
