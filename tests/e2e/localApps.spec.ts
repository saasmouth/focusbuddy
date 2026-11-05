import { test, expect } from '@playwright/test'
import { exec } from 'child_process'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { realInputAllowed } from './_macMouse'

// Local-app integration: create with kind='local', drag-to-canvas spawns the
// launcher widget (not webview), and the launch IPC actually runs `open -a`.
// We use TextEdit as our test target — it ships with every macOS install.

let launched: LaunchedApp | null = null
const TEST_APP_PATH = '/System/Applications/TextEdit.app'

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('describeLocalApp pulls title + bundle id + icon from a real .app bundle', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const desc = await window.evaluate(async (path: string) => {
    return await window.api.localApp.describe(path)
  }, TEST_APP_PATH)

  expect(desc).not.toBeNull()
  expect(desc!.title).toBe('TextEdit')
  expect(desc!.appPath).toBe(TEST_APP_PATH)
  // Bundle id is typically com.apple.TextEdit but we don't assert the exact
  // string — we just need *something* there so launch-by-bundle-id works.
  expect(desc!.bundleId).not.toBeNull()
  // Icon must come back as a base64 PNG that's at least a few bytes.
  expect(desc!.iconPngBase64).not.toBeNull()
  expect(desc!.iconPngBase64!.length).toBeGreaterThan(100)
})

test('describeLocalApp rejects non-.app paths', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const desc = await window.evaluate(async () => {
    // /etc/hosts exists but isn't an .app bundle. The picker filter only
    // catches .app at the dialog level; describe() must also enforce.
    return await window.api.localApp.describe('/etc/hosts')
  })

  expect(desc).toBeNull()
})

test('create + persist a local Connected App round-trips through the DB', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const created = await window.evaluate(async (path: string) => {
    const desc = await window.api.localApp.describe(path)
    if (!desc) throw new Error('describe returned null')
    return await window.api.connectedApps.create({
      title: desc.title,
      url: `file://${desc.appPath}`,
      icon: 'apps',
      color: null,
      kind: 'local',
      appPath: desc.appPath,
      bundleId: desc.bundleId,
      iconPngBase64: desc.iconPngBase64
    })
  }, TEST_APP_PATH)

  expect(created.kind).toBe('local')
  expect(created.appPath).toBe(TEST_APP_PATH)
  expect(created.bundleId).not.toBeNull()
  expect(created.iconPngBase64).not.toBeNull()

  // Reload window and verify the local-app columns survive hydration.
  await window.reload()
  await waitForReady(window)

  const reread = await window.evaluate(async (id: string) => {
    const list = await window.api.connectedApps.list()
    return list.find((a) => a.id === id) ?? null
  }, created.id)

  expect(reread).not.toBeNull()
  expect(reread!.kind).toBe('local')
  expect(reread!.appPath).toBe(TEST_APP_PATH)
  expect(reread!.bundleId).toBe(created.bundleId)
  expect(reread!.iconPngBase64).toBe(created.iconPngBase64)
})

test('launching a local app via IPC returns ok (TextEdit opens)', async () => {
  // Opens a real TextEdit window on the owner's screen and takes focus (owner, 2026-11-05).
  test.skip(!realInputAllowed(), "opens a real TextEdit window on the owner's screen: set PLEXII_REAL_INPUT=1 once the owner has said the Mac is free")
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const result = await window.evaluate(async (path: string) => {
    return await window.api.localApp.launch({
      appPath: path,
      bundleId: null
    })
  }, TEST_APP_PATH)

  expect(result.ok).toBe(true)

  // Give launchctl/open a moment to start the process, then poll isRunning.
  // We can't be 100% sure TextEdit wasn't already running from before, but if
  // launch returned ok and isRunning sees it, the integration is wired.
  await window.waitForTimeout(1500)
  const running = await window.evaluate(async () => {
    return await window.api.localApp.isRunning({
      appPath: '/System/Applications/TextEdit.app',
      title: 'TextEdit'
    })
  })
  expect(running).toBe(true)

  // Clean up: close TextEdit so we don't leave a flapping window behind.
  // We run from the test-process side (not via electronApp.evaluate, whose
  // eval context doesn't expose CommonJS require).
  await new Promise<void>((resolve) => {
    exec('osascript -e \'tell application "TextEdit" to quit\'', () => resolve())
  })
})

test('launch returns error when both appPath and bundleId are null', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const result = await window.evaluate(async () => {
    return await window.api.localApp.launch({ appPath: null, bundleId: null })
  })

  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error).toContain('No appPath or bundleId')
  }
})

test('dragging a local Connected App onto canvas spawns a local-app-launcher widget', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Seed: task + local connected app.
  const seeded = await window.evaluate(async (path: string) => {
    const task = await window.api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Notes session'
    })
    const desc = await window.api.localApp.describe(path)
    if (!desc) throw new Error('describe null')
    const app = await window.api.connectedApps.create({
      title: desc.title,
      url: `file://${desc.appPath}`,
      icon: 'apps',
      color: null,
      kind: 'local',
      appPath: desc.appPath,
      bundleId: desc.bundleId,
      iconPngBase64: desc.iconPngBase64
    })
    return { taskId: task.id, appId: app.id, title: desc.title }
  }, TEST_APP_PATH)

  await window.reload()
  await waitForReady(window)

  await expect(
    window.getByRole('button', { name: 'Notes session' }).first()
  ).toBeVisible({ timeout: 5_000 })
  await window.getByRole('button', { name: 'Notes session' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  await window.evaluate(({ appId }) => {
    const dropTarget = document.querySelector('[data-canvas-surface="true"]')!
    const dt = new DataTransfer()
    dt.setData('text/fb-connected-app', appId)
    dt.effectAllowed = 'copy'
    const rect = dropTarget.getBoundingClientRect()
    const clientX = rect.left + rect.width / 2
    const clientY = rect.top + rect.height / 2
    dropTarget.dispatchEvent(
      new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY })
    )
    dropTarget.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY })
    )
    dropTarget.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY })
    )
  }, { appId: seeded.appId })

  await window.waitForTimeout(800)

  const widgets = await window.evaluate(async ({ taskId }) => {
    return await window.api.widgets.listByTask(taskId)
  }, { taskId: seeded.taskId })

  // Critical assertion: local apps spawn a launcher tile, NOT a webview.
  // A webview pointing at file:///System/Applications/TextEdit.app would be
  // useless (and would render the bundle directory's HTML if any).
  const launchers = widgets.filter((w) => w.kind === 'local-app-launcher')
  expect(launchers.length).toBe(1)
  expect(launchers[0].sourceAppId).toBe(seeded.appId)
  // No webview should have been created.
  expect(widgets.filter((w) => w.kind === 'webview').length).toBe(0)
})
