import { test } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Brand Motion Phase 2 frames: the hero surfaces. Throwaway shot spec.
//   onboarding — FirstRunOnboarding step 0 (gradient wordmark, live loop)
//   signin     — LaunchSignInModal (gradient wordmark, one cycle on open)
//   whatsnew   — ReleaseModal header (the ii mark, once) — dark + light
// The overlays are forced the way the app itself decides to show them:
// a fresh profile shows onboarding then sign-in; an old lastRunVersion
// marker makes the release modal pending.

const OUT = process.env.SHOT_DIR ?? '/tmp'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('brand: onboarding + signin frames', async () => {
  test.setTimeout(120_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.setViewportSize({ width: 1440, height: 900 })
  // Force the first-run flow: the e2e profile is never "fresh" (the
  // freshness check sees the seeded nodes), so drive the store directly.
  await window.evaluate(() => {
    const w = window as unknown as {
      __fbOnboarding?: { getState: () => { start: (m: string) => void } }
    }
    w.__fbOnboarding?.getState().start('core')
  })
  const onb = window.locator('[role="dialog"][aria-label="Welcome to PlexiiDesk"]')
  const onbShown = await onb
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false)
  if (onbShown) {
    await window.waitForTimeout(700)
    await window.screenshot({ path: `${OUT}/bm2-onboarding.png` })
    await window.getByRole('button', { name: 'Get started' }).click().catch(() => {})
    await window.locator('[data-testid="onboarding-key-skip"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-tour-continue"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-start-blank"]').click().catch(() => {})
  }
  // The boot-path sign-in rules never fire in a seeded profile; open it the
  // way Settings does, through the shared prompt store.
  await window.evaluate(() => {
    const w = window as unknown as {
      __fbSignInPrompt?: { getState: () => { requestOpen: () => void } }
    }
    w.__fbSignInPrompt?.getState().requestOpen()
  })
  const signIn = window.locator('text=Continue without account')
  const appeared = await signIn
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false)
  if (appeared) {
    await window.waitForTimeout(3_200) // let the one open cycle settle to static
    await window.screenshot({ path: `${OUT}/bm2-signin.png` })
  }
})

for (const theme of ['dark', 'light']) {
  test(`brand: whatsnew frame, ${theme}`, async () => {
    test.setTimeout(120_000)
    launched = await launchApp()
    const { window } = launched
    await waitForReady(window)
    await window.setViewportSize({ width: 1440, height: 900 })
    await window.evaluate((t) => {
      localStorage.setItem('fb.theme.mode', t)
      localStorage.setItem('fb.app.lastRunVersion', '0.0.1')
      localStorage.removeItem('fb.app.releaseModalVersion')
    }, theme)
    await window.reload()
    await waitForReady(window)
    const dialog = window.locator('[role="dialog"][aria-label*="What"]')
    const ok = await dialog
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false)
    if (ok) {
      await window.waitForTimeout(3_200)
      await window.screenshot({ path: `${OUT}/bm2-whatsnew-${theme}.png` })
    }
  })
}
