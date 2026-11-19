// Files copied in Finder and pasted (owner, 2026-11-19: paste must work
// everywhere; d0: route them by where the paste is aimed). A page is only given
// a Finder copy's names and icon, so main reads the files (main/pasteFiles.ts)
// and the page puts them where the paste was aimed (lib/pastedFiles.ts):
//
//   PF-1  Into the assistant's composer: both wait in the attachment tray, the
//         picture as a picture, the text file as a document.
//   PF-2  On the desk: one file work widget each, as a Finder drop makes; one
//         ⌘Z takes both away.
//   PF-3  In Files: imported into the folder shown.
//   PF-3b In the Files panel beside a desk, after a click on its blank area
//         (which holds no focus): imported there, nothing placed on the desk.
//   PF-4  In a text field (the Files panel's search): the files' names, as the
//         platform pastes them there; nothing imported, nothing placed.
//   PF-5  On a Gallery work widget, after a click on it: the picture joins the
//         gallery (one ⌘Z takes it out), the text file is named in a notice,
//         and nothing is placed on the desk.
//
// The pasteboard is the test's own (_clipboardStub.ts), holding what Finder
// puts there: the files' URLs (text/uri-list) and their names as text. The
// paste is Edit › Paste, which is what an unhandled ⌘V runs in the app (the
// page half of the stub answers a ⌘V inside the page, so main would not see
// it). The real ⌘V on a real Finder copy is _pasteFinderFilesNative.spec.ts.
import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { installClipboardStub, installMainClipboardStub, MOD } from './_clipboardStub'
import { png } from './_drawFixtureFiles'

let launched: LaunchedApp | null = null
let dir = ''
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plexii-finder-paste-'))
})
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
  rmSync(dir, { recursive: true, force: true })
})

/** Two files on disk, "copied in Finder": their URLs and names on the test's pasteboard. */
async function copyInFinder(l: LaunchedApp): Promise<string[]> {
  const shot = join(dir, 'shot.png')
  const notes = join(dir, 'notes.txt')
  writeFileSync(shot, png(40, 30))
  writeFileSync(notes, 'Budget review\nQ3 spend was 41k against a plan of 38k.\n')
  const urls = [shot, notes].map((p) => pathToFileURL(p).href).join('\r\n')
  await l.app.evaluate(
    async ({ clipboard, ClipboardItem }, { urls, names }) => {
      await clipboard.write([new ClipboardItem({ 'text/uri-list': new Blob([urls]), 'text/plain': new Blob([names]) })])
    },
    { urls, names: 'shot.png\rnotes.txt' }
  )
  return ['shot.png', 'notes.txt']
}

/** Edit › Paste in the app's menu, for the app's window. */
async function editPaste(l: LaunchedApp): Promise<void> {
  await l.app.evaluate(({ BrowserWindow, Menu }, url) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL() === url)!
    const edit = Menu.getApplicationMenu()!.items.find((i) => i.label === 'Edit')!
    edit.submenu!.items.find((i) => i.label === 'Paste')!.click(undefined, win, win.webContents)
  }, l.window.url())
}

async function openDesk(l: LaunchedApp, title: string): Promise<string> {
  const { window } = l
  await waitForReady(window)
  const deskId = await window.evaluate(async (t) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.nodes.create({ parentId: null, kind: 'task', title: t })).id
  }, title)
  await window.reload()
  await waitForReady(window)
  await installClipboardStub(window)
  await window.getByRole('button', { name: new RegExp(title) }).first().click()
  return deskId
}

const deskWidgets = (p: Page, deskId: string): Promise<Array<{ kind: string; title: string }>> =>
  p.evaluate(async (d) => (await (window as unknown as { api: typeof window.api }).api.widgets.listByTask(d)).map((w) => ({ kind: w.kind, title: w.title })), deskId)

test('PF-1 files copied in Finder, pasted into the assistant: both wait in the tray', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const { window } = launched
  await openDesk(launched, 'PasteTrayDesk')
  await window.locator('[data-testid="assistant-pill"]').click()
  const composer = window.locator('[data-testid="chat-composer"]').first()
  await expect(composer).toBeVisible({ timeout: 10_000 })
  await composer.click()
  await copyInFinder(launched)
  await editPaste(launched)
  const chips = window.locator('[data-testid="composer-attachment"]')
  await expect(chips).toHaveCount(2)
  await expect(chips.nth(0)).toHaveAttribute('data-status', 'ready', { timeout: 15_000 })
  await expect(chips.nth(1)).toHaveAttribute('data-status', 'ready', { timeout: 15_000 })
  await expect(chips.nth(0)).toContainText('shot.png')
  await expect(chips.nth(1)).toContainText('notes.txt')
  // Not their names typed into the message.
  expect(((await composer.textContent()) ?? '').trim()).toBe('')
})

test('PF-2 pasted on the desk: one file work widget each, and one ⌘Z takes both away', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const { window } = launched
  const deskId = await openDesk(launched, 'PasteFilesDesk')
  await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await copyInFinder(launched)
  await editPaste(launched)
  await expect.poll(() => deskWidgets(window, deskId)).toEqual([
    { kind: 'file', title: 'shot.png' },
    { kind: 'file', title: 'notes.txt' }
  ])
  await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await window.keyboard.press(`${MOD}+z`)
  await expect.poll(() => deskWidgets(window, deskId)).toEqual([])
})

