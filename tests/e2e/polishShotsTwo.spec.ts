import { test } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

const OUT =
  '/private/tmp/claude-501/-Applications-agentic-starter-kit-main/0d9ea3a0-0a94-4273-82da-09071878651b/scratchpad/plexi-shots'

test.setTimeout(60_000)

test('polish shots: renamed sidebar sections + assistant chips', async () => {
  const { app, window, dispose } = await launchApp()
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w) { w.setContentSize(1440, 900); w.center() }
  })
  try {
    await waitForReady(window)
    // Clear any persisted layout so new slim defaults apply; set futuristic theme.
    await window.evaluate(() => {
      localStorage.removeItem('plexii-main')
      localStorage.removeItem('plexii-main-v2')
      localStorage.setItem('fb.theme.mode', 'futuristic')
    })
    await window.reload()
    await waitForReady(window)
    await window.waitForTimeout(800)

    // 1. Home view — shows sidebar with renamed section labels.
    await window.screenshot({ path: `${OUT}/home-final.png` })
    console.log('[polish] wrote home-final.png')

    // 2. Assistant panel empty state — the resting chips render when there
    //    are no messages. The assistant panel is already visible on the right
    //    side of the home view. Just screenshot as-is; if the chips are in
    //    the panel they will appear in the full-window shot. Also try clicking
    //    into the assistant input area to make sure the panel is focused/active.
    const assistantInput = window.locator('textarea, [contenteditable="true"]').last()
    await assistantInput.click({ timeout: 3_000 }).catch(() => {})
    await window.waitForTimeout(400)
    await window.screenshot({ path: `${OUT}/assistant-empty.png` })
    console.log('[polish] wrote assistant-empty.png')
  } finally {
    await dispose()
  }
})
