/**
 * WP-OBJ end to end: groups, clipping masks and isolation mode in the real
 * app. Drawings are seeded as v2 (groups exist only in the v2 format, whose
 * writes are still gated for drawings stored as v1); one test checks that a v1
 * drawing refuses honestly. State is read back from the main process and one
 * visible DOM consequence is checked each time. Throwaway profile only
 * (launchApp), PLEXI_APP=preview3.
 */

import { test, expect, type Page } from '@playwright/test'
import { existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, readStored, rectObject, runMenu, seedDrawDoc, stagePoint, v1Body, waitForSave } from './_drawHelpers'

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

const W = 800
const H = 600

function v2Body(objects: unknown[]): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [{ id: 'artboard-1', name: 'Artboard 1', x: 0, y: 0, w: W, h: H, background: { type: 'solid', color: '#ffffff' } }],
    activeArtboardId: 'artboard-1',
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }],
    activeLayerId: 'L1',
    assets: {},
    swatches: [],
    guides: [],
    settings: {}
  }
}

type Node = { id: string; type: string; clip?: boolean; children?: Node[]; transform?: number[]; path?: { subpaths: Array<{ nodes: Array<{ x: number; y: number }> }> } }
const objectsOf = (raw: unknown): Node[] => ((raw as { layers: Array<{ kind: string; objects?: Node[] }> }).layers.find((l) => l.kind === 'vector')?.objects ?? [])
const minX = (n: Node): number => (n.type === 'group' ? Math.min(...n.children!.map(minX)) + (n.transform?.[4] ?? 0) : Math.min(...n.path!.subpaths[0].nodes.map((p) => p.x)))

async function dragArt(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const a = await stagePoint(window, W, from)
  const b = await stagePoint(window, W, to)
  await window.mouse.move(a.x, a.y)
  await window.mouse.down()
  await window.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2)
  await window.mouse.move(b.x, b.y)
  await window.mouse.up()
}

/** Run an item in a submenu of a Draw menu (e.g. Object › Clipping Mask › Make). */
async function runSubmenu(menuId: string, submenu: string, label: string): Promise<void> {
  await window.locator(`[data-testid="draw-studio-menubar-${menuId}"]`).click()
  const list = window.locator(`[data-testid="draw-studio-menubar-${menuId}-list"]`)
  const row = list.locator('div.relative').filter({ has: window.locator('button', { hasText: submenu }) }).first()
  await row.hover()
  await row.locator('div button', { hasText: label }).first().click()
}

test('OBJ-1 draw three shapes, ⌘G groups them, the group moves as one, ⌘Z undoes the move', async () => {
  const id = await seedDrawDoc(window, v2Body([]), 'Groups')
  await openDocument(window, id)
  await window.locator('[data-testid="draw-tool-rect"]').click()
  await dragArt({ x: 100, y: 100 }, { x: 180, y: 180 })
  await dragArt({ x: 250, y: 100 }, { x: 330, y: 180 })
  await dragArt({ x: 400, y: 100 }, { x: 480, y: 180 })
  await window.locator('[data-testid="draw-tool-select"]').click()
  await window.keyboard.press('ControlOrMeta+a')
  await window.keyboard.press('ControlOrMeta+g')
  await waitForSave(window)
  let objs = objectsOf((await readStored(window, id)).raw)
  expect(objs).toHaveLength(1)
  expect(objs[0].type).toBe('group')
  expect(objs[0].children).toHaveLength(3)
  const memberIds = objs[0].children!.map((c) => c.id)
  const x0 = minX(objs[0])
  await expect(window.locator('[data-testid="draw-selection"]')).toBeVisible()

  // Drag one member: the whole group moves.
  await dragArt({ x: 290, y: 140 }, { x: 340, y: 140 })
  await waitForSave(window)
  objs = objectsOf((await readStored(window, id)).raw)
  expect(objs).toHaveLength(1)
  expect(objs[0].children!.map((c) => c.id)).toEqual(memberIds)
  expect(minX(objs[0]) - x0).toBeGreaterThan(30)

  await window.keyboard.press('ControlOrMeta+z')
  await waitForSave(window)
  objs = objectsOf((await readStored(window, id)).raw)
  expect(minX(objs[0])).toBeCloseTo(x0, 3)
  expect(objs[0].children!.map((c) => c.id)).toEqual(memberIds)
})

const STAR = {
  id: 'star',
  type: 'path',
  shapeKind: 'star',
  path: { subpaths: [{ closed: true, nodes: [{ x: 300, y: 100 }, { x: 330, y: 200 }, { x: 430, y: 200 }, { x: 350, y: 260 }, { x: 380, y: 360 }, { x: 300, y: 300 }, { x: 220, y: 360 }, { x: 250, y: 260 }, { x: 170, y: 200 }, { x: 270, y: 200 }] }] },
  fill: { type: 'solid', color: '#facc15' }
}
const ELLIPSE = rectObject('ellipse', 100, 150, 600, 150, { shapeKind: 'ellipse', fill: { type: 'solid', color: '#0ea5e9' } })

