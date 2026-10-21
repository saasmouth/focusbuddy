/**
 * WP-CLIPBOARD end to end: Copy, Cut, Paste, Paste in Place, Paste in Front,
 * Alt-drag duplicate, pasting between two drawings, and the REAL system
 * clipboard -- what a copy puts there is read back in the main process, and a
 * picture put there by "another app" (the main process, writing a PNG) pastes
 * as an image object. Every result is read back from the stored document.
 *
 * This spec uses the machine's real clipboard. Its text is saved before and
 * put back after.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, readStored, rectObject, runMenu, seedDrawDoc, stagePoint, v1Body, waitForSave } from './_drawHelpers'

let app: LaunchedApp
let window: Page
let savedText = ''

test.beforeAll(async () => {
  app = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  window = app.window
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
  savedText = await app.app.evaluate(({ clipboard }) => clipboard.readText())
})

test.afterAll(async () => {
  await app.app.evaluate(({ clipboard }, t) => clipboard.writeText(t), savedText).catch(() => undefined)
  await app.dispose()
})

type Node = { id: string; type: string; x?: number; y?: number; w?: number; h?: number; assetId?: string; children?: Node[]; fill?: unknown; path?: { subpaths: Array<{ nodes: Array<{ x: number; y: number }> }> } }
type Body = { schemaVersion: number; layers: Array<{ kind: string; objects?: Node[] }>; assets?: Record<string, { mime: string; dataUrl: string }>; swatches?: Array<{ id: string; color: string }> }

function objectsOf(raw: unknown): Node[] {
  return (raw as Body).layers.filter((l) => l.kind === 'vector').flatMap((l) => l.objects ?? [])
}
function box(o: Node): { x: number; y: number; w: number; h: number } {
  if (o.path) {
    const ns = o.path.subpaths.flatMap((s) => s.nodes)
    const xs = ns.map((n) => n.x)
    const ys = ns.map((n) => n.y)
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  }
  return { x: o.x ?? NaN, y: o.y ?? NaN, w: o.w ?? NaN, h: o.h ?? NaN }
}

async function clickAt(p: { x: number; y: number }): Promise<void> {
  const s = await stagePoint(window, 800, p)
  await window.mouse.click(s.x, s.y)
}

/** Wait until the stored drawing has `n` top-level objects. */
async function storedObjects(id: string, n: number): Promise<Node[]> {
  await expect.poll(async () => objectsOf((await readStored(window, id)).raw).length, { timeout: 8_000 }).toBe(n)
  return objectsOf((await readStored(window, id)).raw)
}

test('CB-1 copy then paste duplicates with the same geometry and a new id; the system clipboard holds SVG and a PNG', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 120, 160, 90)]), 'Clipboard one')
  await openDocument(window, id)
  await clickAt({ x: 180, y: 165 })
  await window.keyboard.press('Meta+c')

  // Read the real clipboard in the main process.
  const types = await app.app.evaluate(async ({ clipboard }) => {
    for (let i = 0; i < 40; i++) {
      const items = await clipboard.read()
      const t = items[0]?.types ?? []
      if (t.includes('web application/vnd.plexii.draw+json')) return t
      await new Promise((r) => setTimeout(r, 100))
    }
    return (await clipboard.read())[0]?.types ?? []
  })
  expect(types).toContain('image/svg+xml')
  expect(types).toContain('image/png')
  expect(types).toContain('web application/vnd.plexii.draw+json')
  const content = await app.app.evaluate(async ({ clipboard }) => {
    const item = (await clipboard.read())[0]
    const svgType = item.types.find((t) => t.includes('public.svg-image') || t.includes('0x73766720'))!
    const svg = await (await item.getType(svgType)).text()
    const png = Buffer.from(await (await item.getType('image/png')).arrayBuffer())
    return { svg, pngSig: png.subarray(0, 8).toString('hex'), pngW: png.readUInt32BE(16), pngH: png.readUInt32BE(20), text: await clipboard.readText() }
  })
  expect(content.svg).toMatch(/^<svg [^>]*viewBox="100 120 160 90"/)
  expect(content.text).toBe(content.svg)
  expect(content.pngSig).toBe('89504e470d0a1a0a')
  // The picture is the art at 2x (320 x 180), not the whole artboard.
  expect([content.pngW, content.pngH]).toEqual([320, 180])

  await window.keyboard.press('Meta+v')
  const objs = await storedObjects(id, 2)
  expect(objs[0].id).toBe('a')
  expect(objs[1].id).not.toBe('a')
  expect({ w: box(objs[1]).w, h: box(objs[1]).h }).toEqual({ w: 160, h: 90 })
})