async function openFiles(l: LaunchedApp): Promise<void> {
  const { window } = l
  await waitForReady(window)
  await installClipboardStub(window)
  await window.evaluate(() => (window as unknown as { __fbView: { getState: () => { goFiles: () => void } } }).__fbView.getState().goFiles())
  await expect(window.locator('[data-testid="files-view"], [data-testid="files-panel"]').first()).toBeVisible({ timeout: 10_000 })
}
const rootNames = (p: Page): Promise<string[]> =>
  p.evaluate(async () => (await (window as unknown as { api: typeof window.api }).api.fileManager.list(null)).map((e) => e.name).sort())

test('PF-3 pasted in Files: imported into the folder shown', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const { window } = launched
  await openFiles(launched)
  const before = await rootNames(window)
  // Bounded: unbounded, a click something covers retries until the test's own
  // timeout and fails as a bare "30000ms exceeded" naming nothing (PF-3, twice
  // in 14 two-worker runs on the 4.3.52 RC). Bounded, it names what was on top.
  await window.locator('[data-testid="files-view"], [data-testid="files-panel"]').first().click({ position: { x: 20, y: 300 }, timeout: 10_000 })
  await window.evaluate(() => {
    const el = document.querySelector('[data-testid="files-view"], [data-testid="files-panel"]') as HTMLElement
    if (!el.contains(document.activeElement)) {
      el.tabIndex = -1
      el.focus()
    }
  })
  await copyInFinder(launched)
  await editPaste(launched)
  await expect.poll(async () => (await rootNames(window)).filter((n) => !before.includes(n))).toEqual(['notes.txt', 'shot.png'])
})

test('PF-3b pasted in the Files panel after a click on its blank area: imported there, nothing on the desk', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const { window } = launched
  const deskId = await openDesk(launched, 'PastePanelDesk')
  await window.locator('[data-testid="files-panel-toggle"]').click()
  const list = window.locator('[data-testid="files-panel-list"], [data-testid="files-panel-grid"]').first()
  await expect(list).toBeVisible({ timeout: 10_000 })
  const before = await rootNames(window)
  const box = (await list.boundingBox())!
  await window.mouse.click(box.x + box.width / 2, box.y + box.height - 12)
  await copyInFinder(launched)
  await editPaste(launched)
  await expect.poll(async () => (await rootNames(window)).filter((n) => !before.includes(n))).toEqual(['notes.txt', 'shot.png'])
  expect(await deskWidgets(window, deskId)).toEqual([])
})

test('PF-4 pasted into a text field (the Files panel search): the names; nothing imported or placed', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const { window } = launched
  const deskId = await openDesk(launched, 'PasteSearchDesk')
  await window.locator('[data-testid="files-panel-toggle"]').click()
  const search = window.locator('[data-testid="files-panel-search"]')
  await expect(search).toBeVisible({ timeout: 10_000 })
  const before = await rootNames(window)
  await search.click()
  await copyInFinder(launched)
  await editPaste(launched)
  await expect(search).toHaveValue(/shot\.png/)
  // Long enough for an import or a placement to have landed, had one started.
  await window.waitForTimeout(750)
  expect(await rootNames(window)).toEqual(before)
  expect(await deskWidgets(window, deskId)).toEqual([])
})

test('PF-5 pasted on a Gallery after a click on it: the picture joins it, the text file is named', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const { window } = launched
  await waitForReady(window)
  const { deskId, galleryId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'PasteGalleryDesk' })
    const g = await api.widgets.create({ taskId: desk.id, kind: 'gallery', title: 'Pictures', content: JSON.stringify({ fileIds: [] }), x: 80, y: 80, width: 420, height: 320 } as never)
    return { deskId: desk.id, galleryId: g.id }
  })
  await window.reload()
  await waitForReady(window)
  await installClipboardStub(window)
  await window.getByRole('button', { name: /PasteGalleryDesk/ }).first().click()
  const gallery = window.locator(`[data-widget-id="${galleryId}"]`)
  await expect(gallery).toBeVisible({ timeout: 15_000 })
  const pictures = async (): Promise<number> =>
    ((JSON.parse((await window.evaluate(async (id) => (await (window as unknown as { api: typeof window.api }).api.widgets.get(id))?.content ?? '{}', galleryId)) || '{}') as { fileIds?: string[] }).fileIds ?? []).length
  const box = (await gallery.boundingBox())!
  await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await copyInFinder(launched)
  await editPaste(launched)
  await expect.poll(pictures).toBe(1)
  await expect(window.locator('[data-testid="notice-toast"]')).toContainText('notes.txt')
  expect(await deskWidgets(window, deskId)).toEqual([{ kind: 'gallery', title: 'Pictures' }])
  await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await window.keyboard.press(`${MOD}+z`)
  await expect.poll(pictures).toBe(0)
})
