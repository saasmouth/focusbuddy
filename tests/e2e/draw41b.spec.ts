/**
 * PlexiiDraw 4.3.41 (draw-41b) end to end: Zoom to Selection, paint layers
 * that follow their artboard, Convert to Artboards, Show/Hide Artboards and
 * the unlimited pasteboard -- each driven as a person does (menus, keys, the
 * bar, the canvas) and read back from the screen and the stored drawing.
 * Throwaway profile (launchApp), PLEXI_APP=preview3. Nothing here touches the
 * system clipboard.
 */

import { test, expect, type Page } from '@playwright/test'
import { deflateSync } from 'zlib'
import { launchApp, type LaunchedApp, suppressFeatureSpotlights, waitForReady } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, openDrawPanel, readStored, rectObject, runMenu, seedDrawDoc, stagePoint, v1Body } from './_drawHelpers'

let app: LaunchedApp
let window: Page

test.beforeAll(async () => {
  app = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  window = app.window
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
})

test.afterAll(async () => {
  await app.dispose()
})

const t = (id: string) => window.locator(`[data-testid="${id}"]`)

async function zoomPct(): Promise<number> {
  return Number(((await t('draw-zoom').textContent()) ?? '').replace('%', ''))
}

/** The selection frame's on-screen box (the overlay's first rect). */
async function selectionOnScreen(): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await window.locator('[data-testid="draw-selection"] rect').first().boundingBox()
  if (!b) throw new Error('no selection frame on screen')
  return b
}

test('ZS-1 Zoom to Selection: greyed with its reason until something is selected, then fits it with padding, beside a pinned panel too', async () => {
  // An 800 × 600 page with a square near its bottom-right corner (big
  // enough that fitting it never hits the 1600% zoom cap).
  const id = await seedDrawDoc(window, v1Body([rectObject('small', 560, 400, 160, 120)]), 'Zoom to selection')
  await openDocument(window, id)

  // Nothing selected: the View menu item is off and says why.
  await t('draw-studio-menubar-view').click()
  const item = window.locator('[data-testid="draw-studio-menubar-view-list"] button').filter({ hasText: 'Zoom to Selection' }).first()
  await expect(item).toBeDisabled()
  await expect(item).toContainText('select something to zoom to')
  await window.keyboard.press('Escape')
  // …and so is the zoom menu's.
  await t('draw-zoom-menu').click()
  await expect(t('draw-zoom-item-zoomToSelection')).toBeDisabled()
  await expect(t('draw-zoom-item-zoomToSelection')).toContainText('Select something to zoom to')
  await window.keyboard.press('Escape')
  await window.mouse.click(5, 5) // close the menu if Escape did not
  await expect(t('draw-zoom-menu-list')).toHaveCount(0)

  // Select the square and zoom to it from the View menu.
  const before = await zoomPct()
  const at = await stagePoint(window, 800, { x: 640, y: 460 })
  await window.mouse.click(at.x, at.y)
  await expect(window.locator('[data-testid="draw-selection"]')).toHaveCount(1)
  await runMenu(window, 'view', 'Zoom to Selection')
  await expect.poll(zoomPct).toBeGreaterThan(before * 3)

  // It fills the window, less 40 px each side, and sits in the middle of it.
  const sc = (await t('draw-canvas-scroll').boundingBox())!
  await expect
    .poll(async () => {
      const s = await selectionOnScreen()
      return Math.abs(s.x + s.width / 2 - (sc.x + sc.width / 2)) < 12 && Math.abs(s.y + s.height / 2 - (sc.y + sc.height / 2)) < 12
    })
    .toBe(true)
  const s1 = await selectionOnScreen()
  expect(Math.max(s1.width / (sc.width - 80), s1.height / (sc.height - 80))).toBeGreaterThan(0.9)
  expect(s1.x).toBeGreaterThan(sc.x + 20)
  expect(s1.x + s1.width).toBeLessThan(sc.x + sc.width - 20)

  // Pin the Layers panel: the selection is fitted into the part it leaves.
  await openDrawPanel(window, 'layers')
  await t('draw-panel-layers-pin').click()
  const panel = (await t('draw-panel-layers').boundingBox())!
  await t('draw-zoom-menu').click()
  await t('draw-zoom-item-zoomToSelection').click()
  const left = panel.x + panel.width
  await expect
    .poll(async () => {
      const s = await selectionOnScreen()
      return s.x > left && Math.abs(s.x + s.width / 2 - (left + sc.x + sc.width) / 2) < 16
    })
    .toBe(true)
  // Unpin again, for the specs after this one.
  await t('draw-panel-layers-pin').click()
  await window.keyboard.press('Escape')
})

