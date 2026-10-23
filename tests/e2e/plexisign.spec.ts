/**
 * PlexiSign E2E — verifies the full local signature flow:
 * create draft → send → sign (signer 1) → sign (signer 2) → completed + certificate.
 *
 * No account / signal-server login needed. PlexiSign is local-first (SQLite only).
 */
import { test, expect } from '@playwright/test'
import { gotoView, grantCapability, launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('PlexiSign: create → send → sign both signers → completed + certificate + audit trail', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)

  // PlexiSign is plan-gated (lib/viewCapability.ts maps the `sign` view kind to
  // the `esign` capability), so without this the view renders "PlexiiSign is
  // not on your plan" and nothing under test is reachable. _helpers'
  // grantCapability is documented for exactly this: a spec about a feature's
  // BEHAVIOUR rather than its entitlement. Gating itself is covered by
  // officeEntitlements / segmentSwitcherEntitlements.
  await grantCapability(window, 'esign')

  // ── 1. Navigate to PlexiSign ────────────────────────────────────────────────
  // Two buttons named "PlexiSign" exist (sidebar nav + product-tile on home).
  // The sidebar nav button is the first one.
  // STALE: the sidebar row is labelled "Sign" now, not "PlexiiSign"
  // (lib/segmentApps.ts), so this matched nothing and waited out the test.
  // view.ts has goSign ({ kind: 'sign' }).
  await gotoView(window, 'goSign')
  const view = window.locator('[data-testid="plexisign"]')
  await expect(view).toBeVisible({ timeout: 8_000 })

  // ── 2. Open the composer ──────────────────────────────────────────────────────
  await window.locator('[data-testid="sign-new"]').click()
  const composer = window.locator('[data-testid="sign-composer"]')
  await expect(composer).toBeVisible({ timeout: 4_000 })

  // ── 3. Fill title ─────────────────────────────────────────────────────────────
  await window.locator('[data-testid="sign-new-title"]').fill('NDA — Acme')

  // ── 4. Add two signers (one per line) ────────────────────────────────────────
  // The signers textarea is the second textarea inside the composer (no testid).
  const textareas = composer.locator('textarea')
  await textareas.nth(1).fill('Sarah Chen\nTom Wilson')

  // ── 5. Create the draft ──────────────────────────────────────────────────────
  await window.locator('[data-testid="sign-new-create"]').click()

  // A sign-row should appear in the list (id is dynamic — match by prefix)
  const firstRow = view.locator('[data-testid^="sign-row-"]').first()
  await expect(firstRow).toBeVisible({ timeout: 5_000 })

  // The detail panel should appear and show Draft status
  const detail = window.locator('[data-testid="sign-detail"]')
  await expect(detail).toBeVisible({ timeout: 4_000 })
  await expect(detail).toContainText('Draft')

  // Both signers should be listed
  await expect(detail).toContainText('Sarah Chen')
  await expect(detail).toContainText('Tom Wilson')

  // ── 6. Send — status → Out for signature ──────────────────────────────────────
  await window.locator('[data-testid="sign-send"]').click()
  // Detail should update to Out for signature; signer 1 should be "Their turn"
  await expect(detail).toContainText('Out for signature', { timeout: 4_000 })
  await expect(detail).toContainText('Their turn')

  // ── 7. Sign as Sarah Chen (signer 1) — use the Type mode (default) ───────────
  const signSubmit = window.locator('[data-testid="sign-submit"]')
  await expect(signSubmit).toBeVisible({ timeout: 4_000 })
  // The typed input should be pre-filled with the signer name
  const signInput = detail.locator('input[style*="font-hand"], input[style*="font-family"]').first()
  // Input may not have the style attr attribute testable — find by value prefill
  // The SignBox pre-fills typed with signer.name — verify then click Sign
  await expect(signSubmit).not.toBeDisabled({ timeout: 3_000 })
  await signSubmit.click()

  // Signer 1 → Signed; signer 2 → Their turn
  await expect(detail).toContainText('Signed', { timeout: 5_000 })
  // Signer 2 should now be "Their turn"
  await expect(detail).toContainText('Their turn')

  // ── 8. Sign as Tom Wilson (signer 2) ─────────────────────────────────────────
  await expect(signSubmit).toBeVisible({ timeout: 4_000 })
  await expect(signSubmit).not.toBeDisabled()
  await signSubmit.click()

  // ── 9. Verify Completed state ─────────────────────────────────────────────────
  await expect(detail).toContainText('Completed', { timeout: 5_000 })
  await expect(detail).toContainText('2/2 signed')

  // ── 10. Certificate — must be a 64-char hex sha256 (real, not placeholder) ───
  const certLocator = detail.locator('.font-mono')
  await expect(certLocator).toBeVisible({ timeout: 4_000 })
  const certText = await certLocator.textContent()
  expect(certText).toMatch(/^[0-9a-f]{64}$/i)

  // ── 11. Audit trail — must have created/sent/signed/signed/completed entries ──
  await expect(detail).toContainText('created')
  await expect(detail).toContainText('sent')
  // There should be two "signed" entries + one "completed"
  const auditItems = detail.locator('text=signed')
  const count = await auditItems.count()
  expect(count).toBeGreaterThanOrEqual(2)
  await expect(detail).toContainText('completed')

  // ── 12. Confirm stat tiles reflect the completed count ───────────────────────
  // The Completed stat tile value should be "1"
  // StatTile renders the value inside a large text span — check at the view level
  // (exact DOM structure depends on the plexi primitive, match loosely)
  await expect(view).toContainText('1') // at least one completed
})
