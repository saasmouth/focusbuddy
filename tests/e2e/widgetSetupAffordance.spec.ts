import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// The proactive "Set up with AI" affordance shows on an EMPTY widget the setup
// assistant supports and opens the shared setup preview. The AI call itself
// needs an API key (absent in tests), so we assert the affordance → modal
// wiring, not the drafted output.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedPage(l: LaunchedApp, content: string): Promise<string> {
  const { window } = l
  await waitForReady(window)
  const r = await window.evaluate(async (content: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const t = await api.nodes.create({ parentId: null, kind: 'task', title: 'SetupAffordanceTest' })
    const w = await api.widgets.create({
      taskId: t.id,
      kind: 'page',
      title: '',
      content,
      x: 160,
      y: 160,
      width: 360,
      height: 280
    })
    return w.id
  }, content)
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /SetupAffordanceTest/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8000 })
  return r
}

test('WSA-1 — an empty page shows "Set up with AI" and it opens the setup preview', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const widgetId = await seedPage(launched, '')
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 8000 })

  const chip = window.getByRole('button', { name: /Set up with AI/ })
  await expect(chip).toBeVisible({ timeout: 6000 })
  await chip.click()

  // The shared setup preview opens with the "Set up with AI" header.
  const modal = window.locator('[data-testid="widget-setup-preview"]')
  await expect(modal).toBeVisible({ timeout: 4000 })
  await expect(modal).toContainText('Set up with AI')

  // Close it.
  await window.keyboard.press('Escape').catch(() => {})
  await window.locator('[data-testid="widget-setup-preview"] button[aria-label="Close"]').click().catch(() => {})
})

test('WSA-2 — a page with real content does NOT show the affordance', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const doc =
    '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Plan"}]}]}'
  const widgetId = await seedPage(launched, doc)
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 8000 })
  await window.waitForTimeout(500)
  await expect(window.getByRole('button', { name: /Set up with AI/ })).toHaveCount(0)
})
