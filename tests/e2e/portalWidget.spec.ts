import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Portal: a live window into another task's desk. Pick a desk, see a miniature
// of its real content, and click to dive into it.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function hideAssistant(window: LaunchedApp['window']): Promise<void> {
  const btn = window.getByRole('button', { name: 'Hide assistant panel' })
  if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {})
  await window.waitForTimeout(150)
}

test('portal previews another desk and dives into it', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const deskOne = await api.nodes.create({ parentId: null, kind: 'task', title: 'Desk One' })
    await api.widgets.create({
      taskId: deskOne.id,
      kind: 'sticky',
      title: 'note',
      content: 'PORTAL-TARGET-CONTENT',
      x: 160,
      y: 160,
      width: 220,
      height: 180
    })
    const deskTwo = await api.nodes.create({ parentId: null, kind: 'task', title: 'Desk Two' })
    await api.widgets.create({
      taskId: deskTwo.id,
      kind: 'portal',
      title: 'Portal',
      content: '',
      x: 150,
      y: 150,
      width: 300,
      height: 240
    })
    return { deskOneId: deskOne.id, deskTwoId: deskTwo.id }
  })

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Desk Two/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(400)
  await hideAssistant(window)

  // Unconfigured portal shows the desk picker listing the OTHER task.
  await expect(window.locator('[data-testid="portal-widget"]')).toBeVisible()
  await window.locator(`[data-testid="portal-pick-task-${ids.deskOneId}"]`).click()

  // It now previews Desk One — title + the real content of its sticky.
  await expect(window.locator('[data-testid="portal-title"]')).toContainText('Desk One')
  await expect(window.locator('[data-testid="portal-widget"]')).toContainText(
    'PORTAL-TARGET-CONTENT',
    { timeout: 5_000 }
  )

  // Diving in switches the canvas to Desk One.
  await window.locator('[data-testid="portal-open"]').click()
  // The desk's name is on the desk context trigger since 4148318a (no breadcrumb).
  await expect(window.locator('[data-testid="desk-context-trigger"]')).toContainText('Desk One', {
    timeout: 5_000
  })
})
