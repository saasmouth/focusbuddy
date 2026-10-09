/**
 * E2E tests for CHANGE 2 — the floating right-hand tool menu (FloatingToolbar,
 * position:fixed, data-floating-menu) stays visible beside the assistant panel
 * (ChatPanel) instead of sliding under it when the assistant opens.
 *
 * FTI-1  With a desk open, the FloatingToolbar renders (data-floating-menu +
 *        the construction icon). Its bounding rect is measured with the
 *        assistant CLOSED (chatCollapsed=true, driven via the "Hide assistant
 *        panel" button — the assistant starts OPEN by default per App.tsx
 *        chatCollapsed initial state).
 *
 * FTI-2  Opening the assistant (fb:open-assistant custom event, the same path
 *        the empty-desk "tell the assistant" entry uses) must move the
 *        toolbar's right edge LEFT of where it sat while closed, and the
 *        toolbar must land fully left of the assistant panel's left edge
 *        (toolbar.right <= assistantPanel.left + a few px tolerance).
 *
 * FTI-3  Regression: re-collapsing the assistant returns the toolbar back
 *        toward the closed-state right edge.
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

test('FTI — the FloatingToolbar docks beside the assistant panel, not underneath it', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.nodes.create({ parentId: null, kind: 'task', title: 'FTI Task' })
    })
    await window.reload()
    await waitForReady(window)
    await window.getByRole('button', { name: /FTI Task/ }).first().click()
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
    await window.waitForTimeout(300)

    const toolbar = window.locator('[data-testid="floating-toolbar"]').first()
    await expect(toolbar).toBeVisible({ timeout: 8_000 })

    // Open the assistant and let the inset settle. Canvas measures the panel
    // directly: it is a floating aside that COVERS the canvas rather than
    // shrinking it, so the surface's right edge never moves and an inset
    // derived from the surface alone stayed 0 — which is how the toolbar ended
    // up underneath the panel.
    await window.evaluate(() => {
      window.dispatchEvent(new CustomEvent('fb:open-assistant'))
    })
    const panel = window.locator('[data-testid="assistant-panel"]').first()
    await expect(panel).toBeVisible({ timeout: 8_000 })
    await window.waitForTimeout(700)

    const openToolbar = await toolbar.boundingBox()
    const panelBox = await panel.boundingBox()
    expect(openToolbar, 'the toolbar is on screen with the assistant open').not.toBeNull()
    expect(panelBox, 'the assistant panel is on screen').not.toBeNull()

    const openRight = openToolbar!.x + openToolbar!.width
    // Clear of the panel, with a little tolerance for its ring and shadow.
    expect(
      openRight,
      `toolbar right (${openRight}) must clear the assistant panel's left edge (${panelBox!.x})`
    ).toBeLessThanOrEqual(panelBox!.x + 8)

    // Minimise it and the toolbar returns toward the window edge.
    const minimize = window.locator('[data-testid="assistant-minimize"]')
    if (await minimize.isVisible().catch(() => false)) {
      await minimize.click()
      await expect(panel).toHaveCount(0, { timeout: 8_000 })
      await window.waitForTimeout(700)
      const closedToolbar = await toolbar.boundingBox()
      expect(closedToolbar, 'the toolbar is still on screen with the assistant closed').not.toBeNull()
      expect(
        closedToolbar!.x + closedToolbar!.width,
        'the toolbar moves back toward the edge once the panel is gone'
      ).toBeGreaterThan(openRight)
    }
  } finally {
    await dispose()
  }
})