test('OBJ-2 mask a star over an ellipse (Object › Clipping Mask › Make); the canvas clips and the SVG has a clipPath', async () => {
  const id = await seedDrawDoc(window, v2Body([ELLIPSE, STAR]), 'Mask')
  await openDocument(window, id)
  await runMenu(window, 'edit', 'Select all')
  await runSubmenu('object', 'Clipping Mask', 'Make')
  await waitForSave(window)
  const stored = (await readStored(window, id)).raw
  const objs = objectsOf(stored)
  expect(objs).toHaveLength(1)
  expect(objs[0].clip).toBe(true)
  expect(objs[0].children!.map((c) => c.id)).toEqual(['ellipse', 'star'])
  // On screen: a real <clipPath> clips the ellipse.
  await expect(window.locator('[data-testid="draw-stage"] clipPath')).toHaveCount(1)

  const path = join(tmpdir(), `plexii-draw-groups-${process.pid}.svg`)
  try {
    await app.app.evaluate(async ({ dialog }, filePath) => {
      // @ts-expect-error test override of the native save dialog
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, path)
    const res = await window.evaluate(async (d) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.draw.export({ draw: d as never, title: 'mask', format: 'svg' as never })
    }, stored)
    expect(res.ok).toBe(true)
    const svg = readFileSync(path, 'utf-8')
    expect(svg).toMatch(/<clipPath id="clip-[A-Za-z0-9_-]+"><path d="M 300 100/)
    expect(svg).toMatch(/<g clip-path="url\(#clip-[A-Za-z0-9_-]+\)"><path d="M 100 150/)
  } finally {
    if (existsSync(path)) rmSync(path)
  }

  // ⌥⌘7 releases it again: still a group, no longer clipping.
  await window.keyboard.press('ControlOrMeta+Alt+7')
  await waitForSave(window)
  const released = objectsOf((await readStored(window, id)).raw)
  expect(released[0].type).toBe('group')
  expect(released[0].clip).toBeUndefined()
  await expect(window.locator('[data-testid="draw-stage"] clipPath')).toHaveCount(0)
})

test('OBJ-3 double-click a group to isolate it; the bar shows; a click selects inside; Esc leaves', async () => {
  const group = { id: 'g', type: 'group', name: 'Badge', children: [rectObject('a', 100, 100, 100, 100), rectObject('b', 300, 100, 100, 100)] }
  const id = await seedDrawDoc(window, v2Body([group, rectObject('out', 500, 400, 80, 80)]), 'Isolation')
  await openDocument(window, id)
  const p = await stagePoint(window, W, { x: 150, y: 150 })
  await window.mouse.dblclick(p.x, p.y)
  const bar = window.locator('[data-testid="draw-isolation-bar"]')
  await expect(bar).toBeVisible()
  await expect(bar).toContainText('Badge')
  await expect(window.locator('[data-testid="draw-isolation-veil"]')).toHaveCount(1)
  // Inside: drag one member, only it moves.
  await dragArt({ x: 350, y: 150 }, { x: 350, y: 250 })
  await waitForSave(window)
  const objs = objectsOf((await readStored(window, id)).raw)
  const g = objs.find((o) => o.id === 'g')!
  expect(g.children!.find((c) => c.id === 'b')!.path!.subpaths[0].nodes[0].y).toBeGreaterThan(150)
  expect(g.children!.find((c) => c.id === 'a')!.path!.subpaths[0].nodes[0].y).toBe(100)
  await window.keyboard.press('Escape')
  await expect(bar).toHaveCount(0)
})

test('OBJ-4 a drawing still written as v1 refuses to group, honestly, and Compound Path still works there', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 100, 300, 300), rectObject('b', 175, 175, 150, 150)]), 'Old format')
  await openDocument(window, id)
  await runMenu(window, 'edit', 'Select all')
  await window.locator('[data-testid="draw-studio-menubar-object"]').click()
  await expect(window.locator('[data-testid="draw-studio-menubar-object-list"] button', { hasText: 'Ungroup' })).toBeDisabled()
  await expect(window.locator('[data-testid="draw-studio-menubar-object-list"] button').filter({ hasText: /^.*Group⌘G$/ }).first()).toBeDisabled()
  await window.keyboard.press('Escape')
  await window.keyboard.press('ControlOrMeta+g')
  await waitForSave(window)
  expect(objectsOf((await readStored(window, id)).raw).map((o) => o.type)).toEqual(['path', 'path'])
  await runMenu(window, 'edit', 'Select all')
  await window.keyboard.press('ControlOrMeta+8')
  await waitForSave(window)
  const stored = await readStored(window, id)
  const objs = objectsOf(stored.raw)
  expect(objs).toHaveLength(1)
  expect(objs[0].path!.subpaths).toHaveLength(2)
  expect((stored.raw as { schemaVersion: number }).schemaVersion).toBe(1)
})
