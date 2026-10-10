/**
 * The AI button is in every widget's header.
 *
 * It was on two widgets out of forty-odd, and on the table it sat in the body
 * beside the add-column plus. The shared frame draws it now, so this spec
 * checks the thing the unit test cannot: that it actually renders, on widgets
 * of different kinds, in the running app.
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('WAI-1 — widgets of several kinds each carry a header AI button', async () => {
  test.slow()
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Three kinds with different AI stories: a table (its own assistant), a
  // sticky (attachable, so the default path), and a calculator (no AI surface
  // and not attachable — the case that used to have no button at all).
  const kinds = ['table', 'sticky', 'calculator']
  await window.evaluate(async (widgetKinds) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'AI button desk' })
    let x = 40
    for (const kind of widgetKinds) {
      await api.widgets.create({
        taskId: (desk as unknown as { id: string }).id,
        kind,
        title: `${kind} widget`,
        content: '',
        x,
        y: 60,
        width: 280,
        height: 200
      } as never)
      x += 300
    }
  }, kinds)

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: 'AI button desk' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })

  // One per widget — not one for the lot, and not none.
  await expect(window.locator('[data-testid="widget-ai"]')).toHaveCount(kinds.length, {
    timeout: 10_000
  })

  // Every one of them is actually reachable, not merely present in the DOM.
  const buttons = window.locator('[data-testid="widget-ai"]')
  for (let i = 0; i < kinds.length; i++) {
    await expect(buttons.nth(i)).toBeVisible()
  }
})

test('WAI-2 — on a widget with no AI surface it opens the assistant', async () => {
  test.slow()
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Assistant open desk' })
    await api.widgets.create({
      taskId: (desk as unknown as { id: string }).id,
      kind: 'calculator',
      title: 'Sums',
      content: '',
      x: 60,
      y: 60,
      width: 280,
      height: 200
    } as never)
  })
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: 'Assistant open desk' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })

  const btn = window.locator('[data-testid="widget-ai"]').first()
  await expect(btn).toBeVisible({ timeout: 10_000 })
  await btn.click()

  // The assistant panel opens. This is the half that makes the button honest on
  // a kind with no AI of its own — the alternative was no button, which is what
  // was reported.
  await expect(window.locator('[data-testid="assistant-panel"]')).toBeVisible({ timeout: 8_000 })
})
