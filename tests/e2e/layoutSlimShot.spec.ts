import { test } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

const OUT =
  '/private/tmp/claude-501/-Applications-agentic-starter-kit-main/0d9ea3a0-0a94-4273-82da-09071878651b/scratchpad/plexi-shots'

test.setTimeout(60_000)

test('layout slim proportions screenshot', async () => {
  // launchApp always uses a fresh isolated userData dir (mkdtemp), so no old
  // panel layout can be restored from a previous session. The new
  // plexii-main-v2 autoSaveId defaults take effect on first boot.
  const { app, window, dispose } = await launchApp()
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w) { w.setContentSize(1440, 900); w.center() }
  })
  try {
    await waitForReady(window)
    // Also wipe any localStorage panel-layout key that might survive across
    // hot reloads, then reload so the new default sizes are applied fresh.
    await window.evaluate(() => {
      // Remove both the old and new autoSaveId keys to be safe.
      localStorage.removeItem('plexii-main')
      localStorage.removeItem('plexii-main-v2')
      localStorage.setItem('fb.theme.mode', 'futuristic')
    })
    await window.reload()
    await waitForReady(window)
    await window.waitForTimeout(800)
    await window.screenshot({ path: `${OUT}/layout-slim.png` })
    console.log('[slim] wrote layout-slim.png')
  } finally {
    await dispose()
  }
})
