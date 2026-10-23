// Owner report (4.3.40): "Full view opens, but the widget's content and layout
// isn't shown, just a black modal with arrow navigation." Kinds without an
// inline variant (Tasks, Focus, Calendar, …) rendered nothing in the card.
// Full view is opened through the real widget menu.
import { test, expect } from '@playwright/test'
import { clickWidgetTool, launchApp, waitForReady, openNewDesk, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('Full view shows the work widget itself, for kinds with and without an inline body', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const taskId = await openNewDesk(window, 'Full view desk')
  const ids = await window.evaluate(async (t) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const mk = (kind: string, x: number, content = '') =>
      api.widgets.create({ taskId: t, kind: kind as never, title: `FV ${kind}`, content, x, y: 140, width: 320, height: 240 })
    const tasks = await mk('task-list', 100)
    const focus = await mk('attention', 460)
    const sticky = await mk('sticky', 820, 'STICKY-BODY')
    const w = window as unknown as { __fbWidgets?: { getState: () => { loadForTask: (id: string, o?: { refresh?: boolean }) => Promise<void> } } }
    await w.__fbWidgets?.getState().loadForTask(t, { refresh: true })
    return { tasks: tasks.id, focus: focus.id, sticky: sticky.id }
  }, taskId)

  const el = window.locator(`[data-widget-id="${ids.tasks}"]`).first()
  await expect(el).toBeVisible({ timeout: 10_000 })
  await el.hover()
  // Expand folds into the header's "…" menu on a narrow widget
  // (lib/widgetHeaderActions); clickWidgetTool presses it wherever it is.
  await clickWidgetTool(window, ids.tasks, 'Expand options')
  await window.getByText('Full view', { exact: true }).click({ force: true })

  const card = window.locator('[data-focus-card]').first()
  await expect(card).toBeVisible()
  // The Tasks widget renders inside the card, filling it.
  const body = card.locator('[data-focus-embedded-kind="task-list"]')
  await expect(body).toBeVisible({ timeout: 5_000 })
  const cardBox = (await card.boundingBox())!
  const bodyBox = (await body.boundingBox())!
  expect(bodyBox.height).toBeGreaterThan(cardBox.height * 0.6)
  await expect(body.locator(`[data-widget-id="${ids.tasks}"]`)).toBeVisible()

  // Walk to the Focus widget with the arrows: also a real body.
  await window.locator('[data-testid="focus-nav-next"]').click()
  await expect(card.locator('[data-focus-embedded-kind="attention"]')).toBeVisible({ timeout: 5_000 })

  // A kind with an inline variant is unchanged.
  await window.locator('[data-testid="focus-nav-next"]').click()
  await expect(window.locator('[data-focus-card]').first()).toContainText('STICKY-BODY', { timeout: 5_000 })
})