test('CB-2 Paste in Place keeps the coordinates; Paste in Front lands directly above the selection; Cut removes', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 100, 100, 100), rectObject('b', 400, 300, 100, 100)]), 'Clipboard two')
  await openDocument(window, id)
  await clickAt({ x: 150, y: 150 })
  await window.keyboard.press('Meta+c')
  await window.waitForTimeout(400)
  await window.keyboard.press('Meta+Shift+v')
  let objs = await storedObjects(id, 3)
  expect(box(objs[2])).toEqual({ x: 100, y: 100, w: 100, h: 100 })

  // Select b, then Paste in Front from the Edit menu.
  await clickAt({ x: 450, y: 350 })
  await runMenu(window, 'edit', 'Paste in Front')
  objs = await storedObjects(id, 4)
  // Directly above b, at the copied position.
  const bAt = objs.findIndex((o) => o.id === 'b')
  expect(box(objs[bAt + 1])).toEqual({ x: 100, y: 100, w: 100, h: 100 })

  await clickAt({ x: 450, y: 350 })
  await window.keyboard.press('Meta+x')
  objs = await storedObjects(id, 3)
  expect(objs.map((o) => o.id)).not.toContain('b')
})

test('CB-3 a PNG another app put on the clipboard pastes as an image object', async () => {
  const id = await seedDrawDoc(window, v1Body([]), 'Clipboard three')
  await openDocument(window, id)
  await app.app.evaluate(async ({ clipboard, nativeImage, ClipboardItem }) => {
    // A 40 x 30 red picture, written the way a screenshot or a browser's Copy Image does.
    const bmp = Buffer.alloc(40 * 30 * 4)
    for (let i = 0; i < bmp.length; i += 4) bmp.set([0, 0, 255, 255], i) // BGRA
    const png = nativeImage.createFromBitmap(bmp, { width: 40, height: 30 }).toPNG()
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
  })
  await window.locator('[data-testid="draw-stage"]').click({ position: { x: 5, y: 5 } })
  await window.keyboard.press('Meta+v')
  const objs = await storedObjects(id, 1)
  expect(objs[0].type).toBe('image')
  expect({ w: objs[0].w, h: objs[0].h }).toEqual({ w: 40, h: 30 })
  // v1 storage carries the picture inline; either way it is real PNG bytes.
  const stored = JSON.stringify((await readStored(window, id)).raw)
  expect(stored).toContain('data:image/png;base64,')
})

test('CB-4 pasting between two drawings keeps groups, swatches and images', async () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const v2 = (objects: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [{ id: 'ab1', name: 'Artboard 1', x: 0, y: 0, w: 800, h: 600, background: { type: 'solid', color: '#ffffff' } }],
    activeLayerId: 'L1',
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }],
    assets: {},
    swatches: [],
    guides: [],
    settings: {},
    ...extra
  })
  const group = {
    id: 'g',
    type: 'group',
    children: [rectObject('r', 100, 100, 200, 150, { fill: { type: 'swatch', id: 'brand' } }), { id: 'img', type: 'image', x: 320, y: 100, w: 60, h: 60, assetId: 'asset-0123456789abcdef0123456789abcdef' }]
  }
  // Any well-formed id will do: a paste re-keys every asset by the hash of its bytes.
  const fakeId = 'asset-0123456789abcdef0123456789abcdef'
  const src = await seedDrawDoc(
    window,
    v2([group], { assets: { [fakeId]: { mime: 'image/png', dataUrl: PNG, w: 1, h: 1 } }, swatches: [{ id: 'brand', name: 'Brand', color: '#e11d48', global: true }] }),
    'Clipboard source'
  )
  const dst = await seedDrawDoc(window, v2([]), 'Clipboard target')
  await openDocument(window, src)
  await clickAt({ x: 200, y: 175 })
  await window.keyboard.press('Meta+c')
  await window.waitForTimeout(400)
  await openDocument(window, dst)
  await window.keyboard.press('Meta+Shift+v')
  const objs = await storedObjects(dst, 1)
  const g = objs[0]
  expect(g.type).toBe('group')
  expect(g.id).not.toBe('g')
  expect(g.children!.map((c) => c.type)).toEqual(['path', 'image'])
  expect(g.children![0].fill).toEqual({ type: 'swatch', id: 'brand' })
  expect(box(g.children![0])).toEqual({ x: 100, y: 100, w: 200, h: 150 })
  const body = (await readStored(window, dst)).raw as Body
  expect(body.swatches).toEqual([{ id: 'brand', name: 'Brand', color: '#e11d48', global: true }])
  const imgAsset = body.assets![g.children![1].assetId!]
  expect(imgAsset.dataUrl).toBe(PNG)
})

test('CB-5 Alt-drag leaves the original and drops a copy', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 100, 100, 100)]), 'Clipboard five')
  await openDocument(window, id)
  const from = await stagePoint(window, 800, { x: 150, y: 150 })
  const to = await stagePoint(window, 800, { x: 450, y: 350 })
  await window.mouse.move(from.x, from.y)
  await window.keyboard.down('Alt')
  await window.mouse.down()
  await window.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await window.mouse.move(to.x, to.y)
  await window.mouse.up()
  await window.keyboard.up('Alt')
  const objs = await storedObjects(id, 2)
  expect(box(objs[0])).toEqual({ x: 100, y: 100, w: 100, h: 100 })
  expect(box(objs[1]).w).toBe(100)
  expect(Math.abs(box(objs[1]).x - 400)).toBeLessThan(3)
  await waitForSave(window)
})
