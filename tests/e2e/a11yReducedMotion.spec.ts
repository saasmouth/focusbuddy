import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, gotoView, type LaunchedApp } from './_helpers'

// PLX-A11Y-005 — "The platform MUST honour `prefers-reduced-motion`... suppress
// non-essential animation."
//
// CursorSpotlight (mounted once at the app root, on every view) is a clean,
// deterministic probe: its effect bails out entirely — no rAF loop, no
// listeners — the instant `matchMedia('(prefers-reduced-motion: reduce)').matches`
// is true (src/renderer/src/components/CursorSpotlight.tsx). So with reduced
// motion emulated, moving the mouse a lot must leave its halo elements at
// opacity 0 the whole time. As a control, the SAME sequence WITHOUT reduced
// motion must move that opacity off 0 — proving the assertion is actually
// exercising the animation, not a coincidentally-static element.
//
// Also verifies the requirement's second half — "the app still functions" —
// by driving real navigation (Home -> open a desk) with reduced motion on.

async function spotlightOpacities(window: import('@playwright/test').Page): Promise<string[]> {
  return window.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('div[aria-hidden]')).filter((el) => {
      const cs = getComputedStyle(el)
      return cs.position === 'fixed' && cs.pointerEvents === 'none' && cs.zIndex === '5'
    })
    return candidates.map((el) => el.style.opacity)
  })
}

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('test_plx_a11y_005_reduced_motion_suppresses_cursor_spotlight — and the app still functions with it on', async () => {
  launched = await launchApp()
  const { window } = launched
  // The Electron window's content is already loading by the time Playwright
  // hands us the Page, so CursorSpotlight's mount-time matchMedia check can
  // race ahead of emulateMedia. Force a reload so the app mounts fresh with
  // the emulated media state already in effect, same as a real user who has
  // the OS preference set before they open the app.
  await window.emulateMedia({ reducedMotion: 'reduce' })
  await window.reload()
  await waitForReady(window)
  await gotoView(window, 'goHome')
  await window.waitForTimeout(200)

  expect(await window.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)

  const before = await spotlightOpacities(window)
  expect(before.length, 'CursorSpotlight halo elements must be present in the DOM').toBeGreaterThan(0)

  // Move the mouse repeatedly across the window — with reduced motion this
  // must NOT wake the spotlight's rAF loop (no listeners were attached).
  for (let i = 0; i < 8; i++) {
    await window.mouse.move(100 + i * 40, 200 + i * 20)
    await window.waitForTimeout(30)
  }
  const after = await spotlightOpacities(window)
  expect(after.every((o) => o === '0' || o === ''), `spotlight opacity must stay suppressed, got: ${after}`).toBe(
    true
  )

  // The app still functions with reduced motion on: navigate Home -> open a desk.
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Reduced motion desk' })
    return { taskId: task.id }
  })
  await window.reload()
  await window.emulateMedia({ reducedMotion: 'reduce' })
  await waitForReady(window)
  await window.getByRole('button', { name: /Reduced motion desk/ }).first().click()
  await expect(window.locator('[data-canvas-surface="true"]')).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[data-testid="desk-context-trigger"]')).toBeVisible()
  void seeded
})

test('test_plx_a11y_005_control_spotlight_animates_without_reduced_motion', async () => {
  launched = await launchApp()
  const { window } = launched
  await window.emulateMedia({ reducedMotion: 'no-preference' })
  await waitForReady(window)
  await gotoView(window, 'goHome')
  await window.waitForTimeout(200)

  expect(await window.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false)

  for (let i = 0; i < 8; i++) {
    await window.mouse.move(100 + i * 40, 200 + i * 20)
    await window.waitForTimeout(30)
  }
  const after = await spotlightOpacities(window)
  expect(
    after.some((o) => o !== '0' && o !== ''),
    `control run must show the spotlight actually animating (opacity should move off 0), got: ${after}`
  ).toBe(true)
})
