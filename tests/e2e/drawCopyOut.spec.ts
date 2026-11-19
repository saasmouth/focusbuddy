/**
 * 4.3.41 fixes, end to end: what a PlexiiDraw copy puts on the clipboard for
 * other apps, for each way of copying -- ⌘C, the app menu's Edit › Copy, the
 * canvas right-click menu, Copy As › SVG Code -- and files copied in Finder
 * pasting as art, not as their names.
 *
 * The clipboard is the test's own (tests/e2e/_clipboardStub.ts, both halves),
 * read in main through Electron's clipboard module, as the app writes it;
 * never the machine's clipboard, which is shared between workers and is the
 * owner's. What AppKit and Chromium make of the real pasteboard (NSImage's
 * size, a browser's paste, a real Finder copy) is _drawCopyOutNative.spec.ts,
 * opt-in.
 *
 * Throwaway profile (launchApp), PLEXI_APP=preview3.
 */

import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, readStored, rectObject, seedDrawDoc, stagePoint, storedView, v1Body } from './_drawHelpers'
import { installClipboardStub, installMainClipboardStub } from './_clipboardStub'
import { pdf, png, pngPointSize } from './_drawFixtureFiles'

let app: LaunchedApp
let window: Page
let dir: string

test.skip(process.platform !== 'darwin', "Draw's copy writes the macOS flavours (public.png, public.svg-image)")

test.beforeAll(async () => {
  app = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  await installMainClipboardStub(app.app)
  window = app.window
  await waitForReady(window)
  await installClipboardStub(window)
  await keepNoticesOutOfTheWay(window)
  dir = mkdtempSync(join(tmpdir(), 'plexii-draw-copyout-'))
})

test.afterAll(async () => {
  await app.dispose()
  rmSync(dir, { recursive: true, force: true })
})

type Obj = { id: string; type: string; text?: string; w?: number; h?: number; src?: string }
async function stored(id: string): Promise<Obj[]> {
  const v = storedView<{ layers: Array<{ kind: string; objects?: Obj[] }> }>((await readStored(window, id)).raw)
  return v.layers.filter((l) => l.kind === 'vector').flatMap((l) => l.objects ?? [])
}

const SVG_RAW = 'electron application/osclipboard;format="public.svg-image"'
const PNG_RAW = 'electron application/osclipboard;format="public.png"'

type Seen = { types: string[]; png: Buffer | null; text: string }
async function clearClipboard(): Promise<void> {
  await app.app.evaluate(({ clipboard }) => clipboard.clear())
}
/** Wait until something is on the clipboard (cleared before the copy), and return what another app would read. */
async function nextClipboard(): Promise<Seen> {
  let seen: Seen = { types: [], png: null, text: '' }
  await expect
    .poll(
      async () => {
        const r = await app.app.evaluate(async ({ clipboard }) => {
          const item = (await clipboard.read())[0]
          if (!item) return null
          const png = item.types.includes('image/png') ? Buffer.from(await (await item.getType('image/png')).arrayBuffer()).toString('base64') : null
          return { types: item.types, png, text: clipboard.readText() }
        })
        if (r) seen = { types: r.types, png: r.png ? Buffer.from(r.png, 'base64') : null, text: r.text }
        return seen.types.length
      },
      { timeout: 6_000 }
    )
    .toBeGreaterThan(0)
  return seen
}

async function openWithRect(): Promise<string> {
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 120, 160, 90, { fill: { type: 'solid', color: '#e64980' } })]), 'Copy out')
  await openDocument(window, id)
  const p = await stagePoint(window, 800, { x: 180, y: 165 })
  await window.mouse.click(p.x, p.y)
  await expect(window.locator('[data-testid="draw-selection"]')).toHaveCount(1)
  return id
}

test('CO-1 ⌘C puts a picture other apps can paste: public.png at the art\'s size in points, vectors as public.svg-image, no SVG source as text', async () => {
  await openWithRect()
  await clearClipboard()
  await window.keyboard.press('Meta+c')
  const pb = await nextClipboard()
  expect(pb.types).toContain(PNG_RAW)
  expect(pb.png?.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(pb.types).toContain(SVG_RAW)
  // The size NSImage (Pages, Keynote, Mail, TextEdit) gives it: its pixels at its density.
  expect(pb.png && pngPointSize(pb.png)).toEqual({ w: 160, h: 90 })
  // The text flavour, if any, is never the SVG source (that is what got pasted as text before).
  expect(pb.text).not.toContain('<svg')
  await expect(window.locator('[data-testid="draw-studio"]')).toContainText('Copied 1 object.')
})

test('CO-3 the app menu\'s Edit › Copy copies the selected art (it did nothing with no TEXT selected)', async () => {
  await openWithRect()
  await clearClipboard()
  // The menu item itself, clicked for the app's window (no focus is taken from the owner's apps).
  await app.app.evaluate(({ BrowserWindow, Menu }, url) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL() === url)!
    const edit = Menu.getApplicationMenu()!.items.find((i) => i.label === 'Edit')!
    edit.submenu!.items.find((i) => i.label === 'Copy')!.click(undefined, win, win.webContents)
  }, window.url())
  const pb = await nextClipboard()
  expect(pb.png && pngPointSize(pb.png)).toEqual({ w: 160, h: 90 })
})

test('CO-4 right-click on the art › Copy runs the same Copy', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 120, 160, 90), rectObject('b', 400, 300, 50, 50)]), 'Copy out menu')
  await openDocument(window, id)
  const p = await stagePoint(window, 800, { x: 420, y: 320 })
  // Right-clicking an unselected object selects it first, as in Illustrator.
  await window.mouse.click(p.x, p.y, { button: 'right' })
  await expect(window.locator('[data-testid="draw-context-menu"]')).toBeVisible()
  // A greyed row says why, as the menu bar does (SPEC §9.5): one rectangle is no group.
  await expect(window.locator('[data-testid="draw-context-object.ungroup"]')).toBeDisabled()
  await expect(window.locator('[data-testid="draw-context-object.ungroup"]')).toContainText('Select a group to ungroup.')
  await clearClipboard()
  await window.locator('[data-testid="draw-context-edit.copy"]').click()
  await expect(window.locator('[data-testid="draw-context-menu"]')).toHaveCount(0)
  const pb = await nextClipboard()
  expect(pb.png && pngPointSize(pb.png)).toEqual({ w: 50, h: 50 })
})

test('CO-5 Copy As › SVG Code puts the markup on the pasteboard as text', async () => {
  await openWithRect()
  await clearClipboard()
  await window.locator('[data-testid="draw-studio-menubar-edit"]').click()
  const item = window.locator('button').filter({ hasText: 'SVG Code' })
  await expect(async () => {
    await window.locator('[data-testid="draw-studio-menubar-edit-list"] button').filter({ hasText: 'Copy As' }).hover()
    await expect(item).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 10_000 })
  await item.click()
  const pb = await nextClipboard()
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
  // As Finder puts them: the files' URLs, and beside them their NAMES as text
  // and an ICON as a picture, which a paste must not take instead.
  await app.app.evaluate(
    async ({ clipboard, ClipboardItem }, { paths, icon }) => {
      const urls = paths.map((p) => 'file://' + encodeURI(p)).join('\r\n')
      const names = paths.map((p) => p.split('/').pop()).join('\r')
      await clipboard.write([new ClipboardItem({ 'text/uri-list': urls, 'text/plain': names, 'image/png': new Blob([new Uint8Array(Buffer.from(icon, 'base64'))], { type: 'image/png' }) })])
    },
    { paths: [pdfPath, pngPath], icon: png(16, 16).toString('base64') }
  )
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
