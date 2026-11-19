/**
 * Files copied in Finder and pasted with a real ⌘V, on the REAL macOS
 * pasteboard: what pasteFinderFiles.spec.ts proves on the test's own
 * clipboard, here end to end through AppKit (Finder's NSURL objects and the
 * filenames list) and the app menu's real key equivalent.
 *
 *   PFN-1  Into the assistant's composer: both files wait in the tray.
 *   PFN-2  On the desk: one file work widget each.
 *
 * Opt-in: it writes the OWNER's pasteboard and posts real keys, so it runs only
 * with PLEXII_REAL_INPUT=1 (the owner has said the Mac is free) and
 * PLEXII_E2E_SWEEPS=1 (the _ prefix), one spec at a time across workers
 * (_realInputLock.ts). Everything on the pasteboard (every item and type) is
 * saved before and put back after.
 */
import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { png } from './_drawFixtureFiles'
import { KEY, copyFilesLikeFinder, postKeyToPid, restorePasteboard, savePasteboard, type SavedPasteboard } from './_macPasteboard'
import { realInputAllowed, REAL_INPUT_SKIP } from './_macMouse'
import { acquireRealInput, releaseRealInput } from './_realInputLock'

let app: LaunchedApp
let window: Page
let saved: SavedPasteboard | null = null
let dir = ''
let files: string[] = []

// Writes the owner's real pasteboard and posts real keys: never unasked.
test.skip(!realInputAllowed(), REAL_INPUT_SKIP)
test.skip(process.platform !== 'darwin', 'reads the macOS pasteboard')
test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(240_000)
  await acquireRealInput('pasteFinderFilesNative')
  saved = savePasteboard()
  dir = mkdtempSync(join(tmpdir(), 'plexii-finder-native-'))
  files = [join(dir, 'shot.png'), join(dir, 'notes.txt')]
  writeFileSync(files[0], png(40, 30))
  writeFileSync(files[1], 'Budget review\nQ3 spend was 41k.\n')
  // The real pasteboard on purpose: past the clipboard guard.
  app = await launchApp({ realClipboard: true })
  window = app.window
  await waitForReady(window)
})

test.afterAll(async () => {
  try {
    if (saved) restorePasteboard(saved)
    await app?.dispose()
    if (dir) rmSync(dir, { recursive: true, force: true })
  } finally {
    releaseRealInput()
  }
})

/** A real ⌘V for the app: its window in front, then the chord posted to its process. */
async function pressPaste(): Promise<void> {
  await app.app.evaluate(({ app: a, BrowserWindow }) => {
    a.focus({ steal: true })
    BrowserWindow.getAllWindows().find((w) => w.isVisible())?.focus()
  })
  await window.waitForTimeout(150)
  postKeyToPid(app.app.process().pid!, KEY.V, ['cmd'])
  await window.waitForTimeout(600)
}

async function openDesk(title: string): Promise<string> {
  const deskId = await window.evaluate(async (t) => (await (window as unknown as { api: typeof window.api }).api.nodes.create({ parentId: null, kind: 'task', title: t })).id, title)
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: new RegExp(title) }).first().click()
  return deskId
}

test('PFN-1 a real Finder copy and a real ⌘V into the assistant: both files in the tray', async () => {
  await openDesk('NativeTrayDesk')
  await window.locator('[data-testid="assistant-pill"]').click()
  const composer = window.locator('[data-testid="chat-composer"]').first()
  await composer.click()
  copyFilesLikeFinder(files)
  await pressPaste()
  const chips = window.locator('[data-testid="composer-attachment"]')
  await expect(chips).toHaveCount(2, { timeout: 10_000 })
  await expect(chips.nth(0)).toContainText('shot.png')
  await expect(chips.nth(1)).toContainText('notes.txt')
})

test('PFN-2 a real Finder copy and a real ⌘V on the desk: one file work widget each', async () => {
  const deskId = await openDesk('NativeFilesDesk')
  await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  copyFilesLikeFinder(files)
  await pressPaste()
  await expect
    .poll(async () => (await window.evaluate(async (d) => (await (window as unknown as { api: typeof window.api }).api.widgets.listByTask(d)).map((w) => w.title), deskId)).sort(), { timeout: 10_000 })
    .toEqual(['notes.txt', 'shot.png'])
})
