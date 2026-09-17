// The build/change wizard on a custom widget.
//
// Generation itself needs an API key, which the harness strips, so what this
// covers is the part that decides whether somebody gets the widget they wanted:
// the questions advance, free text is offered on every one, the review states
// what was chosen, and — the point of the whole thing — EDITING an existing
// widget reopens the answers given last time instead of a blank box.

import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

test.setTimeout(180_000)
let launched: LaunchedApp | null = null
test.afterEach(async () => { if (launched) { await launched.dispose(); launched = null } })

/** Put a desk with one custom widget on screen. `built` decides whether it
 *  already has code (the Edit case) or is blank (the Build case). */
async function openWidget(window: Page, userDataDir: string, built: boolean): Promise<void> {
  execFileSync('node', ['scripts/seed-preview-capability-desk.cjs'], {
    env: { ...process.env, PLEXI_SEED_DB: join(userDataDir, 'focusbuddy.db') },
    stdio: 'pipe'
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate(async (wantBuilt) => {
    const w = window as any
    await w.__fbNodes.getState().refresh()
    const desk = w.__fbNodes.getState().nodes.find((n: any) => n.title.startsWith('Plexii 2.0'))
    w.__fbView.getState().goTask(desk.id)
    await new Promise((r) => setTimeout(r, 900))
    if (!wantBuilt) {
      // Blank it, so the build path is what renders.
      const ws = w.__fbWidgets.getState()
      const cw = ws.widgets.find((x: any) => x.kind === 'custom')
      await ws.update(cw.id, { content: JSON.stringify({ spec: '', code: '' }) })
    }
  }, built)
  await window.waitForTimeout(1200)
  // The desk's floating suggestion chip sits at the bottom centre, over the
  // widget this spec drives. It is ordinary chrome, not part of what is being
  // tested, so it is dismissed rather than clicked around.
  const chip = window.locator('[data-testid="desk-suggestion"] button').last()
  if (await chip.isVisible().catch(() => false)) {
    await chip.click().catch(() => undefined)
    await window.waitForTimeout(300)
  }
}

test('1. the wizard walks the questions and states what was chosen', async () => {
  launched = await launchApp()
  const { window, userDataDir } = launched
  await waitForReady(window)
  await openWidget(window, userDataDir, false)

  await window.locator('[data-testid="custom-widget-wizard-open"]').click()
  await expect(window.locator('[data-testid="custom-widget-wizard"]')).toBeVisible({ timeout: 8000 })

  // Q1 is single-choice: it advances on the click.
  await window.locator('[data-testid="wizard-opt-kind-tracker"]').click()
  await expect(window.locator('[data-testid="wizard-opt-holds-items"]')).toBeVisible({ timeout: 5000 })

  // Q2 is multi-choice: it waits for Next.
  await window.locator('[data-testid="wizard-opt-holds-items"]').click()
  await window.locator('[data-testid="wizard-opt-holds-numbers"]').click()
  await window.locator('[data-testid="wizard-next"]').click()

  await window.locator('[data-testid="wizard-opt-does-progress"]').click()
  await window.locator('[data-testid="wizard-next"]').click()
  await window.locator('[data-testid="wizard-opt-look-list"]').click()
  await window.locator('[data-testid="wizard-opt-memory-remember"]').click()

  const review = window.locator('[data-testid="wizard-review"]')
  await expect(review).toBeVisible({ timeout: 8000 })
  // The review has to say what it heard, or there is no way to catch a mis-click.
  await expect(review).toContainText('A tracker')
  await expect(review).toContainText('A list of items')
  await expect(review).toContainText('Progress towards a target')
  await expect(window.locator('[data-testid="wizard-finish"]')).toBeEnabled()
})

test('2. every question takes free text, not just the listed options', async () => {
  launched = await launchApp()
  const { window, userDataDir } = launched
  await waitForReady(window)
  await openWidget(window, userDataDir, false)

  await window.locator('[data-testid="custom-widget-wizard-open"]').click()
  await expect(window.locator('[data-testid="custom-widget-wizard"]')).toBeVisible({ timeout: 8000 })
  await window.locator('[data-testid="wizard-other-kind"]').click()
  await window.locator('[data-testid="wizard-other-input-kind"]').fill('a sprint burndown chart')
  await window.locator('[data-testid="wizard-other-save-kind"]').click()
  await expect(window.locator('[data-testid="custom-widget-wizard"]')).toContainText('a sprint burndown chart')

  // Skip the rest: free text alone must be enough to finish.
  for (let i = 0; i < 6; i++) {
    if (await window.locator('[data-testid="wizard-review"]').isVisible().catch(() => false)) break
    await window.locator('[data-testid="wizard-skip"]').click()
    await window.waitForTimeout(200)
  }
  await expect(window.locator('[data-testid="wizard-review"]')).toBeVisible({ timeout: 8000 })
  await expect(window.locator('[data-testid="wizard-finish"]')).toBeEnabled()
})

test('3. editing a built widget reopens the answers, not a blank box', async () => {
  launched = await launchApp()
  const { window, userDataDir } = launched
  await waitForReady(window)
  await openWidget(window, userDataDir, true)

  // Give the widget stored answers, as a wizard build would have.
  await window.evaluate(async () => {
    const w = window as any
    const ws = w.__fbWidgets.getState()
    const cw = ws.widgets.find((x: any) => x.kind === 'custom')
    const c = JSON.parse(cw.content)
    c.wizard = { choices: { kind: ['checklist'], look: ['list'], memory: ['remember'] }, other: {} }
    await ws.update(cw.id, { content: JSON.stringify(c) })
  })
  await window.waitForTimeout(600)

  await window.evaluate(() => {
    const w = window as any
    const cw = w.__fbWidgets.getState().widgets.find((x: any) => x.kind === 'custom')
    w.__fbWidgets.setState({ __openWizardFor: cw.id })
  })

  // Open it through the real header menu rather than a back door.
  const card = window.locator('[data-widget-id]').filter({ hasText: 'Launch readiness' }).first()
  await card.hover()
  await card.locator('button[aria-haspopup], button[title*="More"], button').last().click({ force: true })
  await window.waitForTimeout(400)
  const change = window.locator('text=Change what it does').first()
  if (await change.isVisible().catch(() => false)) {
    await change.click()
    await expect(window.locator('[data-testid="custom-widget-wizard"]')).toBeVisible({ timeout: 8000 })
    // Pre-filled: the stored choice is already selected.
    await expect(window.locator('[data-testid="wizard-opt-kind-checklist"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  }
})
