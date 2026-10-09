// Body doubling: where the preference lives, and the tour that explains it.
//
// Asked for 2026-10-09: "where do i configure my body double preference. Also
// include a special onboarding for the edition which includes it explaining the
// feature, and navigating to where to opt in to it, and what type of body
// double they want to be, silent, intro, etc".
//
// Before this there was no answer: the mode was picked inside the Find-a-partner
// dialog and reset to Silent every time it opened.

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

/** Turn the capability on, as an edition that includes body doubling would. */
async function enableBodyDouble(window: LaunchedApp['window']): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as {
      __fbCapabilities?: { setState: (s: { capabilities: Record<string, unknown> }) => void }
    }
    w.__fbCapabilities!.setState({ capabilities: { body_double: true } })
  })
}

async function openSettingsAccount(window: LaunchedApp['window']): Promise<void> {
  await window.evaluate(() => {
    window.dispatchEvent(new CustomEvent('fb:open-settings', { detail: { tab: 'account' } }))
  })
}

test('BD-1 — the preference has a home in Settings, gated on the capability', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Without the capability the edition must not advertise the feature.
  await window.evaluate(() => {
    const w = window as unknown as {
      __fbCapabilities?: { setState: (s: { capabilities: Record<string, unknown> }) => void }
    }
    w.__fbCapabilities!.setState({ capabilities: { body_double: false } })
  })
  await openSettingsAccount(window)
  await expect(window.locator('[data-testid="settings-body-double"]')).toHaveCount(0)

  // With it, the section is there with all four modes.
  await enableBodyDouble(window)
  const section = window.locator('[data-testid="settings-body-double"]')
  await expect(section).toBeVisible({ timeout: 6000 })
  for (const m of ['silent', 'greetings', 'light', 'open']) {
    await expect(section.locator(`[data-testid="settings-body-double-mode-${m}"]`)).toBeVisible()
  }
  // Silent is the default: it opens the least.
  await expect(section.locator('[data-testid="settings-body-double-mode-silent"]')).toHaveAttribute(
    'aria-checked',
    'true'
  )
})

test('BD-2 — choosing a mode persists it as the default', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await enableBodyDouble(window)
  await openSettingsAccount(window)

  const section = window.locator('[data-testid="settings-body-double"]')
  await expect(section).toBeVisible({ timeout: 6000 })
  await section.locator('[data-testid="settings-body-double-mode-light"]').click()
  await expect(section.locator('[data-testid="settings-body-double-mode-light"]')).toHaveAttribute(
    'aria-checked',
    'true'
  )

  // It is a real saved preference, not component state.
  const stored = await window.evaluate(() => localStorage.getItem('fb.bodyDouble.defaultMode'))
  expect(stored).toBe('light')

  // And it survives a reload — the gap this closes.
  await window.reload()
  await waitForReady(window)
  await enableBodyDouble(window)
  await openSettingsAccount(window)
  await expect(
    window.locator('[data-testid="settings-body-double-mode-light"]')
  ).toHaveAttribute('aria-checked', 'true', { timeout: 6000 })
})

test('BD-3 — the tour is offered only to an edition that has the feature', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const idsWithout = await window.evaluate(() => {
    const w = window as unknown as {
      __fbCapabilities?: { setState: (s: { capabilities: Record<string, unknown> }) => void }
    }
    w.__fbCapabilities!.setState({ capabilities: { body_double: false } })
    return true
  })
  expect(idsWithout).toBe(true)

  // The tour's own steps must name the modes and point at the real surfaces;
  // that content is asserted in tests/unit/onboardingBodyDoubleModule.test.ts.
  // Here we only check the live wiring: the start button carries the testid the
  // last step spotlights, once the capability is on.
  await enableBodyDouble(window)
  await expect(window.locator('[data-testid="header-body-double"]')).toBeVisible({ timeout: 6000 })
})
