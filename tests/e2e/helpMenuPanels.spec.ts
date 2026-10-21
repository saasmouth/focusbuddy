import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Help → What's New and Help → Terms of Use live in the macOS menu bar. Each
// click sends an event to the window, and the footer, which owns both panels,
// opens the matching one. From the move to the menu bar (Sept 2026) until
// 4.3.41 the renderer never subscribed, so both items did nothing; this drives
// the real menu items rather than the IPC channel, so a menu that stops sending
// fails here too.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function clickHelpItem(app: LaunchedApp['app'], label: string): Promise<boolean> {
  return app.evaluate(({ Menu, BrowserWindow }, wanted) => {
    const help = Menu.getApplicationMenu()?.items.find((i) => i.role === 'help')
    const item = help?.submenu?.items.find((i) => i.label === wanted)
    if (!item) return false
    item.click(undefined, BrowserWindow.getAllWindows()[0], undefined as never)
    return true
  }, label)
}

test("HMP-1 — Help → What's New opens the release notes panel", async () => {
  launched = await launchApp()
  const { app, window } = launched
  await waitForReady(window)

  const heading = window.getByRole('heading', { name: "What's new in PlexiiDesk" })
  await expect(heading).toHaveCount(0)
  expect(await clickHelpItem(app, "What's New")).toBe(true)
  await expect(heading).toBeVisible({ timeout: 5_000 })
})

test('HMP-2 — Help → Terms of Use opens the terms panel', async () => {
  launched = await launchApp()
  const { app, window } = launched
  await waitForReady(window)

  const heading = window.getByRole('heading', { name: 'Terms of Use' })
  await expect(heading).toHaveCount(0)
  expect(await clickHelpItem(app, 'Terms of Use')).toBe(true)
  await expect(heading).toBeVisible({ timeout: 5_000 })
})