async function artboardsMenuItem(label: string) {
  await t('draw-studio-menubar-object').click()
  await window.locator('[data-testid="draw-studio-menubar-object-list"] button').filter({ hasText: 'Artboards' }).hover()
  return window.locator('button').filter({ hasText: label }).first()
}

type Board = { id: string; name: string; x: number; y: number; w: number; h: number }
type StoredDoc = { artboards?: Board[]; layers: Array<{ kind: string; objects?: Array<{ id: string }> }> }
const storedDoc = async (id: string): Promise<StoredDoc> => (await readStored(window, id)).raw as StoredDoc

test('CA-1 Object › Artboards › Convert to Artboards: off with its reason for a non-rectangle, then the selected rectangles become artboards in one undo step', async () => {
  const ellipse = {
    id: 'oval',
    type: 'path',
    shapeKind: 'ellipse',
    path: { subpaths: [{ closed: true, nodes: [{ x: 650, y: 400, outX: 700, outY: 400 }, { x: 750, y: 450 }, { x: 650, y: 500 }, { x: 600, y: 450 }] }] },
    fill: { type: 'solid', color: '#40c057' }
  }
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 100, 200, 150), rectObject('b', 400, 100, 150, 150), ellipse]), 'Convert to artboards')
  await openDocument(window, id)

  // Only the ellipse selected: off, saying why.
  const oval = await stagePoint(window, 800, { x: 680, y: 450 })
  await window.mouse.click(oval.x, oval.y)
  const off = await artboardsMenuItem('Convert to Artboards')
  await expect(off).toBeDisabled()
  await expect(off).toContainText('select one or more rectangles')
  await window.keyboard.press('Escape')
  await window.keyboard.press('Escape')

  // Both rectangles (and the ellipse, which is left alone).
  const a = await stagePoint(window, 800, { x: 120, y: 120 })
  const b = await stagePoint(window, 800, { x: 420, y: 120 })
  await window.keyboard.down('Shift')
  await window.mouse.click(a.x, a.y)
  await window.mouse.click(b.x, b.y)
  await window.keyboard.up('Shift')
  await (await artboardsMenuItem('Convert to Artboards')).click()
  await expect.poll(async () => ((await storedDoc(id)).artboards ?? []).map((x) => [x.name, x.x, x.y, x.w, x.h])).toEqual([
    ['Artboard 1', 0, 0, 800, 600],
    ['Artboard 2', 100, 100, 200, 150],
    ['Artboard 3', 400, 100, 150, 150]
  ])
  expect((await storedDoc(id)).layers[0].objects!.map((o) => o.id)).toEqual(['oval'])
  await expect(t('draw-status')).toContainText('Made 2 artboards: Artboard 2, Artboard 3.')

  // One undo step puts the rectangles back and takes the artboards away.
  await t('draw-undo').click()
  await expect.poll(async () => ((await storedDoc(id)).artboards ?? []).length).toBe(1)
  expect((await storedDoc(id)).layers[0].objects!.map((o) => o.id)).toEqual(['a', 'b', 'oval'])
})

