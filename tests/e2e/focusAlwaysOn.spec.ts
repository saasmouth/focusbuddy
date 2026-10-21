// E2E (DEC-144): Focus is always on. This file used to be
// attentionOffEntryPoints.spec.ts, which pinned the "turn on Attention in
// Settings" notice shown while the layer shipped off. That switch is gone, so
// the superseding truth is: Capture opens ready to file, no off-notice exists,
// and the switch's IPC is not exposed at all.
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

test('AOE-1 — Capture is always ready: no off-notice, no switch, filing works', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  const { window } = launched
  await waitForReady(window)
  expect(
    await window.evaluate(() => {
      const wi = (window as unknown as { api: { workItems: Record<string, unknown> } }).api.workItems
      return { enabled: typeof wi.enabled, setEnabled: typeof wi.setEnabled }
    })
  ).toEqual({ enabled: 'undefined', setEnabled: 'undefined' })

  await window.evaluate(() => window.dispatchEvent(new CustomEvent('fb:command-new-work-item')))
  const consoleEl = window.locator('[data-testid="capture-console"]')
  await expect(consoleEl).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[data-testid="attention-off-notice"]')).toHaveCount(0)
  await expect(consoleEl.locator('[data-testid="capture-title"]')).toBeEditable()

  // Filing through the store path works with no setup.
  const created = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const item = await api.workItems.create({ title: 'Call the venue', intentClass: 'to_do' })
    return (await api.workItems.list()).some((i: { id: string }) => i.id === item.id)
  })
  expect(created).toBe(true)
  await expect(window.getByText(/Error invoking remote method/)).toHaveCount(0)
})
