/**
 * WP-ARTBOARD end to end: draw a second artboard with the Artboard tool (⇧O)
 * on the pasteboard, add a third from Object › Artboards, rearrange them in
 * two columns, export a PDF with one page per artboard and a PNG per
 * artboard, go from artboard to artboard, Paste on All Artboards, and rename
 * one in the Artboards panel -- read back from the stored drawing and from
 * the files written. Throwaway profile (launchApp), PLEXI_APP=preview3; the
 * Save dialog is replaced in the main process.
 */

import { test, expect, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { barTab, keepNoticesOutOfTheWay, openDocument, openDrawPanel, readStored, rectObject, seedDrawDoc, v1Body } from './_drawHelpers'

let app: LaunchedApp
let window: Page
let dir: string
let savedText = ''

test.beforeAll(async () => {
  app = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  window = app.window
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
  // This spec copies (the real clipboard): its text is saved now and put back after.
  savedText = await app.app.evaluate(({ clipboard }) => clipboard.readText())
  dir = mkdtempSync(join(tmpdir(), 'plexii-draw-artboards-'))
})

test.afterAll(async () => {
  await app.app.evaluate(({ clipboard }, t) => clipboard.writeText(t), savedText).catch(() => undefined)
  await app.dispose()
  rmSync(dir, { recursive: true, force: true })
})

type Board = { id: string; name: string; x: number; y: number; w: number; h: number }
type Stored = { artboards?: Board[]; layers: Array<{ kind: string; objects?: Array<{ id: string; path?: { subpaths: Array<{ nodes: Array<{ x: number; y: number }> }> } }> }> }

async function boards(id: string): Promise<Board[]> {
  return ((await readStored(window, id)).raw as Stored).artboards ?? []
}

/** Screen position of a DOCUMENT point: the stage's top-left is the artboards' union's. */
async function screenOf(p: { x: number; y: number }, union: { x: number; y: number; w: number }): Promise<{ x: number; y: number }> {
  const b = (await window.locator('[data-testid="draw-stage"]').boundingBox())!
  const k = b.width / union.w
  return { x: b.x + (p.x - union.x) * k, y: b.y + (p.y - union.y) * k }
}

async function objectMenu(label: string): Promise<void> {
  await window.locator('[data-testid="draw-studio-menubar-object"]').click()
  await window.locator('[data-testid="draw-studio-menubar-object-list"] button').filter({ hasText: 'Artboards' }).hover()
  await window.locator('button').filter({ hasText: label }).first().click()
}

async function saveTo(path: string): Promise<void> {
  await app.app.evaluate(async ({ dialog }, filePath) => {
    // @ts-expect-error test override of the native Save dialog
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, path)
}

test('AB-1 three artboards: drawn with ⇧O on the pasteboard, added from the menu, rearranged in 2 columns, exported as a 3-page PDF', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('r', 100, 100, 200, 100)]), 'Artboards')
  await openDocument(window, id)

  // ⇧O, then drag on the grey pasteboard to the right of the page.
  await window.keyboard.press('Shift+O')
  // The Artboard tab comes with the tool; its "Artboards…" opens the panel,
  // pinned so it stays open while drawing on the pasteboard.
  await barTab(window, 'artboard')
  await window.locator('[data-testid="draw-artboard-panel-open"]').click()
  await expect(window.locator('[data-testid="draw-artboards-panel"]')).toBeVisible()
  await window.locator('[data-testid="draw-panel-artboards-pin"]').click()
  const stage = (await window.locator('[data-testid="draw-stage"]').boundingBox())!
  const scroll = (await window.locator('[data-testid="draw-canvas-scroll"]').boundingBox())!
  const room = scroll.x + scroll.width - (stage.x + stage.width)
  expect(room).toBeGreaterThan(60)
  const x0 = stage.x + stage.width + 10
  const x1 = Math.min(stage.x + stage.width + room - 10, x0 + 120)
  await window.mouse.move(x0, stage.y + 10)
  await window.mouse.down()
  await window.mouse.move((x0 + x1) / 2, stage.y + 60)
  await window.mouse.move(x1, stage.y + 110)
  await window.mouse.up()
  await expect.poll(async () => (await boards(id)).length).toBe(2)
  const drawn = (await boards(id))[1]
  expect(drawn.name).toBe('Artboard 2')
  expect(drawn.x).toBeGreaterThan(800)
  expect(drawn.w).toBeGreaterThan(20)

  // A third, from Object › Artboards › New Artboard: the active one's size, beside them all.
  await objectMenu('New Artboard')
  await expect.poll(async () => (await boards(id)).length).toBe(3)
  await expect(window.locator('[data-testid="draw-artboards-list"] li')).toHaveCount(3)
  await expect(window.locator('[data-testid="draw-artboard-' + (await boards(id))[2].id + '"]')).toBeVisible()

  // Rearrange All: grid by row, 2 columns, 20 px apart.
  await objectMenu('Rearrange All Artboards…')
  await window.locator('[data-testid="draw-rearrange-grid-by-row"]').click()
  await window.locator('[data-testid="draw-rearrange-count"]').fill('2')
  await window.locator('[data-testid="draw-rearrange-spacing"]').fill('20')
  await window.locator('[data-testid="draw-rearrange-apply"]').click()
  await expect
    .poll(async () => (await boards(id)).map((b) => [b.x, b.y]))
    .toEqual([
      [0, 0],
      [820, 0],
      [0, 620]
    ])
  // The art on the first artboard stayed on it.
  const nodes = ((await readStored(window, id)).raw as Stored).layers[0].objects![0].path!.subpaths[0].nodes
  expect(nodes[0]).toEqual({ x: 100, y: 100 })

  // File › Download ▸ PDF document asks what to cover; every artboard, one page each.
  const pdfPath = join(dir, 'three.pdf')
  await saveTo(pdfPath)
  await window.locator('[data-testid="draw-studio-menubar-file"]').click()
  await window.locator('[data-testid="draw-studio-menubar-file-list"] button').filter({ hasText: 'Download' }).hover()
  await window.locator('[data-testid="draw-studio-menubar-file-list"] button').filter({ hasText: 'PDF document (.pdf)…' }).click()
  await expect(window.locator('[data-testid="draw-export-scope-pages"]')).toBeChecked()
  await window.locator('[data-testid="draw-export-go"]').click()
  await expect.poll(() => existsSync(pdfPath), { timeout: 20_000 }).toBe(true)
  const pdf = readFileSync(pdfPath).toString('latin1')
  const pages = pdf.match(/\/Type\s*\/Page[^s]/g) ?? []
  expect(pages).toHaveLength(3)
  // Each page keeps its artboard's own size (CSS px -> points: x 0.75).
  const boxes = [...pdf.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => [Math.round(Number(m[1])), Math.round(Number(m[2]))])
  const b = await boards(id)
  expect(boxes.sort()).toEqual(b.map((a) => [Math.round(a.w * 0.75), Math.round(a.h * 0.75)]).sort())
  // Unpin, so the panel does not reopen with the next drawing in this profile.
  await window.locator('[data-testid="draw-panel-artboards-pin"]').click()
})

