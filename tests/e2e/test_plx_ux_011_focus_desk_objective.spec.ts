// DEC-144: Attention is Focus, the widget's "Focus mode" is "Full view", the Desks app is "All desks".
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// PLX-UX-011 — the desk's current objective must be retrievable in ONE
// interaction (a hover) from the full-screen widget focus view. The
// focus-desk-identity chip (PLX-UX-010) carries a `title` attribute of the
// form "Objective: <description>" whenever the desk has a description, so
// hovering it — the single interaction — surfaces the objective via the
// browser's native title tooltip. We assert the underlying attribute value
// directly (a title-attribute tooltip is OS chrome, not part of the DOM a
// screenshot/accessibility tree exposes reliably in headless Chromium), which
// is the deterministic way to prove the one-hover affordance is wired
// correctly, and additionally drive a real `hover()` to prove the element is
// actually reachable/hoverable in the live layout.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openDesk(window: LaunchedApp['window'], title: string): Promise<void> {
  await window.getByRole('button', { name: title }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForTimeout(500)
}

async function openFocusModeOn(window: LaunchedApp['window'], widgetId: string): Promise<void> {
  const widgetEl = window.locator(`[data-widget-id="${widgetId}"]`).first()
  await expect(widgetEl).toBeVisible({ timeout: 5_000 })
  await widgetEl.hover()
  const expandBtn = widgetEl.locator('button[aria-label="Expand options"]')
  await expect(expandBtn).toBeVisible({ timeout: 5_000 })
  await expandBtn.click({ force: true })
  const focusModeOption = window.getByText('Full view', { exact: true })
  await expect(focusModeOption).toBeVisible({ timeout: 3_000 })
  await focusModeOption.click({ force: true })
}

test('test_plx_ux_011_objective_reachable_in_one_hover_when_description_set', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskTitle = 'UX-011 objective desk'
  const objective = 'Ship the Q3 onboarding revamp'
  const { widgetAId } = await window.evaluate(
    async ({ title, desc }: { title: string; desc: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const task = await api.nodes.create({ parentId: null, kind: 'task', title, description: desc })
      const a = await api.widgets.create({
        taskId: task.id, kind: 'sticky', title: 'Widget A', content: 'WIDGET-A',
        x: 160, y: 160, width: 220, height: 180
      })
      return { widgetAId: a.id }
    },
    { title: deskTitle, desc: objective }
  )

  await window.reload()
  await waitForReady(window)
  await openDesk(window, deskTitle)
  await openFocusModeOn(window, widgetAId)

  const overlay = window.locator('[data-testid="widget-focus-mode"]')
  await expect(overlay).toBeVisible({ timeout: 5_000 })

  const identity = overlay.locator('[data-testid="focus-desk-identity"]')
  await expect(identity).toBeVisible({ timeout: 4_000 })

  // One interaction (hover) surfaces the objective — assert the underlying
  // title attribute carries it in the documented "Objective: ..." form, and
  // that the element genuinely responds to a real hover (is in the live
  // layout, not detached/hidden behind something).
  await identity.hover()
  const titleAttr = await identity.getAttribute('title')
  expect(titleAttr).toBe(`Objective: ${objective}`)

  console.log('Objective retrievable via one-hover title attribute:', titleAttr)
})

test('test_plx_ux_011_falls_back_to_desk_title_when_no_objective_set', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskTitle = 'UX-011 no-objective desk'
  const { widgetAId } = await window.evaluate(async (title: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title })
    const a = await api.widgets.create({
      taskId: task.id, kind: 'sticky', title: 'Widget A', content: 'WIDGET-A',
      x: 160, y: 160, width: 220, height: 180
    })
    return { widgetAId: a.id }
  }, deskTitle)

  await window.reload()
  await waitForReady(window)
  await openDesk(window, deskTitle)
  await openFocusModeOn(window, widgetAId)

  const overlay = window.locator('[data-testid="widget-focus-mode"]')
  await expect(overlay).toBeVisible({ timeout: 5_000 })

  const identity = overlay.locator('[data-testid="focus-desk-identity"]')
  await expect(identity).toBeVisible({ timeout: 4_000 })

  const titleAttr = await identity.getAttribute('title')
  // No description on this desk -> no fabricated objective text; the title
  // attribute honestly falls back to the desk title instead of claiming an
  // objective that doesn't exist.
  expect(titleAttr).toBe(deskTitle)
  expect(titleAttr).not.toMatch(/^Objective:/)

  console.log('No-objective desk title attribute honestly falls back to desk title:', titleAttr)
})
