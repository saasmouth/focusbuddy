import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Smoke test — does the main window mount + the React tree render?
// Catches main-process crashes (DB init, IPC handler registration) and renderer
// boot failures (missing modules, unresolvable imports) that typecheck misses.
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('app boots and renders the React shell', async () => {
  launched = await launchApp()
  const { window } = launched

  // waitForReady gates on (a) window.api being exposed and (b) the
  // sidebar wordmark heading being visible. Anchors via a regex so
  // the post-rebrand "PLEXII" string still matches.
  await waitForReady(window)

  // window.api must be exposed via the contextBridge — otherwise renderer code
  // would silently fail every IPC call. Easier to catch here than later in a
  // store-level test.
  const hasApi = await window.evaluate(() => {
    return (
      typeof (window as unknown as { api?: object }).api === 'object' &&
      (window as unknown as { api?: object }).api !== null
    )
  })
  expect(hasApi).toBe(true)
})
