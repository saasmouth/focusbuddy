/**
 * 4.3.41 fixes, end to end on the REAL macOS pasteboard: what other apps see
 * after a PlexiiDraw copy, read with AppKit (NSPasteboard / NSImage, what
 * Pages, Keynote and Mail paste through) and with Chromium pasting into a
 * plain editable page (what a browser does); Copy from the app menu, from the
 * canvas right-click menu and from ⌘C; Copy As SVG Code; and files copied in
 * Finder pasting as art, not as their names.
 *
 * Throwaway profile (launchApp), PLEXI_APP=preview3. This spec uses the
 * machine's real clipboard; everything on it (every item and type: text,
 * pictures, file URLs) is saved before and put back after.
 */

import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { deflateSync } from 'zlib'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, readStored, rectObject, seedDrawDoc, stagePoint, storedView, v1Body } from './_drawHelpers'
import { copyFilesLikeFinder, readPasteboard, restorePasteboard, savePasteboard, type SavedPasteboard } from './_macPasteboard'

let app: LaunchedApp
let window: Page
let savedPasteboard: SavedPasteboard | null = null
let dir: string

test.skip(process.platform !== 'darwin', 'reads the macOS pasteboard')

test.beforeAll(async () => {
  app = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  window = app.window
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
  // Every item and type on the real pasteboard, put back in afterAll.
  if (process.platform === 'darwin') savedPasteboard = savePasteboard()
  dir = mkdtempSync(join(tmpdir(), 'plexii-draw-copyout-'))
})

test.afterAll(async () => {
  if (savedPasteboard) restorePasteboard(savedPasteboard)
  await app.dispose()
  rmSync(dir, { recursive: true, force: true })
})

type Obj = { id: string; type: string; text?: string; w?: number; h?: number; src?: string }
async function stored(id: string): Promise<Obj[]> {
  const v = storedView<{ layers: Array<{ kind: string; objects?: Obj[] }> }>((await readStored(window, id)).raw)
  return v.layers.filter((l) => l.kind === 'vector').flatMap((l) => l.objects ?? [])
}

/** Wait until something new is on the pasteboard, and return what other apps see. */
async function nextPasteboard(before: number): Promise<ReturnType<typeof readPasteboard>> {
  let pb = readPasteboard()
  for (let i = 0; i < 60 && pb.changeCount === before; i++) {
    await window.waitForTimeout(100)
    pb = readPasteboard()
  }
  return pb
}

async function openWithRect(): Promise<string> {
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 120, 160, 90, { fill: { type: 'solid', color: '#e64980' } })]), 'Copy out')
  await openDocument(window, id)
  const p = await stagePoint(window, 800, { x: 180, y: 165 })
  await window.mouse.click(p.x, p.y)
  await expect(window.locator('[data-testid="draw-selection"]')).toHaveCount(1)
  return id
}

