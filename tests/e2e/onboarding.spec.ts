import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// First-run onboarding. It must appear for a genuinely fresh install, be fully
// skippable, set a flag so it never returns, and be grandfathered away for an
// existing user (one who already has data). The API-key success path makes a
// real model call, so it's left to manual use; here we drive the deterministic
// structural flow.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

const onboarding = (l: LaunchedApp) =>
  l.window.locator('[role="dialog"][aria-label="Welcome to PlexiiDesk"]')

const nodeTitles = (l: LaunchedApp): Promise<string[]> =>
  l.window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.nodes.list()).map((n) => n.title)
  })

test('ONB-1 — a fresh install sees onboarding, can skip through, and it never returns', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window, { dismissModals: false })

  // Fresh DB, no key → onboarding shows.
  await expect(onboarding(launched)).toBeVisible({ timeout: 8000 })

  // Welcome → skip the key → tour → start blank.
  await window.getByRole('button', { name: 'Get started' }).click()
  await window.locator('[data-testid="onboarding-key-skip"]').click()
  await expect(window.locator('[data-testid="onboarding-tour"]')).toBeVisible()
  await window.locator('[data-testid="onboarding-tour-continue"]').click()
  await window.locator('[data-testid="onboarding-start-blank"]').click()

  // Dismissed, and the flag persists across a reload.
  await expect(onboarding(launched)).toHaveCount(0, { timeout: 4000 })
  await window.reload()
  await waitForReady(window, { dismissModals: false })
  await window.waitForTimeout(800)
  await expect(onboarding(launched)).toHaveCount(0)
})

test('ONB-2 — chosen starter creates a real template-backed workspace and closes onboarding', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window, { dismissModals: false })
  await expect(onboarding(launched)).toBeVisible({ timeout: 8000 })

  await window.getByRole('button', { name: 'Get started' }).click()
  await window.locator('[data-testid="onboarding-key-skip"]').click()
  await window.locator('[data-testid="onboarding-tour-continue"]').click()
  await expect(window.getByRole('button', { name: 'Focus today' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await window.locator('[data-testid="onboarding-create-starter"]').click()

  await expect(onboarding(launched)).toHaveCount(0, { timeout: 6000 })
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const nodes = await api.nodes.list()
    const desk = nodes.find((node) => node.title === 'Start here — Daily Focus')
    const widgets = desk ? await api.widgets.listByTask(desk.id) : []
    return { titles: nodes.map((node) => node.title), widgetCount: widgets.length }
  })
  expect(seeded.titles).toContain('Daily Focus')
  expect(seeded.titles).toContain('Start here — Daily Focus')
  expect(seeded.widgetCount).toBeGreaterThan(0)
})

test('ONB-3 — an existing user (already has data) is grandfathered and never sees onboarding', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window, { dismissModals: false })
  // Fresh install shows it first…
  await expect(onboarding(launched)).toBeVisible({ timeout: 8000 })

  // …seed data, then relaunch the renderer. The gate now sees existing nodes and
  // marks onboarding done without showing it.
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'folder', title: 'Existing work' })
  })
  await window.reload()
  await waitForReady(window, { dismissModals: false })
  await window.waitForTimeout(800)
  await expect(onboarding(launched)).toHaveCount(0)
})

test('ONB-4 — a feature tour replays from the hub, navigates the app, completes and is remembered', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window, { dismissModals: false })
  // Dismiss the fresh-install core flow so we can drive a feature tour.
  if (await onboarding(launched).isVisible().catch(() => false)) {
    await window.getByRole('button', { name: 'Get started' }).click()
    await window.locator('[data-testid="onboarding-key-skip"]').click()
    await window.locator('[data-testid="onboarding-tour-continue"]').click()
    await window.locator('[data-testid="onboarding-start-blank"]').click()
    await expect(onboarding(launched)).toHaveCount(0, { timeout: 4000 })
  }
  // Clear the launch sign-in modal (continue without account) so it does not sit
  // over the hub in the test environment.
  await waitForReady(window)

  // The onboarding record IPC exists (feeds the admin per-user record).
  const hasRecord = await window.evaluate(
    () => typeof (window as unknown as { api?: { onboarding?: { record?: unknown } } }).api?.onboarding?.record === 'function'
  )
  expect(hasRecord).toBe(true)

  // Open the tour hub (same event the command palette / Settings fire).
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('fb:onboarding-hub')))
  const hub = window.locator('[data-testid="onboarding-hub"]')
  await expect(hub).toBeVisible({ timeout: 5000 })
  await hub.locator('[data-testid="onboarding-hub-start-rooms-desks"]').click()

  const tour = window.locator('[data-testid="onboarding-step-tour"]')
  await expect(tour).toBeVisible({ timeout: 5000 })
  // Step 1 navigates to All rooms.
  await expect(window.locator('[data-testid="rooms-index-view"]')).toBeVisible({ timeout: 6000 })
  await tour.locator('[data-testid="onboarding-tour-next"]').click()
  await expect(window.locator('[data-testid="desks-index-view"]')).toBeVisible({ timeout: 6000 })
  await tour.locator('[data-testid="onboarding-tour-next"]').click() // -> plans
  await tour.locator('[data-testid="onboarding-tour-next"]').click() // Done
  await expect(tour).toHaveCount(0, { timeout: 5000 })

  // Remembered: reopen the hub and the module shows Done.
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('fb:onboarding-hub')))
  await expect(hub).toBeVisible({ timeout: 5000 })
  await expect(hub.locator('[data-testid="onboarding-hub-start-rooms-desks"]')).toContainText('Done')
  const persisted = await window.evaluate(() => localStorage.getItem('fb.onboarding.v2'))
  expect(persisted).toContain('rooms-desks')
})
