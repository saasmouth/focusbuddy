/**
 * WP-IMPORT end to end: File › Place (an image, a PDF page), File › Open SVG,
 * File › Import SVG (with an element only an image can carry), and files
 * dropped on the canvas -- in the real app, with the native Open dialog
 * mocked to temp files this spec writes itself. State is read back from the
 * main process AND checked in the DOM. Throwaway profile (launchApp), never a
 * real one.
 */

import { test, expect, type Page } from '@playwright/test'
import { deflateSync } from 'zlib'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, readStored, runMenu, seedDrawDoc, stagePoint, storedView, v1Body, waitForSave } from './_drawHelpers'

let app: LaunchedApp
let window: Page
let dir: string

test.beforeAll(async () => {
  app = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  window = app.window
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
  dir = mkdtempSync(join(tmpdir(), 'plexii-draw-import-'))
})

test.afterAll(async () => {
  await app.dispose()
  rmSync(dir, { recursive: true, force: true })
})

// ── Files this spec makes (nothing downloaded, nothing copied) ───────────────

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(b: Buffer): number {
  let c = 0xffffffff
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
/** A real, valid PNG: w x h of one colour. */
function makePng(w: number, h: number, rgb: [number, number, number]): Buffer {
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
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** A real two-page PDF: page 1 is 200 x 100 pt, page 2 is 300 x 150 pt, each with a filled rectangle. */
function makePdf(): Buffer {
  const objs: string[] = []
  const content = (s: string): string => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`
  objs.push('<< /Type /Catalog /Pages 2 0 R >>')
  objs.push('<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>')
  objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>')
  objs.push(content('1 0 0 rg 10 10 100 50 re f'))
  objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Contents 6 0 R >>')
  objs.push(content('0 0 1 rg 20 20 200 100 re f'))
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const SHAPES_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200">
  <style>.a{fill:#e64980}</style>
  <rect class="a" x="10" y="10" width="80" height="60"/>
  <circle cx="150" cy="50" r="30" fill="#228be6"/>
  <path d="M200 20 L280 20 L240 90 Z" fill="#40c057"/>
  <ellipse cx="60" cy="150" rx="40" ry="20" fill="#fab005"/>
  <path d="M120 150 a30 30 0 1 0 60 0" fill="none" stroke="#000" stroke-width="3"/>
</svg>`

const FILTER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120">
  <filter id="soft"><feGaussianBlur stdDeviation="3"/></filter>
  <rect x="20" y="20" width="60" height="60" fill="#7950f2" filter="url(#soft)"/>
  <rect x="120" y="20" width="60" height="60" fill="#15aabf"/>
</svg>`

function write(name: string, data: Buffer | string): string {
  const p = join(dir, name)
  writeFileSync(p, data)
  return p
}

async function mockOpenDialog(paths: string[]): Promise<void> {
  await app.app.evaluate(async ({ dialog }, filePaths) => {
    // @ts-expect-error test override of the native Open dialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths })
  }, paths)
}

type Obj = { id: string; type: string; x?: number; y?: number; w?: number; h?: number; assetId?: string; src?: string; children?: Obj[]; path?: unknown }
function objectsOf(raw: unknown): Obj[] {
  // v1 or v2 (drawings save as v2 once edited): images carry their picture as src either way.
  const layers = storedView<{ layers: Array<{ kind: string; objects?: Obj[] }> }>(raw).layers
  return layers.filter((l) => l.kind === 'vector').flatMap((l) => l.objects ?? [])
}

async function clickArtboard(width: number, p: { x: number; y: number }): Promise<void> {
  const s = await stagePoint(window, width, p)
  await window.mouse.click(s.x, s.y)
}

test('IMP-1 File › Place a PNG, click to place it at actual size: an embedded image object', async () => {
  const png = write('swatch.png', makePng(120, 80, [230, 73, 128]))
  const id = await seedDrawDoc(window, v1Body([]), 'Place target')
  await openDocument(window, id)
  await mockOpenDialog([png])
  await runMenu(window, 'file', 'Place…')
  // The loaded cursor shows a preview under the pointer.
  const s = await stagePoint(window, 800, { x: 100, y: 120 })
  await window.mouse.move(s.x, s.y)
  await expect(window.locator('[data-testid="draw-place-preview"]')).toBeVisible()
  await window.mouse.click(s.x, s.y)
  await waitForSave(window)
  const objs = objectsOf((await readStored(window, id)).raw)
  expect(objs).toHaveLength(1)
  const img = objs[0]
  expect(img.type).toBe('image')
  expect(img.x).toBeCloseTo(100, 0)
  expect(img.y).toBeCloseTo(120, 0)
  expect([img.w, img.h]).toEqual([120, 80])
  // Embedded: the stored drawing carries the bytes, not a path to a file.
  expect(String(img.src).startsWith('data:image/png;base64,')).toBe(true)
  await expect(window.locator('[data-testid="draw-vector-L1"] image')).toHaveCount(1)
})

test('IMP-2 File › Open SVG makes a new drawing with every shape as an editable path', async () => {
  const svg = write('five-shapes.svg', SHAPES_SVG)
  const id = await seedDrawDoc(window, v1Body([]), 'Before open')
  await openDocument(window, id)
  await mockOpenDialog([svg])
  await runMenu(window, 'file', 'Open SVG…')
  // The new drawing is open: five paths on its canvas, on a 300 x 200 artboard.
  await expect(window.locator('[data-testid="draw-studio"] [data-testid^="draw-vector-"] path')).toHaveCount(5, { timeout: 10_000 })
  const stored = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const docs = (await api.documents.list()) as Array<{ id: string; title: string }>
    const d = docs.find((x) => x.title === 'five-shapes')
    return d ? (await api.documents.get(d.id))?.body : null
  })
  expect(stored).toBeTruthy()
  expect(storedView(stored).width).toBe(300)
  expect(storedView(stored).height).toBe(200)
  expect(objectsOf(stored).map((o) => o.type)).toEqual(['path', 'path', 'path', 'path', 'path'])
})

test('IMP-3 File › Import SVG keeps a filtered element as a rasterised image (real Chromium raster) and says so', async () => {
  const svg = write('filtered.svg', FILTER_SVG)
  const id = await seedDrawDoc(window, v1Body([]), 'Import target')
  await openDocument(window, id)
  await mockOpenDialog([svg])
  await runMenu(window, 'file', 'Import SVG…')
  await expect(window.locator('[data-testid="draw-import-report"]')).toContainText('1 filter was not editable here and was rasterised as an embedded image')
  await window.locator('[data-testid="draw-import-report-ok"]').click()
  await waitForSave(window)
  const top = objectsOf((await readStored(window, id)).raw)
  // v2 writes are on: the art arrives as one group named after the file, as in Illustrator.
  expect(top.map((o) => o.type)).toEqual(['group'])
  const objs = top[0].children!
  expect(objs.map((o) => o.type)).toEqual(['image', 'path'])
  expect(String(objs[0].src).startsWith('data:image/png;base64,')).toBe(true)
  // The raster covers the blur's region (10% beyond the 60 x 60 box each side).
  expect([objs[0].x, objs[0].y, objs[0].w, objs[0].h]).toEqual([14, 14, 72, 72])
  await expect(window.locator('[data-testid="draw-vector-L1"] image')).toHaveCount(1)
  await expect(window.locator('[data-testid="draw-vector-L1"] path')).toHaveCount(1)
})

test('IMP-4 Dropping an SVG and a PNG on the canvas places both where they land', async () => {
  const id = await seedDrawDoc(window, v1Body([]), 'Drop target')
  await openDocument(window, id)
  const pngB64 = makePng(40, 30, [64, 192, 87]).toString('base64')
  const at = await stagePoint(window, 800, { x: 200, y: 150 })
  await window.evaluate(
    async ({ svg, png, x, y }) => {
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([svg], 'logo.svg', { type: 'image/svg+xml' }))
      dt.items.add(new File([bytes], 'dot.png', { type: 'image/png' }))
      const target = document.querySelector('[data-testid="draw-stage"]')!
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
    },
    { svg: SHAPES_SVG, png: pngB64, x: at.x, y: at.y }
  )
  await expect(window.locator('[data-testid="draw-vector-L1"] path')).toHaveCount(5, { timeout: 10_000 })
  await waitForSave(window)
  const objs = objectsOf((await readStored(window, id)).raw)
  // The SVG arrives as one group of its five shapes (v2 writes are on); the PNG as an image.
  expect(objs.map((o) => o.type)).toEqual(['group', 'image'])
  expect(objs[0].children!.map((o) => o.type)).toEqual(['path', 'path', 'path', 'path', 'path'])
  // The SVG's page corner is at the drop point; the PNG cascades 16 px on.
  const img = objs[1]
  expect(img.x).toBeCloseTo(216, 0)
  expect(img.y).toBeCloseTo(166, 0)
  expect([img.w, img.h]).toEqual([40, 30])
  // One drop, one undo step.
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect(window.locator('[data-testid="draw-vector-L1"] path')).toHaveCount(0)
})

test('IMP-5 Placing a two-page PDF asks for the page, then places that page as an image at its size in points', async () => {
  const pdf = write('two-pages.pdf', makePdf())
  const id = await seedDrawDoc(window, v1Body([]), 'PDF target')
  await openDocument(window, id)
  await mockOpenDialog([pdf])
  await runMenu(window, 'file', 'Place…')
  await expect(window.locator('[data-testid="draw-pdf-page"]')).toBeVisible({ timeout: 15_000 })
  await window.locator('[data-testid="draw-pdf-page"]').fill('2')
  await window.locator('[data-testid="draw-pdf-page-place"]').click()
  // Wait for the cursor to load (the page renders in the main process).
  await expect.poll(async () => window.evaluate(() => document.querySelector('[data-testid="draw-stage"]')?.getAttribute('style') ?? ''), { timeout: 15_000 }).toContain('cursor: copy')
  await clickArtboard(800, { x: 50, y: 60 })
  await expect(window.locator('[data-testid="draw-import-report"]')).toContainText('placed as an image of page 2')
  await window.locator('[data-testid="draw-import-report-ok"]').click()
  await waitForSave(window)
  const objs = objectsOf((await readStored(window, id)).raw)
  expect(objs).toHaveLength(1)
  expect(objs[0]).toMatchObject({ type: 'image', w: 300, h: 150 })
  expect(String(objs[0].src).startsWith('data:image/png;base64,')).toBe(true)
})