/** A real PNG of one colour. */
function png(w: number, h: number): Buffer {
  const crcT = new Uint32Array(256).map((_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer): number => {
    let c = 0xffffffff
    for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (t: string, d: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(d.length)
    const td = Buffer.concat([Buffer.from(t, 'latin1'), d])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x40)])))
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** A one-page PDF with real text, 300 x 200 pt. */
function pdf(): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    ((s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`)('0 0 1 rg 20 20 260 60 re f BT /F1 28 Tf 30 120 Td (Hello PlexiiDraw) Tj ET'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => {
    offs.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

test('CO-1 ⌘C puts a picture other apps can paste: public.png that NSImage reads at the art\'s size, vectors as public.svg-image, no SVG source as text', async () => {
  await openWithRect()
  const before = readPasteboard().changeCount
  await window.keyboard.press('Meta+c')
  const pb = await nextPasteboard(before)
  expect(pb.types).toContain('public.png')
  expect(pb.bytes['public.png']).toBeGreaterThan(100)
  expect(pb.types).toContain('public.svg-image')
  // NSImage -- what Pages, Keynote, Mail and TextEdit paste a picture through.
  expect(pb.image).toEqual({ w: 160, h: 90 })
  // The text flavour, if any, is never the SVG source (that is what got pasted as text before).
  expect(pb.text ?? '').not.toContain('<svg')
  await expect(window.locator('[data-testid="draw-studio"]')).toContainText('Copied 1 object.')
})

test('CO-2 a browser pasting it gets an image (Chromium pasting into an editable page, reading the OS pasteboard)', async () => {
  await openWithRect()
  const before = readPasteboard().changeCount
  await window.keyboard.press('Meta+c')
  await nextPasteboard(before)
  const r = await app.app.evaluate(async ({ BrowserWindow }) => {
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    await w.loadURL('data:text/html,' + encodeURIComponent('<div id=e contenteditable style="width:400px;height:300px"></div><script>document.getElementById("e").focus()</script>'))
    w.webContents.paste()
    await new Promise((res) => setTimeout(res, 800))
    const html = (await w.webContents.executeJavaScript('document.getElementById("e").innerHTML')) as string
    w.destroy()
    return html
  })
  expect(r).toMatch(/^<img src="data:image\/png;base64,/)
})

test('CO-3 the app menu\'s Edit › Copy copies the selected art (it did nothing with no TEXT selected)', async () => {
  await openWithRect()
  const before = readPasteboard().changeCount
  // As a person does: the app is in front, then Edit › Copy in the menu bar.
  await app.app.evaluate(({ app: a, BrowserWindow, Menu }) => {
    a.focus({ steal: true })
    const win = BrowserWindow.getAllWindows().find((w) => w.isVisible())!
    win.focus()
    const edit = Menu.getApplicationMenu()!.items.find((i) => i.label === 'Edit')!
    edit.submenu!.items.find((i) => i.label === 'Copy')!.click(undefined, win, win.webContents)
  })
  const pb = await nextPasteboard(before)
  expect(pb.changeCount).toBeGreaterThan(before)
  expect(pb.image).toEqual({ w: 160, h: 90 })
})

test('CO-4 right-click on the art › Copy runs the same Copy', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 120, 160, 90), rectObject('b', 400, 300, 50, 50)]), 'Copy out menu')
  await openDocument(window, id)
  const p = await stagePoint(window, 800, { x: 420, y: 320 })
  // Right-clicking an unselected object selects it first, as in Illustrator.
  await window.mouse.click(p.x, p.y, { button: 'right' })
  await expect(window.locator('[data-testid="draw-context-menu"]')).toBeVisible()
  const before = readPasteboard().changeCount
  await window.locator('[data-testid="draw-context-edit.copy"]').click()
  await expect(window.locator('[data-testid="draw-context-menu"]')).toHaveCount(0)
  const pb = await nextPasteboard(before)
  expect(pb.image).toEqual({ w: 50, h: 50 })
})

test('CO-5 Copy As › SVG Code puts the markup on the pasteboard as text', async () => {
  await openWithRect()
  const before = readPasteboard().changeCount
  await window.locator('[data-testid="draw-studio-menubar-edit"]').click()
  const item = window.locator('button').filter({ hasText: 'SVG Code' })
  await expect(async () => {
    await window.locator('[data-testid="draw-studio-menubar-edit-list"] button').filter({ hasText: 'Copy As' }).hover()
    await expect(item).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 10_000 })
  await item.click()
  const pb = await nextPasteboard(before)
  expect(pb.text).toMatch(/^<svg [^>]*viewBox="100 120 160 90"/)
})

test('CO-6 files copied in Finder paste as art -- a PDF page and a PNG -- never as their names', async () => {
  test.setTimeout(60_000)
  const pdfPath = join(dir, 'flyer.pdf')
  const pngPath = join(dir, 'photo.png')
  writeFileSync(pdfPath, pdf())
  writeFileSync(pngPath, png(64, 48))
  const id = await seedDrawDoc(window, v1Body([]), 'Finder paste')
  await openDocument(window, id)
  // (Another process on this Mac may write the pasteboard too: copy until both files are on it.)
  await expect(async () => {
    copyFilesLikeFinder([pdfPath, pngPath])
    expect(readPasteboard().items).toBe(2)
  }).toPass({ timeout: 10_000 })
  await window.keyboard.press('Meta+v')
  // (Rendering the PDF page takes a moment on a busy machine.) The status line is part of what is compared, so a failure says why.
  const status = async (): Promise<string> => (await window.locator('[data-testid="draw-status"]').textContent().catch(() => '')) ?? ''
  await expect
    .poll(async () => [...(await stored(id)).map((o) => (o.type === 'text' ? `text:${o.text}` : o.type)), /could not|was not read|cannot/.test(await status()) ? `status:${await status()}` : 'ok'], { timeout: 30_000 })
    .toEqual(['image', 'image', 'ok'])
  const objs = await stored(id)
  // The PDF page at its size in points, rendered as a PNG; the PNG at its own size.
  expect([objs[0].w, objs[0].h]).toEqual([300, 200])
  expect(objs[0].src).toMatch(/^data:image\/png;base64,/)
  expect([objs[1].w, objs[1].h]).toEqual([64, 48])
})