test('HA-1 View › Hide Artboards (⇧⌘H): the page fill and edges go so the art sits on the pasteboard, the drawing is untouched, and Show Artboards brings them back', async () => {
  const body = {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [
      { id: 'artboard-1', name: 'Artboard 1', x: 0, y: 0, w: 800, h: 600, background: { type: 'solid', color: '#ffffff' } },
      { id: 'b2', name: 'Artboard 2', x: 900, y: 0, w: 400, h: 600, background: { type: 'solid', color: '#ffffff' } }
    ],
    activeArtboardId: 'artboard-1',
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [rectObject('r', 100, 100, 200, 100)] }],
    activeLayerId: 'L1',
    assets: {},
    swatches: [],
    guides: [],
    settings: {}
  }
  const id = await seedDrawDoc(window, body, 'Hide artboards')
  await openDocument(window, id)
  await expect(t('draw-artboards')).toBeVisible()
  const before = await readStored(window, id)

  await t('draw-canvas-scroll').focus()
  await window.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+H`)
  await expect(t('draw-artboards')).toHaveCount(0)
  await expect(t('draw-stage')).toHaveAttribute('data-artboards-hidden', '1')
  // The art is still drawn.
  await expect(window.locator('[data-testid="draw-vector-L1"] path')).toHaveCount(1)
  // The View menu now offers Show Artboards, with the key.
  await t('draw-studio-menubar-view').click()
  const item = window.locator('[data-testid="draw-studio-menubar-view-list"] button').filter({ hasText: 'Show Artboards' }).first()
  await expect(item).toBeVisible()
  await expect(item).toContainText(process.platform === 'darwin' ? '⇧⌘H' : 'Shift+Ctrl+H')
  await window.keyboard.press('Escape')

  // A view setting, not an edit: the stored drawing did not change.
  await window.waitForTimeout(1_200)
  expect((await readStored(window, id)).body).toBe(before.body)

  // It is the person's view preference: reopening the drawing keeps it hidden.
  await openDocument(window, id)
  await expect(t('draw-stage')).toHaveAttribute('data-artboards-hidden', '1')

  // Show Artboards from the menu brings the pages back.
  await t('draw-studio-menubar-view').click()
  await window.locator('[data-testid="draw-studio-menubar-view-list"] button').filter({ hasText: 'Show Artboards' }).first().click()
  await expect(t('draw-artboards')).toBeVisible()
  await expect(t('draw-stage')).not.toHaveAttribute('data-artboards-hidden', '1')
})

// ── Paint layers follow their artboard ──────────────────────────────────────

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

/** A real PNG, w x h: the left half red, the right half blue. */
function halvesPng(w: number, h: number): string {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.alloc(1 + w * 3)
  for (let x = 0; x < w; x++) row.set(x < w / 2 ? [255, 0, 0] : [0, 0, 255], 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  return `data:image/png;base64,${png.toString('base64')}`
}

/** Decode a stored picture in the page: its size and the RGBA at some points. */
async function pixels(dataUrl: string, points: Array<[number, number]>): Promise<{ w: number; h: number; at: number[][] }> {
  return window.evaluate(
    async ({ src, pts }) => {
      const img = new Image()
      await new Promise<void>((res, rej) => {
        img.onload = () => res()
        img.onerror = () => rej(new Error('undecodable'))
        img.src = src
      })
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const g = c.getContext('2d')!
      g.drawImage(img, 0, 0)
      return { w: c.width, h: c.height, at: pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data)) }
    },
    { src: dataUrl, pts: points }
  )
}

type PaintStored = { artboards: Board[]; layers: Array<{ id: string; kind: string; assetId?: string; frame?: { x: number; y: number; w: number; h: number }; objects?: Array<{ id: string; path?: { subpaths: Array<{ nodes: Array<{ x: number; y: number }> }> } }> }>; assets: Record<string, { dataUrl: string }> }

test('PF-1 paint follows its artboard: moved with the Artboard tool together with the art, then resized from the tab with the pixels cropped or extended, never stretched', async () => {
  const body = {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [
      { id: 'artboard-1', name: 'Artboard 1', x: 0, y: 0, w: 400, h: 300, background: { type: 'solid', color: '#ffffff' } },
      { id: 'b2', name: 'Artboard 2', x: 500, y: 0, w: 300, h: 300, background: { type: 'solid', color: '#ffffff' } }
    ],
    activeArtboardId: 'artboard-1',
    layers: [
      { id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [rectObject('r', 20, 20, 40, 40)] },
      { id: 'P', kind: 'raster', name: 'Paint', visible: true, locked: false, opacity: 1, blend: 'normal', assetId: 'asset-halves' }
    ],
    activeLayerId: 'L1',
    assets: { 'asset-halves': { mime: 'image/png', dataUrl: halvesPng(400, 300), w: 400, h: 300 } },
    swatches: [],
    guides: [],
    settings: {}
  }
  const id = await seedDrawDoc(window, body, 'Paint follows')
  await openDocument(window, id)
  const read = async (): Promise<PaintStored> => (await readStored(window, id)).raw as PaintStored
  const paint = async () => (await read()).layers.find((l) => l.id === 'P')!

  // The Artboard tool: drag inside Artboard 1 (empty spot) down by about 100 document units.
  await t('draw-canvas-scroll').focus()
  await window.keyboard.press('Shift+O')
  const union = { x: 0, w: 800 }
  const stage = (await t('draw-stage').boundingBox())!
  const k = stage.width / union.w
  const from = { x: stage.x + 300 * k, y: stage.y + 200 * k }
  await window.mouse.move(from.x, from.y)
  await window.mouse.down()
  await window.mouse.move(from.x, from.y + 50 * k)
  await window.mouse.move(from.x, from.y + 100 * k)
  await window.mouse.up()
  await expect.poll(async () => (await read()).artboards[0].y).toBeGreaterThan(80)
  const moved = (await read()).artboards[0]
  // Art and pixels moved together, by the artboard's amount; the picture is untouched.
  await expect.poll(async () => (await paint()).frame).toEqual({ x: moved.x, y: moved.y, w: 400, h: 300 })
  expect((await paint()).assetId).toBe('asset-halves')
  const r = (await read()).layers[0].objects!.find((o) => o.id === 'r')!
  expect(r.path!.subpaths[0].nodes[0]).toEqual({ x: 20 + moved.x, y: 20 + moved.y })
  // On screen, the paint canvas sits exactly on the artboard.
  const ab = (await t('draw-artboard-artboard-1').boundingBox())!
  const cv = (await t('draw-raster-P').boundingBox())!
  expect(Math.abs(ab.x - cv.x)).toBeLessThan(2)
  expect(Math.abs(ab.y - cv.y)).toBeLessThan(2)
  expect(Math.abs(ab.width - cv.width)).toBeLessThan(2)

  // One undo step for the move: undo, then redo.
  await t('draw-undo').click()
  await expect.poll(async () => (await paint()).frame ?? null).toBeNull()
  await t('draw-redo').click()
  await expect.poll(async () => (await paint()).frame?.y).toBe(moved.y)

  // Wider from the Artboard tab: 400 -> 600. The new picture is 600 wide with
  // red then blue exactly where they were, and transparent margin after.
  await t('draw-bar-tab-artboard').click()
  await t('draw-artboard-w').fill('600')
  await t('draw-artboard-w').press('Enter')
  await expect.poll(async () => (await paint()).assetId).not.toBe('asset-halves')
  const s1 = await read()
  const p1 = s1.layers.find((l) => l.id === 'P')!
  expect(p1.frame).toEqual({ x: moved.x, y: moved.y, w: 600, h: 300 })
  const wide = await pixels(s1.assets[p1.assetId!].dataUrl, [
    [100, 150],
    [300, 150],
    [500, 150]
  ])
  expect([wide.w, wide.h]).toEqual([600, 300])
  expect(wide.at[0].slice(0, 4)).toEqual([255, 0, 0, 255])
  expect(wide.at[1].slice(0, 4)).toEqual([0, 0, 255, 255])
  expect(wide.at[2][3]).toBe(0)

  // Narrower: 600 -> 150 crops (still red, never squeezed).
  await t('draw-artboard-w').fill('150')
  await t('draw-artboard-w').press('Enter')
  await expect.poll(async () => (await paint()).frame?.w).toBe(150)
  const s2 = await read()
  const p2 = s2.layers.find((l) => l.id === 'P')!
  const narrow = await pixels(s2.assets[p2.assetId!].dataUrl, [[140, 150]])
  expect([narrow.w, narrow.h]).toEqual([150, 300])
  expect(narrow.at[0].slice(0, 4)).toEqual([255, 0, 0, 255])
  // Undo is one step per resize: back to 600 with the wide picture.
  await t('draw-undo').click()
  await expect.poll(async () => (await paint()).frame?.w).toBe(600)
  expect((await paint()).assetId).toBe(p1.assetId)
})

// ── Item 8: the host rule in a narrow desk widget (kept last: it reloads) ───

test('NW-1 embedded in a 480px desk widget the studio is no wider than its host, nor is anything between them, and the canvas still draws', async () => {
  const taskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Narrow Draw' } as never)
    const doc = await api.documents.create({ docType: 'draw', title: 'Narrow' } as never)
    await api.widgets.create({ taskId: (task as { id: string }).id, kind: 'draw', content: (doc as { id: string }).id, x: 240, y: 160, width: 480, height: 380 } as never)
    return (task as { id: string }).id
  })
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
  await window.evaluate((id: string) => (window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }).__fbView?.getState().goTask(id), taskId)
  await expect(t('draw-shell')).toBeVisible({ timeout: 15_000 })
  const widths = await window.evaluate(() => {
    const shell = document.querySelector('[data-testid="draw-shell"]') as HTMLElement
    const widget = shell.closest('[data-widget-id]') as HTMLElement
    const w = widget.getBoundingClientRect()
    const chain: Array<{ what: string; width: number; right: number }> = []
    for (let a: HTMLElement | null = shell; a && a !== widget; a = a.parentElement) {
      const r = a.getBoundingClientRect()
      chain.push({ what: a.dataset.testid ?? `${a.tagName.toLowerCase()}.${String(a.className).slice(0, 60)}`, width: r.width, right: r.right })
    }
    return { widget: { width: w.width, right: w.right }, studio: (document.querySelector('[data-testid="draw-studio"]') as HTMLElement).getBoundingClientRect().width, chain }
  })
  expect(widths.studio).toBeLessThanOrEqual(widths.widget.width + 1)
  for (const c of widths.chain) {
    expect(c.width, `${c.what} is wider than the widget`).toBeLessThanOrEqual(widths.widget.width + 1)
    expect(c.right, `${c.what} runs past the widget`).toBeLessThanOrEqual(widths.widget.right + 1)
  }
  // Row 2 scrolls rather than widening anything; the canvas is still there to draw on.
  const bar = (await t('draw-bar').boundingBox())!
  expect(bar.width).toBeLessThan(520)
  const heights = await window.evaluate(() => {
    const h = (sel: string): number => Math.round((document.querySelector(sel) as HTMLElement | null)?.getBoundingClientRect().height ?? 0)
    const shell = document.querySelector('[data-testid="draw-shell"]') as HTMLElement
    const widget = shell.closest('[data-widget-id]') as HTMLElement
    return {
      widget: Math.round(widget.getBoundingClientRect().height),
      shell: h('[data-testid="draw-shell"]'),
      bar: h('[data-testid="draw-bar"]'),
      keysNotice: h('[data-testid="draw-keys-notice"]'),
      readOnly: h('[data-testid="draw-readonly-banner"]'),
      canvas: h('[data-testid="draw-canvas-scroll"]')
    }
  })
  const canvas = (await t('draw-canvas-scroll').boundingBox())!
  expect(canvas.width).toBeGreaterThan(200)
  expect(canvas.height, `the canvas has room to draw in (${JSON.stringify(heights)})`).toBeGreaterThan(100)
})
