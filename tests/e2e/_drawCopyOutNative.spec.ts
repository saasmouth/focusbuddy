/**
 * What other Mac apps see after a PlexiiDraw copy, on the REAL macOS
 * pasteboard: read with AppKit (NSPasteboard / NSImage, what Pages, Keynote
 * and Mail paste through), pasted by Chromium from the OS pasteboard (what a
 * browser does), and files copied in Finder pasting as art.
 *
 * Only the real pasteboard can prove these, so this spec is opt-in: the
 * pasteboard is the OWNER's and is shared with every other worker. It runs
 * only with PLEXII_REAL_INPUT=1 (the owner has said the Mac is free) and
 * PLEXII_E2E_SWEEPS=1 (the _ prefix), one spec at a time across workers
 * (_realInputLock.ts), and everything on the pasteboard (every item and type)
 * is saved before and put back after. What the app writes for each way of
 * copying is drawCopyOut.spec.ts, on the test's own clipboard.
 *
 * Throwaway profile (launchApp), PLEXI_APP=preview3.
 */

import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, readStored, rectObject, seedDrawDoc, stagePoint, storedView, v1Body } from './_drawHelpers'
import { pdf, png } from './_drawFixtureFiles'
import { copyFilesLikeFinder, readPasteboard, restorePasteboard, savePasteboard, type SavedPasteboard } from './_macPasteboard'
import { realInputAllowed, REAL_INPUT_SKIP } from './_macMouse'
import { acquireRealInput, releaseRealInput } from './_realInputLock'

let app: LaunchedApp
let window: Page
let savedPasteboard: SavedPasteboard | null = null
let dir: string

// Writes the owner's real pasteboard: never unasked.
test.skip(!realInputAllowed(), REAL_INPUT_SKIP)
test.skip(process.platform !== 'darwin', 'reads the macOS pasteboard')

test.beforeAll(async () => {
  test.setTimeout(240_000)
  await acquireRealInput('drawCopyOutNative')
  // The real pasteboard on purpose (opt-in, under the real-input lock): past the clipboard guard.
  app = await launchApp({ env: { PLEXI_APP: 'preview3' }, realClipboard: true })
  window = app.window
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
  // Every item and type on the real pasteboard, put back in afterAll.
  savedPasteboard = savePasteboard()
  dir = mkdtempSync(join(tmpdir(), 'plexii-draw-copyout-'))
})

test.afterAll(async () => {
  try {
    if (savedPasteboard) restorePasteboard(savedPasteboard)
    await app?.dispose()
    if (dir) rmSync(dir, { recursive: true, force: true })
  } finally {
    releaseRealInput()
  }
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

test('CON-1 ⌘C puts a picture other apps can paste: public.png that NSImage reads at the art\'s size, vectors as public.svg-image, no SVG source as text', async () => {
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

test('CON-2 a browser pasting it gets an image (Chromium pasting into an editable page, reading the OS pasteboard)', async () => {
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

test('CON-3 files copied in Finder paste as art -- a PDF page and a PNG -- never as their names', async () => {
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