test('AB-2 PNG of each artboard writes one file per artboard at its pixel size; navigation goes artboard to artboard', async () => {
  const body = {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [
      { id: 'a1', name: 'Cover', x: 0, y: 0, w: 300, h: 200, background: { type: 'solid', color: '#ffffff' } },
      { id: 'a2', name: 'Back', x: 400, y: 0, w: 120, h: 80, background: { type: 'solid', color: '#ffcc00' } }
    ],
    activeArtboardId: 'a1',
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [rectObject('r', 420, 10, 40, 40)] }],
    assets: {},
    swatches: [],
    guides: [],
    settings: {}
  }
  const id = await seedDrawDoc(window, body, 'Two artboards')
  await openDocument(window, id)
  await expect(window.locator('[data-testid="draw-artboard-a1"]')).toHaveAttribute('data-active', '1')

  // View › Next Artboard makes the next one active and shows it.
  await window.locator('[data-testid="draw-studio-menubar-view"]').click()
  await window.locator('[data-testid="draw-studio-menubar-view-list"] button').filter({ hasText: 'Next Artboard' }).click()
  await expect(window.locator('[data-testid="draw-artboard-a2"]')).toHaveAttribute('data-active', '1')

  const base = join(dir, 'pair.png')
  await saveTo(base)
  await window.locator('[data-testid="draw-studio-menubar-file"]').click()
  // File › Download ▸ PNG image (SPEC §9.2, G8).
  await window.locator('[data-testid="draw-studio-menubar-file-list"] button').filter({ hasText: 'Download' }).hover()
  await window.locator('[data-testid="draw-studio-menubar-file-list"] button').filter({ hasText: 'PNG image (.png)…' }).click()
  await window.locator('[data-testid="draw-export-scope-each"]').check()
  await window.locator('[data-testid="draw-export-go"]').click()
  const cover = join(dir, 'pair - Cover.png')
  const back = join(dir, 'pair - Back.png')
  await expect.poll(() => existsSync(cover) && existsSync(back), { timeout: 20_000 }).toBe(true)
  const size = (p: string): number[] => {
    const b = readFileSync(p)
    return [b.readUInt32BE(16), b.readUInt32BE(20)]
  }
  expect(size(cover)).toEqual([300, 200])
  expect(size(back)).toEqual([120, 80])
})

test('AB-3 Paste on All Artboards puts a copy at the same spot on every artboard; the panel renames', async () => {
  const body = {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [
      { id: 'a1', name: 'Artboard 1', x: 0, y: 0, w: 300, h: 200, background: { type: 'solid', color: '#ffffff' } },
      { id: 'a2', name: 'Artboard 2', x: 400, y: 0, w: 300, h: 200, background: { type: 'solid', color: '#ffffff' } }
    ],
    activeArtboardId: 'a1',
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [rectObject('r', 20, 30, 40, 40)] }],
    assets: {},
    swatches: [],
    guides: [],
    settings: {}
  }
  const id = await seedDrawDoc(window, body, 'Paste all')
  await openDocument(window, id)
  const union = { x: 0, y: 0, w: 700 }
  const p = await screenOf({ x: 40, y: 50 }, union)
  await window.mouse.click(p.x, p.y)
  await window.keyboard.press('Meta+c')
  await window.waitForTimeout(600)
  await window.keyboard.press('Meta+Alt+Shift+v')
  await expect
    .poll(async () => {
      const objs = ((await readStored(window, id)).raw as Stored).layers[0].objects ?? []
      return objs.map((o) => o.path!.subpaths[0].nodes[0])
    })
    .toEqual([
      { x: 20, y: 30 },
      { x: 20, y: 30 },
      { x: 420, y: 30 }
    ])

  // Rename in the panel: double-click the name.
  await openDrawPanel(window, 'artboards')
  await window.locator('[data-testid="draw-artboards-row-1"]').dblclick()
  await window.locator('[data-testid="draw-artboards-rename"]').fill('Back cover')
  await window.locator('[data-testid="draw-artboards-rename"]').press('Enter')
  await expect.poll(async () => (await boards(id)).map((b) => b.name)).toEqual(['Artboard 1', 'Back cover'])
})
