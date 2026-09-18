// Opening an app inside a segment is navigation.
//
// It was a useState, in the shell behind PlexiDesk, PlexiPeople and PlexiBrain
// — twenty-four apps. Nothing outside that component could tell what you had
// open, so: nothing reached the tray, Back did nothing inside a segment, and a
// reload dropped you on the segment's home having lost where you were.
//
// Driven through the real sidebar buttons, because the bug lived exactly in
// what those buttons did.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

test.setTimeout(240_000)
let launched: LaunchedApp | null = null
test.afterEach(async () => { if (launched) { await launched.dispose(); launched = null } })

const view = (window: Page): Promise<{ kind: string; app?: string }> =>
  window.evaluate(() => (window as any).__fbView.getState().view)

const trayKeys = (window: Page): Promise<string[]> =>
  window.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="tray-item-"]')].map((n) =>
      (n.getAttribute('data-testid') || '').replace('tray-item-', '')
    )
  )

// One representative app per segment — a real one, not the hub.
const CASES = [
  { kind: 'plexidesk', go: 'goPlexiDesk', app: 'plans', label: 'Plans' },
  { kind: 'plexipeople', go: 'goPlexiPeople', app: 'directory', label: 'Directory' },
  { kind: 'plexibrain', go: 'goPlexiBrain', app: 'decisions', label: 'Decisions' }
] as const

for (const c of CASES) {
  test(`${c.kind}: clicking an app navigates, trays and comes back`, async () => {
    launched = await launchApp()
    const { window } = launched
    await waitForReady(window)

    await window.evaluate((go) => (window as any).__fbView.getState()[go](), c.go)
    await expect(window.locator('[data-testid="segment-sidebar"]')).toBeVisible()

    // The click the user makes.
    await window.locator(`[data-testid="segment-app-${c.app}"]`).click()

    // 1. It is navigation: the view store knows.
    await expect.poll(() => view(window), { timeout: 10_000 }).toMatchObject({
      kind: c.kind,
      app: c.app
    })

    // 2. So the tray can list it.
    await expect
      .poll(() => trayKeys(window), { timeout: 10_000, message: 'the open app should be listed' })
      .toContain(`${c.kind}:${c.app}`)

    // ...under its own name, not its raw key.
    await expect(
      window.locator(`[data-testid="tray-item-${c.kind}:${c.app}"]`)
    ).toContainText(c.label)

    // 3. And Back returns to where you were, which did nothing before.
    await window.evaluate(() => (window as any).__fbView.getState().back())
    await expect.poll(() => view(window), { timeout: 10_000 }).not.toMatchObject({ app: c.app })
  })
}

test('a segment hub stays out of the tray', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await window.evaluate(() => (window as any).__fbView.getState().goPlexiBrain())
  await expect(window.locator('[data-testid="segment-sidebar"]')).toBeVisible()
  await window.waitForTimeout(600)

  // The hub is a place you go, not a thing you have open. Listing all four
  // would make the tray a second navigation bar.
  const keys = await trayKeys(window)
  expect(keys.filter((k) => k.startsWith('plexibrain:'))).toEqual([])
})

test('the app you had open survives a reload', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await window.evaluate(() => (window as any).__fbView.getState().goPlexiBrain())
  await window.locator('[data-testid="segment-app-flows"]').click()
  await expect.poll(() => view(window), { timeout: 10_000 }).toMatchObject({
    kind: 'plexibrain',
    app: 'flows'
  })

  // Local state could not be persisted, so a reload always lost it.
  await window.reload()
  await waitForReady(window)
  await expect
    .poll(() => view(window), { timeout: 15_000, message: 'a reload should not lose where you were' })
    .toMatchObject({ kind: 'plexibrain', app: 'flows' })
})
