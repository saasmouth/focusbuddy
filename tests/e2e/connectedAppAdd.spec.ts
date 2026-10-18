import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// "Clicking on adding a new connected app shut down the application."
//
// An app that EXITS is a main-process death, not a renderer error — a renderer
// crash paints a white page and leaves the window up. So this test watches for
// the process going away as much as for a thrown error, and it waits past the
// start-up repair pass before clicking, because that runs on a timer and a
// crash landing in the same second would otherwise look like the click's
// fault.

let launched: LaunchedApp | null = null

/**
 * Seed real connected apps.
 *
 * Without this every assertion below is vacuously green: a fresh profile has
 * no connected apps, so "the list is not duplicated" and "the badge renders"
 * both pass by rendering nothing at all.
 */
async function seedApps(window: LaunchedApp['window']): Promise<string[]> {
  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const made: string[] = []
    for (const [title, url] of [
      ['Seeded Mail', 'https://mail.example.com/'],
      ['Seeded Chat', 'https://chat.example.com/'],
      ['Seeded Docs', 'https://docs.example.com/']
    ]) {
      const a = await api.connectedApps.create({ title, url, notifications: true })
      if (a?.id) made.push(a.id)
    }
    return made
  })
  await window.reload()
  await waitForReady(window)
  return ids
}

/**
 * Expand the Connected apps section only if it is currently collapsed. (It was
 * the tail of the Apps section until 4.3.32, when Work widgets moved between
 * the two and connected apps became a section of their own.)
 */
async function expandApps(window: LaunchedApp['window']): Promise<void> {
  const toggle = window.locator('[data-testid="nav-section-connected"]')
  if ((await toggle.count()) === 0) return
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
}

test.afterEach(async () => {
  await launched?.app.close().catch(() => {})
  launched = null
})

test('opening the Add Connected App dialog does not kill the app', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)

  const crashes: string[] = []
  window.on('crash', () => crashes.push('renderer crashed'))
  window.on('pageerror', (e) => crashes.push(`pageerror: ${e.message}`))
  let exited = false
  app.process().on('exit', () => {
    exited = true
  })

  // Past the title backfill's 12s timer, so a main-process death from that
  // cannot be mistaken for the click's doing.
  await window.waitForTimeout(15_000)
  expect(exited, 'app died during start-up, before any click').toBe(false)

  // Make sure the Apps section is EXPANDED. Sections default to open, so an
  // unconditional click collapses it — which is what made the first run of
  // this test fail for the wrong reason.
  await expandApps(window)
  const add = window.locator('[data-testid="nav-add-connected-app"]')
  await expect(add).toBeVisible({ timeout: 10_000 })
  await add.click()

  // The dialog opens and the app is still alive.
  await expect(window.locator('text=Add a Connected App')).toBeVisible({ timeout: 10_000 })
  expect(exited, 'app exited when the dialog opened').toBe(false)
  expect(crashes, crashes.join(' | ')).toEqual([])
})

test('the connected-app list is not rendered twice in the menu', async () => {
  // "The connected app is duplicated in the menu. Remove the lower list
  // version, keep the grid version."
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const seeded = await seedApps(window)
  expect(seeded.length, 'seeding failed — the test would be vacuous').toBe(3)
  await expandApps(window)

  // Every connected app must appear at most ONCE in the menu tree.
  const ids = await window.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[data-testid^="nav-connected-app-"]'))
    return nodes.map((n) => n.getAttribute('data-testid') || '')
  })
  const seen = new Map<string, number>()
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1)
  const dupes = [...seen.entries()].filter(([, n]) => n > 1)
  expect(dupes, `duplicated rows: ${JSON.stringify(dupes)}`).toEqual([])
  // And they ARE rendered — the grid, once each.
  expect(ids.length, 'the grid rendered no apps at all').toBe(3)
})

test('each connected app shows its awake/asleep state in the menu', async () => {
  // "Make sure notifications are showing." The badge only appears at a
  // non-zero count, but the sun/moon must be there whenever an app is
  // watched — "nothing new" and "we cannot see" are different answers.
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const seeded = await seedApps(window)
  expect(seeded.length).toBe(3)
  await expandApps(window)

  const liveness = window.locator('[data-testid="nav-liveness"]')
  await expect(liveness.first()).toBeVisible({ timeout: 15_000 })
  expect(await liveness.count(), 'every watched app needs a state mark').toBe(3)
})
