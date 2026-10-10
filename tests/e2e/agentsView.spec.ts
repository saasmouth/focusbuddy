/**
 * PlexiBrain Agents view lists real desk agents (agent widgets) from across the
 * workspace via the real widgets.listByKind query, and shows an honest empty
 * state when there are none.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, switchArea } from './_helpers'

async function openAgents(window: Page): Promise<void> {
  const exit = window.locator('[data-testid="segment-exit"]')
  if (await exit.isVisible().catch(() => false)) await exit.click()
  await switchArea(window, 'plexibrain')
  await window.locator('[data-testid="segment-app-agents"]').click()
  await expect(window.locator('[data-testid="agents-view"]')).toBeVisible({ timeout: 8_000 })
}

test('AV-1 a workspace with no agents shows the honest empty state', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openAgents(window)
    await expect(window.locator('[data-testid="agents-empty"]')).toBeVisible({ timeout: 8_000 })
  } finally {
    await dispose()
  }
})

test('AV-2 a real agent widget is listed with its desk and links to it', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    const id = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Agent Desk' })
      const w = await api.widgets.create({
        taskId: task.id,
        kind: 'agent',
        title: 'Daily Digest',
        content: '',
        x: 40,
        y: 40
      })
      return w.id
    })
    await openAgents(window)
    const row = window.locator(`[data-testid="agent-row-${id}"]`)
    await expect(row).toBeVisible({ timeout: 8_000 })
    await expect(row).toContainText('Daily Digest')
    await expect(row).toContainText('Agent Desk')
    // Clicking the row opens the desk the agent lives on.
    await row.click()
    await expect(window.locator('[data-testid="agents-view"]')).toHaveCount(0, { timeout: 8_000 })
  } finally {
    await dispose()
  }
})
