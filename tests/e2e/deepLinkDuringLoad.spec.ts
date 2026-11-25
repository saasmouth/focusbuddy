/**
 * E2E: a link that reaches the app while its window is still loading is not
 * lost (4.3.56).
 *
 * Main kept a link for the window only when NO window existed. With the window
 * open but its page still loading, it sent the link and forgot it; nobody was
 * listening yet, Electron dropped the message, and the link did nothing. The
 * shape 1a found in PlexiiLite (1dcc8dc). Here a plexii://edit-md link arrives
 * 50 ms after the window is created, long before the page subscribes, and the
 * markdown view must still open once the app is up.
 */
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

test('a link that arrives while the window is still loading still opens', async () => {
  test.setTimeout(90_000)
  launched = await launchApp({
    beforeFirstWindow: async (app) => {
      await app.evaluate(({ app: a }) => {
        a.once('browser-window-created', () => {
          setTimeout(() => a.emit('open-url', { preventDefault: () => undefined }, 'plexii://edit-md?path=%2Ftmp%2Fplexii-link-during-load.md'), 50)
        })
      })
    }
  })
  const { window } = launched
  await waitForReady(window)
  await expect
    .poll(
      () =>
        window.evaluate(() => {
          const v = (window as unknown as { __fbView?: { getState: () => { view: { kind: string; path?: string } } } }).__fbView
          return v ? v.getState().view : null
        }),
      { message: 'the markdown view opened for the link', timeout: 15_000 }
    )
    .toMatchObject({ kind: 'mdext', path: '/tmp/plexii-link-during-load.md' })
})
