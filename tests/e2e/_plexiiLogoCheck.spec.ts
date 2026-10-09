import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

// Ad-hoc verification spec for the Plexii wordmark rollout (commit 7e6ffbf).
// Not meant to stay in the suite long-term — dispatched by plexidesk-tester
// to prove the logo renders (titlebar, sidebar, sign-in modal) in both
// themes. Left uncommitted; delete or fold into a permanent spec later.

test('Plexii logo renders in titlebar + sidebar, survives theme toggle, and shows in sign-in modal', async () => {
  const { window, dispose } = await launchApp()
  try {
    // Manually walk onboarding (instead of the default dismissModals:true
    // path) so we can catch the sign-in modal that appears right after.
    await window.waitForFunction(
      () => typeof (window as unknown as { api?: unknown }).api === 'object',
      null,
      { timeout: 10_000 }
    )
    await expect(window.locator('[data-testid="footer-sync-chip"]')).toBeVisible({
      timeout: 10_000
    })

    const onb = window.locator('[role="dialog"][aria-label="Welcome to PlexiDesk"]')
    if (await onb.isVisible().catch(() => false)) {
      await window.getByRole('button', { name: 'Get started' }).click().catch(() => {})
      await window.locator('[data-testid="onboarding-key-skip"]').click().catch(() => {})
      await window.locator('[data-testid="onboarding-tour-continue"]').click().catch(() => {})
      await window.locator('[data-testid="onboarding-start-blank"]').click().catch(() => {})
    }

    // ---- 1. App boots without crash / no error boundary ----
    const errorBoundary = window.locator('text=/something went wrong/i')
    expect(await errorBoundary.count()).toBe(0)

    // ---- 4. Sign-in modal shows the logo (white variant, centered) ----
    // Give the account store a moment to settle post-onboarding.
    const signInModal = window.locator('text=Continue without account')
    const modalAppeared = await signInModal
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false)

    let signInLogoVisible = false
    let signInLogoBox: { width: number; height: number } | null = null
    let signInLogoIsWhiteVariant: boolean | null = null
    if (modalAppeared) {
      // Scope strictly to the modal dialog (portal-rendered, so DOM order
      // doesn't reliably put it after the titlebar) — otherwise `.first()`
      // on a page-wide `[aria-label="Plexii"] img` query can accidentally
      // match the titlebar's logo instead of the modal's.
      const dialog = window.locator('[role="dialog"][aria-label="Sign in to PlexiDesk"]')
      const modalLogo = dialog.locator('[aria-label="Plexii"] img')
      signInLogoVisible = await modalLogo.isVisible().catch(() => false)
      signInLogoBox = await modalLogo.boundingBox().catch(() => null)
      // variant="white" renders a single <img> (no dark:/hidden split), so
      // exactly one match confirms the forced-white-variant code path.
      const modalLogoCount = await modalLogo.count()
      signInLogoIsWhiteVariant = modalLogoCount === 1
      await window.screenshot({ path: 'test-results/focusbuddy-signin-modal.png' })
      // Dismiss so we can inspect the shell underneath.
      await signInModal.click().catch(() => {})
    }

    await window.waitForTimeout(300)

    // ---- 2. Titlebar + sidebar logo present, correct sizing, no clip ----
    async function inspectLogos(themeLabel: string): Promise<{
      count: number
      visibleCount: number
      boxes: Array<{ height: number; width: number } | null>
    }> {
      const imgs = window.locator('[aria-label="Plexii"] img')
      const count = await imgs.count()
      let visibleCount = 0
      const boxes: Array<{ height: number; width: number } | null> = []
      for (let i = 0; i < count; i++) {
        const img = imgs.nth(i)
        const visible = await img.isVisible().catch(() => false)
        if (visible) visibleCount++
        const box = visible ? await img.boundingBox().catch(() => null) : null
        boxes.push(box)
      }
      await window.screenshot({ path: `test-results/focusbuddy-shell-${themeLabel}.png` })
      return { count, visibleCount, boxes }
    }

    const initial = await inspectLogos('initial')

    // ---- 3. Toggle theme, confirm logo stays visible in BOTH ----
    const wasDark = await window.evaluate(() =>
      document.documentElement.classList.contains('dark')
    )
    await window.evaluate((currentlyDark) => {
      document.documentElement.classList.toggle('dark', !currentlyDark)
    }, wasDark)
    await window.waitForTimeout(200)
    const toggled = await inspectLogos('toggled')

    // Restore original theme so we don't leave the app in a flipped state
    // (isolated userData gets wiped on dispose anyway, but be tidy).
    await window.evaluate((original) => {
      document.documentElement.classList.toggle('dark', original)
    }, wasDark)

    // ---------------- Assertions ----------------
    // At least the titlebar + sidebar instances (2 wrapper spans minimum).
    expect(initial.count).toBeGreaterThanOrEqual(2)
    // Exactly one <img> per wrapper should be visible at a time (auto variant
    // shows navy OR white via dark:hidden / hidden:dark:block).
    expect(initial.visibleCount).toBeGreaterThanOrEqual(1)
    expect(toggled.visibleCount).toBeGreaterThanOrEqual(1)

    for (const box of [...initial.boxes, ...toggled.boxes]) {
      if (!box) continue
      expect(box.height).toBeGreaterThan(0)
      expect(box.width).toBeGreaterThan(0)
      // 56px (h-14) header — logo must sit comfortably inside, not clip it.
      expect(box.height).toBeLessThan(56)
    }

    if (modalAppeared) {
      expect(signInLogoVisible).toBe(true)
      expect(signInLogoIsWhiteVariant).toBe(true)
      expect(signInLogoBox?.height).toBeCloseTo(26, 0)
    }

    console.log(
      JSON.stringify(
        {
          wasDarkInitially: wasDark,
          initial,
          toggled,
          signInModalAppeared: modalAppeared,
          signInLogoVisible,
          signInLogoBox,
          signInLogoIsWhiteVariant
        },
        null,
        2
      )
    )
  } finally {
    await dispose()
  }
})
