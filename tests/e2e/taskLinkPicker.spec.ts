/**
 * A task-link widget you can actually point at a desk.
 *
 * Reported: "you can add it, but nothing lets you point it at a desk." True,
 * and worse — a freshly added one rendered "Referenced task was deleted or
 * moved", which was simply false: it never had a target. The only way to make
 * a working task-link was to drag a desk from the sidebar onto the canvas.
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

test('TLP-1 — an unbound task-link offers the desks, and binding one sticks', async () => {
  test.slow()
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const host = await api.nodes.create({ parentId: null, kind: 'task', title: 'Host desk' })
    const target = await api.nodes.create({ parentId: null, kind: 'task', title: 'Target desk' })
    const w = await api.widgets.create({
      taskId: (host as unknown as { id: string }).id,
      kind: 'task-link',
      title: 'Link',
      content: '', // unbound, exactly as adding one from the palette leaves it
      x: 40,
      y: 60,
      width: 300,
      height: 240
    } as never)
    return {
      host: (host as unknown as { id: string }).id,
      target: (target as unknown as { id: string }).id,
      widget: (w as unknown as { id: string }).id
    }
  })

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: 'Host desk' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })

  // The picker is there, and the false "deleted or moved" message is NOT.
  await expect(window.locator('[data-testid="task-link-picker"]')).toBeVisible({ timeout: 10_000 })
  await expect(window.getByText(/deleted or moved/)).toHaveCount(0)

  // Its own desk is not offered: pointing a desk at itself shows nothing.
  await expect(window.locator(`[data-testid="task-link-option-${ids.host}"]`)).toHaveCount(0)

  // Choose the target.
  await window.locator(`[data-testid="task-link-option-${ids.target}"]`).click()

  // It bound, and the binding is in the database rather than only on screen.
  await expect
    .poll(async () =>
      window.evaluate(async (widgetId) => {
        const api = (window as unknown as { api: typeof window.api }).api
        const w = await api.widgets.get(widgetId)
        return w?.content ?? null
      }, ids.widget)
    , { timeout: 8_000 })
    .toBe(ids.target)

  // And the widget now shows the desk rather than the picker.
  await expect(window.locator('[data-testid="task-link-picker"]')).toHaveCount(0)
})

test('TLP-2 — search narrows the list', async () => {
  test.slow()
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const host = await api.nodes.create({ parentId: null, kind: 'task', title: 'Host' })
    const alpha = await api.nodes.create({ parentId: null, kind: 'task', title: 'Alpha launch' })
    const beta = await api.nodes.create({ parentId: null, kind: 'task', title: 'Beta hiring' })
    await api.widgets.create({
      taskId: (host as unknown as { id: string }).id,
      kind: 'task-link',
      title: 'Link',
      content: '',
      x: 40,
      y: 60,
      width: 300,
      height: 240
    } as never)
    return {
      alpha: (alpha as unknown as { id: string }).id,
      beta: (beta as unknown as { id: string }).id
    }
  })

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: 'Host' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await expect(window.locator('[data-testid="task-link-search"]')).toBeVisible({ timeout: 10_000 })

  await window.locator('[data-testid="task-link-search"]').fill('hiring')
  await expect(window.locator(`[data-testid="task-link-option-${ids.beta}"]`)).toBeVisible()
  await expect(window.locator(`[data-testid="task-link-option-${ids.alpha}"]`)).toHaveCount(0)
})
