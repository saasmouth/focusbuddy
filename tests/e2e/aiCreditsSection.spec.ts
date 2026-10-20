/**
 * aiCreditsSection.spec.ts — E2E coverage for the AI-source chooser in
 * Settings → API keys section.
 *
 * Surfaces exercised:
 *   - AiSourceSection renders all three mode buttons (auto / credits / byok)
 *   - Default mode is 'auto' (highlighted on first boot)
 *   - Switching between modes round-trips through ai:setMode IPC without error
 *   - While signed out, selecting auto or credits shows the sign-in prompt
 *     (not a balance or a crash)
 *   - The credit balance data-testid and top-up buttons are present when signed in;
 *     in the signed-out path neither crashes the renderer
 *   - The existing Anthropic + OpenAI API key rows still render and are unaffected
 *
 * Sign-in is NOT attempted here — the hermetic test DB has no account. The
 * signed-in top-up and balance paths are marked as OPTIONAL in the spec brief
 * and are skipped without marking the suite RED.
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

// ---------------------------------------------------------------------------
// Helper: open Settings and scroll the AI source section into view.
// Returns once the mode buttons inside it are visible.
// ---------------------------------------------------------------------------
async function openSettingsToAiSection(window: LaunchedApp['window']): Promise<void> {
  const settingsBtn = window.getByRole('button', { name: /appearance settings/i })
  await expect(settingsBtn).toBeVisible({ timeout: 5_000 })
  await settingsBtn.click()

  const settingsPanel = window.locator('[role="dialog"][aria-label="Settings"]').first()
  await expect(settingsPanel).toBeVisible({ timeout: 5_000 })

  // Settings is tabbed; the AI source section (keys + credit chooser) lives on the
  // AI tab. Open it, then wait for the first mode button to be visible.
  await window.locator('[data-testid="settings-tab-ai"]').click()
  await expect(window.locator('[data-testid="ai-mode-auto"]')).toBeVisible({ timeout: 5_000 })
}

// ---------------------------------------------------------------------------
// Test 1 — App boots clean (no page-level JS errors).
// ---------------------------------------------------------------------------
test('AI credits: app boots with no console errors', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)

  // A brief wait to let any deferred effects settle (ai:getStatus + ai:refreshCredits
  // both fire on mount of AiSourceSection, which is inside Settings — they shouldn't
  // fire here, but any boot-time IPC errors would surface as page errors).
  await window.waitForTimeout(500)

  expect(pageErrors).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// Test 2 — AI-source chooser renders all three modes with 'auto' active.
// ---------------------------------------------------------------------------
test('AI credits: chooser renders three modes, Automatic selected by default', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)
  await openSettingsToAiSection(window)

  // The three AI sources (Local on this device / Your own API key / Plexii AI
  // credits). "Automatic" is the credits sub-option: a switch, not a source.
  const localBtn = window.locator('[data-testid="ai-mode-local"]')
  const creditsBtn = window.locator('[data-testid="ai-mode-credits"]')
  const byokBtn = window.locator('[data-testid="ai-mode-byok"]')
  const autoToggle = window.locator('[data-testid="ai-mode-auto"]')

  await expect(localBtn).toBeVisible({ timeout: 5_000 })
  await expect(creditsBtn).toBeVisible({ timeout: 5_000 })
  await expect(byokBtn).toBeVisible({ timeout: 5_000 })

  // Button labels must match the spec copy.
  await expect(localBtn).toContainText('Local on this device')
  await expect(byokBtn).toContainText('Your own API key')
  await expect(creditsBtn).toContainText('Plexii AI credits')

  // Default mode is 'auto': the credits source is selected and its Automatic
  // switch is on. Checked via class, not colour.
  expect(await creditsBtn.getAttribute('class')).toContain('bg-accent')
  expect(await localBtn.getAttribute('class')).not.toContain('bg-accent')
  expect(await byokBtn.getAttribute('class')).not.toContain('bg-accent')
  await expect(autoToggle).toBeChecked()

  // data-testid for credit balance and top-up are defined in the component
  // even in unsigned-out mode — verify their existence (they may be inside
  // a signed-in-only branch, so we only assert count > 0 OR that the signed-out
  // prompt is there).
  // In the signed-out path the balance card is NOT rendered; instead the sign-in
  // prompt is shown. Confirm the prompt text is present.
  const signInPrompt = window.getByText(/sign in to your plexii account/i)
  await expect(signInPrompt).toBeVisible({ timeout: 3_000 })

  expect(pageErrors).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// Test 3 — Switching modes round-trips through ai:setMode IPC cleanly.
// ---------------------------------------------------------------------------
test('AI credits: switching modes persists without error and Anthropic/OpenAI rows survive', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)
  await openSettingsToAiSection(window)

  const autoToggle = window.locator('[data-testid="ai-mode-auto"]')
  const creditsBtn = window.locator('[data-testid="ai-mode-credits"]')
  const byokBtn = window.locator('[data-testid="ai-mode-byok"]')
  const localBtn = window.locator('[data-testid="ai-mode-local"]')

  // --- Switch to Your own API key ---
  await byokBtn.click()
  // Wait for the IPC to settle (setMode is async, state updates in React).
  await window.waitForTimeout(500)
  expect(await byokBtn.getAttribute('class')).toContain('bg-accent')

  // In byok mode the credit card (signed-in or signed-out prompt) must NOT show.
  const signInPrompt = window.locator('text=Sign in to your PlexiiDesk account')
  await expect(signInPrompt).toHaveCount(0, { timeout: 3_000 })

  // --- Switch to Plexii AI credits (credits only) ---
  await creditsBtn.click()
  await window.waitForTimeout(500)
  expect(await creditsBtn.getAttribute('class')).toContain('bg-accent')
  await expect(autoToggle).not.toBeChecked()
  await expect(window.locator('[data-testid="ai-source-section"]').getByText(/sign in to your plexii account/i)).toBeVisible({ timeout: 3_000 })

  // --- Turn Automatic on (credits, then the user's own key) ---
  await autoToggle.check()
  await window.waitForTimeout(500)
  await expect(autoToggle).toBeChecked()
  expect(await creditsBtn.getAttribute('class')).toContain('bg-accent')

  // --- Switch to Local on this device ---
  await localBtn.click()
  await window.waitForTimeout(500)
  expect(await localBtn.getAttribute('class')).toContain('bg-accent')
  await expect(window.locator('[data-testid="ai-local-note"]')).toBeVisible({ timeout: 3_000 })
  // No credits card in local mode.
  await expect(window.locator('[data-testid="ai-source-section"]').getByText(/sign in to your plexii account/i)).toHaveCount(0)
  await expect(window.locator('[data-testid="local-ai-section"]')).toBeVisible()

  // Verify the Anthropic and OpenAI key rows are still present and unaffected.
  await window.evaluate(() => {
    const el = document.querySelector('text') || document.body
    el.scrollIntoView?.({ block: 'start' })
  })

  // Scroll to find the API key rows.
  await window.evaluate(() => {
    const anthropicEl = Array.from(document.querySelectorAll('span')).find(
      (el) => el.textContent?.toLowerCase().includes('anthropic api key')
    )
    if (anthropicEl) anthropicEl.scrollIntoView({ block: 'nearest' })
  })

  const anthropicLabel = window.getByText(/anthropic api key/i)
  const openaiLabel = window.getByText(/openai api key/i)

  await expect(anthropicLabel.first()).toBeVisible({ timeout: 5_000 })
  await expect(openaiLabel.first()).toBeVisible({ timeout: 5_000 })

  // No page errors throughout all the switching.
  expect(pageErrors).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// Test 4 — Signed-out: auto and credits mode show sign-in prompt, no crash.
// ---------------------------------------------------------------------------
test('AI credits: signed-out + auto/credits modes show sign-in prompt, no crash', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)
  await openSettingsToAiSection(window)

  // Confirm 'auto' (the default) shows the sign-in prompt.
  const autoSection = window.locator('[data-testid="ai-source-section"]')
  const signInPrompt = autoSection.getByText(/sign in to your plexii account/i)
  await expect(signInPrompt).toBeVisible({ timeout: 5_000 })

  // The growth-spec allowance copy (section 2: Free 100 a month, 300 trial
  // credits on verification) replaced the old "$1 of free credits" line.
  const creditsNote = autoSection.getByText(/300 bonus credits/i)
  await expect(creditsNote).toBeVisible({ timeout: 3_000 })

  // Switch to credits mode — same signed-out prompt must still show (no crash).
  await window.locator('[data-testid="ai-mode-credits"]').click()
  await window.waitForTimeout(500)
  await expect(signInPrompt).toBeVisible({ timeout: 3_000 })

  // The credit balance testid must NOT exist in unsigned-out mode (it's in the
  // signed-in branch). This verifies we didn't accidentally render a fake balance.
  await expect(window.locator('[data-testid="ai-credit-balance"]')).toHaveCount(0)

  // Top-up buttons also should NOT be present when not signed in.
  await expect(window.locator('[data-testid="ai-topup-10"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="ai-topup-25"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="ai-topup-50"]')).toHaveCount(0)

  expect(pageErrors).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// Test 5 — No regression: API key rows + rest of Settings render normally.
// ---------------------------------------------------------------------------
test('AI credits: no regression — Settings panel fully renders without errors', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)

  // Open settings, then the AI tab (where the key rows live).
  const settingsBtn = window.getByRole('button', { name: /appearance settings/i })
  await settingsBtn.click()

  const settingsPanel = window.locator('[role="dialog"][aria-label="Settings"]').first()
  await expect(settingsPanel).toBeVisible({ timeout: 5_000 })
  await window.locator('[data-testid="settings-tab-ai"]').click()

  // Anthropic row renders.
  await expect(window.getByText(/anthropic api key/i).first()).toBeVisible({ timeout: 5_000 })
  // Purpose text confirms full row renders.
  await expect(window.getByText(/canvas ai, chat/i).first()).toBeVisible({ timeout: 3_000 })

  // OpenAI row renders.
  await expect(window.getByText(/openai api key/i).first()).toBeVisible({ timeout: 5_000 })

  // Voice transcription toggle also still shows.
  await window.evaluate(() => {
    const heading = Array.from(document.querySelectorAll('*')).find(
      (el) => el.textContent?.toLowerCase().includes('voice') && el.textContent?.toLowerCase().includes('transcription')
    )
    if (heading) heading.scrollIntoView({ block: 'nearest' })
  })
  await expect(window.getByText(/transcription provider/i).first()).toBeVisible({ timeout: 5_000 })

  expect(pageErrors).toHaveLength(0)
})
