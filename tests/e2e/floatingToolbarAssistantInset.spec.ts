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

test('FTI — FloatingToolbar stays left of the assistant panel when it opens, and returns when it closes', async () => {
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

    const toolbar = window.locator('[data-floating-menu]').first()
    await expect(toolbar).toBeVisible({ timeout: 8_000 })

    // The assistant starts OPEN (chatCollapsed=false by default in App.tsx).
    // Collapse it first so FTI-1 measures a genuine "closed" baseline.
    const hideBtn = window.getByTitle('Hide assistant panel')
    if (await hideBtn.isVisible().catch(() => false)) {
      await hideBtn.click()
      await window.waitForTimeout(400)
    }
    await expect(window.locator('[data-testid="assistant-pill"]')).toBeVisible({
      timeout: 4_000
    })

    const closedBox = await toolbar.boundingBox()
    expect(closedBox, 'toolbar must have a bounding box while assistant is closed').toBeTruthy()

    // ── FTI-2: open the assistant, confirm the toolbar moves left ───────────
    await window.evaluate(() => {
      window.dispatchEvent(new CustomEvent('fb:open-assistant'))
    })
    // Panel resize animation + ResizeObserver-driven toolbarRightInset settle.
    await window.waitForTimeout(700)

    // The "Show assistant panel" button disappears once the panel is expanded.
    await expect(window.locator('[data-testid="assistant-pill"]')).toHaveCount(0, {
      timeout: 4_000
    })

    // Stable testid rather than a class selector: the assistant adopted the
    // shared floating-card chrome (rounded card, hairline all round) and no
    // longer carries fb-glass-chrome / border-l.
    const assistantPanel = window.locator('[data-testid="assistant-panel"]').first()
    await expect(assistantPanel).toBeVisible({ timeout: 4_000 })
    const assistantBox = await assistantPanel.boundingBox()
    expect(assistantBox, 'assistant panel must have a bounding box while open').toBeTruthy()

    const openBox = await toolbar.boundingBox()
    expect(openBox, 'toolbar must still have a bounding box while assistant is open').toBeTruthy()

    // The toolbar's right edge must have moved left of the closed-state edge —
    // i.e. it is no longer docked at the bare viewport edge.
    expect(
      openBox!.x + openBox!.width,
      `toolbar right edge should move left when the assistant opens (closed right=${
        closedBox!.x + closedBox!.width
      }, open right=${openBox!.x + openBox!.width})`
    ).toBeLessThan(closedBox!.x + closedBox!.width - 5)

    // The toolbar must sit fully left of (or touching) the assistant panel's
    // left edge — not hidden underneath it. Small tolerance for shadow/ring.
    expect(
      openBox!.x + openBox!.width,
      `toolbar right (${openBox!.x + openBox!.width}) must be <= assistant panel left (${
        assistantBox!.x
      }) + tolerance`
    ).toBeLessThanOrEqual(assistantBox!.x + 4)

    // ── FTI-3: regression — closing the assistant returns the toolbar right ──
    const hideBtn2 = window.getByTitle('Hide assistant panel')
    await hideBtn2.click()
    await window.waitForTimeout(700)
    await expect(window.locator('[data-testid="assistant-pill"]')).toBeVisible({
      timeout: 4_000
    })

    const reclosedBox = await toolbar.boundingBox()
    expect(reclosedBox, 'toolbar must have a bounding box after re-closing the assistant').toBeTruthy()
    expect(
      reclosedBox!.x + reclosedBox!.width,
      'toolbar right edge should move back right after the assistant closes'
    ).toBeGreaterThan(openBox!.x + openBox!.width + 5)
  } finally {
    await dispose()
  }
})
