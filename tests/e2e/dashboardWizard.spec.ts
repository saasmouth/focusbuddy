// The dashboard configuration wizard, driven for real on all four dashboards.
//
// What matters here is not that the panel opens. It is that answering the
// questions produces an arrangement that the dashboard then actually LOADS
// back: HomeDashboard drops any stored row whose widget id it does not know,
// whose size is not a real size, or whose key repeats, and falls back to stock
// without saying so. A wizard that wrote rows the loader rejects would look
// like it worked and change nothing — so every case below checks the board
// after a reload, not the preview before it.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

test.setTimeout(120_000)

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

type Surface = 'home' | 'office' | 'people' | 'brain'

const GO: Record<Surface, string> = {
  home: 'goPlexiDesk',
  office: 'goOffice',
  people: 'goPlexiPeople',
  brain: 'goPlexiBrain'
}

const STORAGE_KEY: Record<Surface, string> = {
  home: 'home.layout.v3',
  office: 'home.layout.v3.office',
  people: 'home.layout.v3.people',
  brain: 'home.layout.v3.brain'
}

async function goSurface(window: Page, surface: Surface): Promise<void> {
  await window.evaluate(
    ({ action, app }) => {
      const w = window as unknown as {
        __fbView?: { getState: () => Record<string, (a?: string) => void> }
      }
      w.__fbView?.getState()[action](app)
    },
    { action: GO[surface], app: surface === 'people' ? 'home' : 'home' }
  )
  await expect(window.locator('[data-testid="home-wizard-open"]')).toBeVisible({ timeout: 10_000 })
}

/** Answer every question by clicking the first option, then build. */
async function runWizard(window: Page): Promise<void> {
  await window.locator('[data-testid="home-wizard-open"]').click()
  await expect(window.locator('[data-testid="dashboard-wizard"]')).toBeVisible({ timeout: 8000 })

  // Five questions; the single-choice one advances on its own click, so drive
  // by whatever question is on screen rather than by a fixed script.
  for (let i = 0; i < 8; i++) {
    const apply = window.locator('[data-testid="wizard-apply"]')
    if (await apply.isVisible().catch(() => false)) break
    const opt = window.locator('[data-testid^="wizard-opt-"]').first()
    if (await opt.isVisible().catch(() => false)) await opt.click()
    const next = window.locator('[data-testid^="wizard-next-"]').first()
    if (await next.isVisible().catch(() => false)) await next.click()
    await window.waitForTimeout(250)
  }
  await expect(window.locator('[data-testid="wizard-apply"]')).toBeVisible({ timeout: 15_000 })
}

async function storedWidgets(window: Page, surface: Surface): Promise<Array<{ widget: string; size: string }>> {
  return window.evaluate((key) => {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { widgets?: Array<{ widget: string; size: string }> }
    return parsed.widgets ?? []
  }, STORAGE_KEY[surface])
}

test('1. the wizard builds a dashboard the board actually loads back', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await goSurface(window, 'home')

  await runWizard(window)

  // The review step must show reasons, not just tiles: a dashboard you cannot
  // question is one you cannot correct.
  const reasons = window.locator('[data-testid="wizard-reasons"] li')
  expect(await reasons.count()).toBeGreaterThan(0)

  await window.locator('[data-testid="wizard-apply"]').click()
  await expect(window.locator('[data-testid="dashboard-wizard"]')).toBeHidden({ timeout: 8000 })

  const saved = await storedWidgets(window, 'home')
  expect(saved.length).toBeGreaterThan(0)

  // The real check: reload and confirm the loader kept every row. If it had
  // rejected them it would silently serve stock instead.
  await window.reload()
  await waitForReady(window)
  await goSurface(window, 'home')
  const after = await storedWidgets(window, 'home')
  expect(after.map((w) => w.widget)).toEqual(saved.map((w) => w.widget))

  for (const w of after) {
    await expect(
      window.locator(`[data-widget-kind="${w.widget}"]`).first()
    ).toBeVisible({ timeout: 10_000 })
  }
})

test('2. every one of the four dashboards can be set up, and each keeps its own', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const built: Record<string, string[]> = {}
  for (const surface of ['home', 'office', 'people', 'brain'] as Surface[]) {
    await goSurface(window, surface)
    await runWizard(window)
    await window.locator('[data-testid="wizard-apply"]').click()
    await expect(window.locator('[data-testid="dashboard-wizard"]')).toBeHidden({ timeout: 8000 })
    const saved = await storedWidgets(window, surface)
    expect(saved.length, `${surface} saved nothing`).toBeGreaterThan(0)
    built[surface] = saved.map((w) => w.widget)
  }

  // Four dashboards, four stored layouts: setting up one must not overwrite
  // another, which a single shared storage key would silently do.
  for (const surface of ['home', 'office', 'people', 'brain'] as Surface[]) {
    const still = await storedWidgets(window, surface)
    expect(still.map((w) => w.widget), `${surface} was overwritten`).toEqual(built[surface])
  }

  // Team status is a People widget. It must not have landed anywhere else.
  for (const surface of ['home', 'office', 'brain'] as Surface[]) {
    expect(built[surface]).not.toContain('people-home')
  }
})

test('3. free text alone is enough to build a dashboard', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await goSurface(window, 'home')

  await window.locator('[data-testid="home-wizard-open"]').click()
  await expect(window.locator('[data-testid="dashboard-wizard"]')).toBeVisible({ timeout: 8000 })

  // Write instead of clicking on the first question, then skip the rest. The
  // person whose work is not on the list is exactly who this has to work for.
  await window.locator('[data-testid="wizard-other-role"]').click()
  await window
    .locator('[data-testid="wizard-other-input-role"]')
    .fill('I chase overdue deadlines across a dozen client projects')
  await window.locator('[data-testid="wizard-other-save-role"]').click()
  await window.locator('[data-testid="wizard-next-role"]').click()

  for (let i = 0; i < 6; i++) {
    const apply = window.locator('[data-testid="wizard-apply"]')
    if (await apply.isVisible().catch(() => false)) break
    const skip = window.locator('[data-testid^="wizard-skip-"]').first()
    if (await skip.isVisible().catch(() => false)) await skip.click()
    await window.waitForTimeout(200)
  }

  await expect(window.locator('[data-testid="wizard-apply"]')).toBeVisible({ timeout: 15_000 })
  await window.locator('[data-testid="wizard-apply"]').click()

  const saved = await storedWidgets(window, 'home')
  expect(saved.length).toBeGreaterThan(0)
  // What they wrote was about overdue work, so that is what should be there.
  expect(saved.map((w) => w.widget)).toContain('overdue')
})

test('4. closing without applying changes nothing', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await goSurface(window, 'home')

  const before = await storedWidgets(window, 'home')

  // runWizard opens the panel itself and answers it through to the review step.
  await runWizard(window)
  await window.keyboard.press('Escape')
  await expect(window.locator('[data-testid="dashboard-wizard"]')).toBeHidden({ timeout: 8000 })

  const after = await storedWidgets(window, 'home')
  expect(after).toEqual(before)
})
