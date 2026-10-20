// E2E: with Attention off (it ships off), the places that create work items
// say so BEFORE anyone tries — not a raw "Error invoking remote method
// 'workItems:create'" after. Turning Attention on removes the notice.
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

test('AOE-1 — Capture with Attention off shows the "turn on Attention" state; on, it does not', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  const { window } = launched
  await waitForReady(window)
  expect(await window.evaluate(() => window.api.workItems.enabled())).toBe(false)

  await window.evaluate(() => window.dispatchEvent(new CustomEvent('fb:command-new-work-item')))
  const consoleEl = window.locator('[data-testid="capture-console"]')
  await expect(consoleEl).toBeVisible({ timeout: 5_000 })
  await expect(consoleEl.locator('[data-testid="attention-off-notice"]')).toBeVisible()
  await expect(consoleEl.locator('[data-testid="attention-off-notice"]')).toContainText('Turn on Attention in Settings')
  // Filing verbatim does nothing and raises no raw IPC error.
  await consoleEl.locator('[data-testid="capture-title"]').fill('Call the venue')
  await consoleEl.locator('[data-testid="capture-title"]').press('Meta+Enter')
  await expect(window.getByText(/Error invoking remote method/)).toHaveCount(0)
  await expect(consoleEl).toBeVisible()

  // Turn Attention on: the notice goes.
  await window.evaluate(async () => {
    await window.api.workItems.setEnabled(true)
    window.dispatchEvent(new Event('fb:workitems-toggled'))
  })
  await expect(consoleEl.locator('[data-testid="attention-off-notice"]')).toHaveCount(0, { timeout: 5_000 })
})
