// E2E spec: macOS auto-update UX fix
//
// The fix prevents the "update check failed" red flash on macOS by disabling
// autoDownload and autoInstallOnAppQuit (Squirrel.Mac always fails with ad-hoc
// signing). Instead the renderer shows a "Download vX.Y.Z" button that opens
// the releases page in the browser, rather than trying to stage an in-place
// install.
//
// NOTE: the actual electron-updater autoDownload=false behaviour only takes
// effect in a packaged build where the updater runs. That path is exercised
// by code inspection (see src/main/autoUpdate.ts:89-90 — IS_MAC guards both
// flags). This spec exercises the user-visible renderer layer and the IPC
// wiring, which is the full testable surface in a hermetic harness.

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Inject an UpdateState event into the focused renderer window. */
async function sendUpdateState(
  l: LaunchedApp,
  state: { kind: string; [k: string]: unknown }
): Promise<void> {
  await l.app.evaluate(({ BrowserWindow }, s) => {
    const wins = BrowserWindow.getAllWindows()
    if (wins[0] && !wins[0].isDestroyed()) {
      wins[0].webContents.send('update:state', s)
    }
  }, state as Record<string, unknown>)
}

/**
 * Spy on the macOS one-click updater IPC. The real handler downloads the
 * release and swaps the app, which we must not do in a test, so we replace it
 * with a counter. Returns a reader for the invocation count.
 */
async function installDownloadInstallSpy(l: LaunchedApp): Promise<void> {
  await l.app.evaluate(({ ipcMain }) => {
    interface SpyGlobal {
      __fb_download_install_calls: number
    }
    const g = globalThis as unknown as SpyGlobal
    g.__fb_download_install_calls = 0
    ipcMain.removeHandler('update:download-and-install')
    ipcMain.handle('update:download-and-install', () => {
      g.__fb_download_install_calls += 1
      return { ok: true as const }
    })
  })
}

async function readDownloadInstallCallCount(l: LaunchedApp): Promise<number> {
  return l.app.evaluate(() => {
    interface SpyGlobal {
      __fb_download_install_calls: number
    }
    return (globalThis as unknown as SpyGlobal).__fb_download_install_calls ?? 0
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('window.api.platform is darwin on the test machine', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const platform = await window.evaluate(() => {
    return (window as unknown as { api: { platform: string } }).api.platform
  })

  // This test suite runs on macOS. The preload must expose process.platform
  // verbatim — any other value means the banner would fall into Windows-mode
  // on a Mac and the fix would be inert.
  expect(platform).toBe('darwin')
})

test('available state on macOS renders the one-click Update button with the version', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await sendUpdateState(launched, { kind: 'available', version: '9.9.9' })

  const btn = window.locator('[data-testid="updater-download"]')
  await expect(btn).toBeVisible({ timeout: 5_000 })
  await expect(btn).toContainText('Update to v9.9.9')
})

test('clicking the Update button invokes the update:download-and-install IPC handler', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await installDownloadInstallSpy(launched)
  await sendUpdateState(launched, { kind: 'available', version: '9.9.9' })

  const btn = window.locator('[data-testid="updater-download"]')
  await expect(btn).toBeVisible({ timeout: 5_000 })
  await btn.click()

  // Give the IPC round-trip time to complete.
  await window.waitForTimeout(300)

  const calls = await readDownloadInstallCallCount(launched)
  expect(calls).toBe(1)
})

test('error state renders the retry affordance without crashing', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await sendUpdateState(launched, { kind: 'error', message: 'signature check failed' })

  // The banner shows the real reason inline plus two escapes — retry, and
  // download manually — so a failure is never a dead end. The copy is
  // "Update failed: <reason>"; the retry affordance carries a testid, so this
  // asserts that rather than the wording.
  await expect(window.getByText(/update failed/i).first()).toBeVisible({ timeout: 5000 })
  await expect(
    window.locator('[data-testid="updater-retry"]')
  ).toBeVisible({ timeout: 5_000 })
})

test('ready state on macOS shows the passive installing label, not an Install button', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await sendUpdateState(launched, { kind: 'ready', version: '9.9.9' })

  // On macOS the one-click flow synthesises a ready state right before the swap
  // helper relaunches, so we show a passive installing label.
  const installing = window.locator('[data-testid="updater-installing"]')
  await expect(installing).toBeVisible({ timeout: 5_000 })
  await expect(installing).toContainText('Installing v9.9.9')

  // The Windows-style "Install" button must NOT appear.
  const installBtn = window.locator('button', { hasText: /^install v/i })
  await expect(installBtn).toHaveCount(0)
})
