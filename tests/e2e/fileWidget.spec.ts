import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// FileWidget v2 — verifies three new paths:
//   1. URL paste mode: a user can paste a cloud link, the widget renders a
//      hostname card, and clicking it fires shell.openExternal (spied via
//      app.evaluate in the main process).
//   2. Local file ingest + thumbnail: ingest a real PNG into the DB, render
//      the widget, click the rendered image — shell.openPath is invoked
//      with the stored path.
//
// We spy at the main-process boundary (shell.openExternal / shell.openPath)
// rather than monkey-patching window.api in the renderer because
// contextBridge.exposeInMainWorld returns a frozen object — renderer-side
// assignment is silently ignored.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

/**
 * Install main-process spies on shell.openExternal + shell.openPath so the
 * test can observe what the FileWidget triggers without actually launching
 * a browser or a default app. Returns a reader the test can poll.
 */
async function installShellSpy(launched: LaunchedApp): Promise<void> {
  await launched.app.evaluate(async ({ shell }) => {
    interface SpyGlobal {
      __fb_open_external: string[]
      __fb_open_path: string[]
    }
    const g = globalThis as unknown as SpyGlobal
    g.__fb_open_external = []
    g.__fb_open_path = []
    const origExt = shell.openExternal
    const origPath = shell.openPath
    shell.openExternal = async (url: string, opts?: Electron.OpenExternalOptions) => {
      g.__fb_open_external.push(url)
      void opts
      void origExt
      return undefined
    }
    shell.openPath = async (path: string) => {
      g.__fb_open_path.push(path)
      void origPath
      return ''
    }
  })
}

async function readSpyOpens(launched: LaunchedApp): Promise<{
  external: string[]
  path: string[]
}> {
  return launched.app.evaluate(async () => {
    interface SpyGlobal {
      __fb_open_external: string[]
      __fb_open_path: string[]
    }
    const g = globalThis as unknown as SpyGlobal
    return {
      external: g.__fb_open_external ?? [],
      path: g.__fb_open_path ?? []
    }
  })
}

test('URL paste mode: paste a cloud link → renders hostname card → click fires shell.openExternal', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await installShellSpy(launched)

  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})

  // Seed: a task + an empty file widget for the user to paste into.
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'File-URL test'
    })
    await api.widgets.create({
      taskId: task.id,
      kind: 'file',
      title: '',
      content: '',
      x: 200,
      y: 200,
      width: 320,
      height: 280
    })
  })

  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip2.isVisible().catch(() => false)) await skip2.click().catch(() => {})
  await window.getByRole('button', { name: 'File-URL test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  // Empty FileWidget shows URL input + add button
  const urlInput = window.locator('[data-testid="file-url-input"]').first()
  await expect(urlInput).toBeVisible({ timeout: 5_000 })
  await urlInput.fill('https://docs.google.com/document/d/abc123/edit')
  await window.locator('[data-testid="file-url-submit"]').first().click()

  // After submit, widget enters URL mode → open button is visible.
  const openBtn = window.locator('[data-testid="file-open-url"]').first()
  await expect(openBtn).toBeVisible({ timeout: 5_000 })

  // Click the card → main process should see shell.openExternal fire.
  await openBtn.click()
  await window.waitForTimeout(200)

  const spied = await readSpyOpens(launched)
  expect(spied.external.length).toBeGreaterThan(0)
  expect(spied.external[0]).toContain('docs.google.com')
})

test('Local file mode: ingest a PNG, click the rendered image → shell.openPath fires with the stored path', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await installShellSpy(launched)

  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})

  // 1x1 transparent PNG (smallest valid PNG bytes).
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
    'hex'
  )
  const tmpFile = join(tmpdir(), `fb-e2e-thumb-${Date.now()}.png`)
  writeFileSync(tmpFile, png)

  const seeded = await window.evaluate(
    async (input: { path: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const task = await api.nodes.create({
        parentId: null,
        kind: 'task',
        title: 'File-local test'
      })
      const file = await api.files.ingestPath(input.path)
      const w = await api.widgets.create({
        taskId: task.id,
        kind: 'file',
        title: file.originalName,
        content: file.id,
        x: 200,
        y: 200,
        width: 320,
        height: 280
      })
      return { taskId: task.id, widgetId: w.id, fileId: file.id, storedPath: file.storedPath }
    },
    { path: tmpFile }
  )

  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip2.isVisible().catch(() => false)) await skip2.click().catch(() => {})
  await window.getByRole('button', { name: 'File-local test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  // PNG → image renderer → fb-file://<id> <img> with onClick=open
  const img = window.locator(`img[src="fb-file://${seeded.fileId}"]`).first()
  await expect(img).toBeVisible({ timeout: 5_000 })
  await img.click()
  await window.waitForTimeout(200)

  const spied = await readSpyOpens(launched)
  expect(spied.path.length).toBeGreaterThan(0)
  expect(spied.path[0]).toBe(seeded.storedPath)
})
