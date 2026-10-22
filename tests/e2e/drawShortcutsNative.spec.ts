/**
 * File-menu shortcuts pressed for real (4.3.41): ⇧⌘P Place, ⌘O Open, ⌘C and
 * ⌘0 -- delivered through the macOS window server to the app's process
 * (CGEventPostToPid), so the app menu's key equivalents see them exactly as
 * they see a person's keypress -- with the canvas focused and with one of the
 * studio's own fields focused (where a shortcut used to do nothing). Also
 * pressed through Playwright's keyboard. Place of a one-page PDF lands an image
 * of the page, and the "Click to place" prompt clears.
 *
 * Throwaway profile (launchApp), PLEXI_APP=preview3. The native Open dialog is
 * replaced in the main process; nothing outside the app is pressed.
 */

import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { barTab, keepNoticesOutOfTheWay, openDocument, readStored, rectObject, seedDrawDoc, stagePoint, storedView, v1Body } from './_drawHelpers'
import { KEY, postKeyToPid, readPasteboard } from './_macPasteboard'

let app: LaunchedApp
let window: Page
let dir: string
let savedText = ''

test.skip(process.platform !== 'darwin', 'posts macOS key events')

test.beforeAll(async () => {
  app = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  window = app.window
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
  // This spec copies (the real clipboard): its text is saved now and put back after.
  savedText = await app.app.evaluate(({ clipboard }) => clipboard.readText())
  dir = mkdtempSync(join(tmpdir(), 'plexii-draw-keys-'))
})

test.afterAll(async () => {
  await app.app.evaluate(({ clipboard }, t) => clipboard.writeText(t), savedText).catch(() => undefined)
  await app.dispose()
  rmSync(dir, { recursive: true, force: true })
})

/** Replace the native Open dialog: record each title, and hand back `files` (or cancel). */
async function recordOpens(files: string[] = []): Promise<void> {
  await app.app.evaluate(async ({ dialog }, f) => {
    const g = globalThis as unknown as { __opens: string[] }
    g.__opens = []
    // @ts-expect-error test override of the native Open dialog
    dialog.showOpenDialog = async (...a: Array<{ title?: string }>) => {
      g.__opens.push(String(a[a.length - 1]?.title))
      return f.length ? { canceled: false, filePaths: f } : { canceled: true, filePaths: [] }
    }
  }, files)
}
const opens = (): Promise<string[]> => app.app.evaluate(() => (globalThis as unknown as { __opens: string[] }).__opens)

/** A real keypress for the app: focus its window, then post the chord to its process. */
async function press(code: number, mods: Array<'cmd' | 'shift' | 'alt'>): Promise<void> {
  // A key goes to the active app's key window: make the test app active first
  // (another app may be in front on a machine in use).
  await app.app.evaluate(({ app: a, BrowserWindow }) => {
    a.focus({ steal: true })
    BrowserWindow.getAllWindows().find((w) => w.isVisible())?.focus()
  })
  await window.waitForTimeout(150)
  postKeyToPid(app.app.process().pid!, code, mods)
  await window.waitForTimeout(600)
}

async function openDrawing(): Promise<string> {
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 120, 160, 90)]), 'Shortcuts')
  await openDocument(window, id)
  await window.waitForTimeout(300)
  return id
}

test('NK-1 ⇧⌘P opens Place and ⌘O opens Open SVG, pressed as a person presses them, canvas focused', async () => {
  await openDrawing()
  await recordOpens()
  await press(KEY.P, ['cmd', 'shift'])
  await expect.poll(opens).toEqual(['Place'])
  await press(KEY.O, ['cmd'])
  await expect.poll(opens).toEqual(['Place', 'Open SVG'])
})

test('NK-2 the same chords fire while one of the studio\'s fields has focus (they used to do nothing)', async () => {
  await openDrawing()
  await recordOpens()
  // Select the shape so the Object tab's Transform fields show, and focus one.
  const p = await stagePoint(window, 800, { x: 180, y: 165 })
  await window.mouse.click(p.x, p.y)
  await barTab(window, 'object')
  const field = window.locator('[data-testid="draw-transform-x"]')
  await field.click()
  expect(await window.evaluate(() => document.activeElement?.tagName)).toBe('INPUT')
  await press(KEY.P, ['cmd', 'shift'])
  await expect.poll(opens).toEqual(['Place'])
  // Playwright's keyboard too.
  await field.click()
  await window.keyboard.press('Meta+Shift+p')
  await expect.poll(opens).toEqual(['Place', 'Place'])
  await window.keyboard.press('Meta+o')
  await expect.poll(opens).toEqual(['Place', 'Place', 'Open SVG'])
})

test('NK-3 ⌘- and ⌘0 zoom the drawing (⌘0 fits its artboard), never the app\'s own text size -- even when the app menu takes the key', async () => {
  await openDrawing()
  const stageW = async (): Promise<number> => (await window.locator('[data-testid="draw-stage"]').boundingBox())!.width
  const appZoom = (): Promise<number> => app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())!.webContents.getZoomFactor())
  const fitted = await stageW()
  const z0 = await appZoom()
  await press(KEY.Minus, ['cmd'])
  await expect.poll(stageW).toBeLessThan(fitted - 1)
  expect(await appZoom()).toBe(z0)
  await press(KEY.Zero, ['cmd'])
  await expect.poll(stageW).toBeCloseTo(fitted, 0)
  expect(await appZoom()).toBe(z0)
})

test('NK-4 ⇧⌘P with a one-page PDF places an image of the page, and the prompt clears', async () => {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    ((s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`)('1 0 0 rg 20 20 260 60 re f BT /F1 28 Tf 30 120 Td (Hello) Tj ET'),
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
  const file = join(dir, 'hello.pdf')
  writeFileSync(file, Buffer.from(out, 'latin1'))

  const id = await seedDrawDoc(window, v1Body([]), 'Place PDF')
  await openDocument(window, id)
  await recordOpens([file])
  await press(KEY.P, ['cmd', 'shift'])
  await expect(window.locator('[data-testid="draw-studio"]')).toContainText('Click to place hello.pdf', { timeout: 15_000 })
  const p = await stagePoint(window, 800, { x: 40, y: 40 })
  await window.mouse.move(p.x + 20, p.y + 20)
  await window.mouse.move(p.x, p.y)
  await window.mouse.down()
  await window.mouse.up()
  await expect
    .poll(async () => {
      const v = storedView<{ layers: Array<{ kind: string; objects?: Array<{ type: string; w: number; h: number; src?: string }> }> }>((await readStored(window, id)).raw)
      return v.layers.flatMap((l) => l.objects ?? []).map((o) => `${o.type}:${o.w}x${o.h}:${(o.src ?? '').slice(0, 22)}`)
    }, { timeout: 8_000 })
    .toEqual(['image:300x200:data:image/png;base64,'])
  await expect(window.locator('[data-testid="draw-studio"]')).not.toContainText('Click to place hello.pdf')
})

test('NK-5 ⌘C pressed as a person presses it copies the selected art, whether the page or the app menu takes the key', async () => {
  await openDrawing()
  const p = await stagePoint(window, 800, { x: 180, y: 165 })
  await window.mouse.click(p.x, p.y)
  await expect(window.locator('[data-testid="draw-selection"]')).toHaveCount(1)
  const before = readPasteboard().changeCount
  await press(KEY.C, ['cmd'])
  await expect.poll(() => readPasteboard().changeCount, { timeout: 8_000 }).toBeGreaterThan(before)
  expect(readPasteboard().image).toEqual({ w: 160, h: 90 })
})
