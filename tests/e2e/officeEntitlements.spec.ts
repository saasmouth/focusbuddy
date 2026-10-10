// E2E: per-editor PlexiOffice entitlements + the canvas guardrail.
//
// Two things are proven here, end to end through the real client code (only the
// two network hops — GET /accounts/me and GET /account/capabilities — are stubbed
// at the Playwright route layer, exactly as segmentSwitcherEntitlements.spec.ts
// does it):
//
//   1. THE GUARDRAIL. A user with product_office (and every office_*) OFF can
//      STILL add a canvas Note/Markdown widget from the widget palette. Canvas
//      note/markdown/sticky/page widgets are PlexiDesk features and must never be
//      gated by Office. This is the overriding invariant.
//
//   2. Per-editor gating in the Office shell. With office_sheets off but
//      office_docs on, the Sheets app tile renders locked (data-locked) with a
//      reason-aware tooltip, while the Docs tile stays a normal, clickable tile.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp, hoverToolbar, switchArea, isAreaLocked } from './_helpers'
import { CAPABILITY_DEFAULTS, type CapabilityValue } from '../../src/renderer/src/lib/capabilityDefaults'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

function freeMapWith(overrides: Record<string, CapabilityValue>): Record<string, CapabilityValue> {
  const out: Record<string, CapabilityValue> = {}
  for (const [key, perTier] of Object.entries(CAPABILITY_DEFAULTS)) {
    out[key] = perTier.free
  }
  return { ...out, ...overrides }
}

async function stubAuthAndCaps(
  window: Page,
  email: string,
  accountId: string,
  capsMap: Record<string, CapabilityValue>,
  sources: Record<string, string>
): Promise<() => number> {
  await window.route('**/accounts/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        account: {
          id: accountId,
          email,
          handle: null,
          firstName: 'Ada',
          lastName: 'Lovelace',
          createdAt: Date.now(),
          lastLoginAt: Date.now()
        }
      })
    })
  })
  let capabilitiesCallCount = 0
  await window.route('**/account/capabilities**', async (route) => {
    capabilitiesCallCount++
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        tier: 'free',
        storedTier: 'free',
        effectiveTier: 'free',
        trial: { active: false, daysLeft: 0, startedAt: null, expiresAt: null },
        capabilities: capsMap,
        sources,
        orgRole: null
      })
    })
  })
  return () => capabilitiesCallCount
}

async function confirmIncomingSession(
  app: LaunchedApp['app'],
  window: Page,
  token: string,
  email: string
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, payload) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.webContents.send('auth:incoming-token', {
      sessionToken: payload.token,
      email: payload.email,
      handle: null,
      origin: 'open-url'
    })
  }, { token, email })

  const dialog = window.locator('[data-testid="prompt-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.getByRole('button', { name: 'Sign in' }).click()
  await expect(dialog).toBeHidden({ timeout: 5_000 })
}

// ── The guardrail: Office fully off, canvas widgets still work ──────────────

test('GUARDRAIL — with product_office OFF, a Note widget can still be added to the canvas', async () => {
  const email = `office-off-${Date.now()}@example.com`

  launched = await launchApp()
  const { app, window } = launched

  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)

  // Seed a task (a canvas) via the real API, then reload so the sidebar shows
  // it. Still signed out here — product_office is true on the free snapshot.
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: 'Guardrail desk' })
  })
  await window.reload()
  await waitForReady(window)

  // Now stub the network so signing in resolves Office fully OFF.
  const capsMap = freeMapWith({
    product_office: false,
    office_docs: false,
    office_sheets: false,
    office_slides: false,
    office_draw: false,
    office_design: false
  })
  const getCalls = await stubAuthAndCaps(window, email, 'acc_office_off', capsMap, {
    product_office: 'org'
  })

  await confirmIncomingSession(app, window, 'stub-office-off-token', email)
  await expect.poll(getCalls, { timeout: 5_000 }).toBeGreaterThan(0)

  // Sanity: Office really is locked now (proves the caps landed).
  await expect
    .poll(async () => await isAreaLocked(window, 'office'), { timeout: 5_000 })
    .toBe(true)

  // Open the seeded canvas and add a Note widget from the palette.
  await window.getByRole('button', { name: 'Guardrail desk' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  const before = await window.evaluate(() => document.querySelectorAll('[data-widget-id]').length)

  await hoverToolbar(window) // the toolbar only mounts the palette while hovered
  await window.locator('[data-testid="palette-add-button"]').first().click()
  // Note is an Advanced tile now — expand the Advanced section to reach it.
  await window.locator('[data-testid="palette-advanced-toggle"]').first().click().catch(() => {})
  await window.waitForTimeout(150)
  const addNote = window.locator('[data-testid="palette-add-note"]').first()
  await expect(addNote, 'Note widget must be creatable with Office off').toBeVisible()
  await addNote.click()

  // A new widget mounted — Office being off did not block a desk widget.
  await expect
    .poll(async () => window.evaluate(() => document.querySelectorAll('[data-widget-id]').length), { timeout: 5_000 })
    .toBeGreaterThan(before)

  expect(pageErrors, `Uncaught renderer errors: ${pageErrors.join('\n')}`).toHaveLength(0)
})

// ── Per-editor gating: Sheets locked, Docs available ───────────────────────

test('office_sheets OFF locks the Sheets tile while Docs stays available', async () => {
  const email = `sheets-off-${Date.now()}@example.com`

  launched = await launchApp()
  const { app, window } = launched

  // product_office on so the Office shell is reachable; office_sheets off due to
  // a licensing gap (offer upgrade), office_docs on.
  const capsMap = freeMapWith({ product_office: true, office_docs: true, office_sheets: false })
  const getCalls = await stubAuthAndCaps(window, email, 'acc_sheets_off', capsMap, {
    office_sheets: 'org'
  })

  await waitForReady(window)
  await confirmIncomingSession(app, window, 'stub-sheets-off-token', email)
  await expect.poll(getCalls, { timeout: 5_000 }).toBeGreaterThan(0)

  // Into the Office shell via the always-visible area switcher.
  await switchArea(window, 'office')

  const sheets = window.locator('[data-testid="office-app-sheets"]')
  const docs = window.locator('[data-testid="office-app-docs"]')
  await expect(sheets).toBeVisible({ timeout: 5_000 })

  // Sheets is locked with a reason-aware (licensing → upgrade) tooltip.
  await expect.poll(async () => sheets.getAttribute('data-locked'), { timeout: 5_000 }).toBe('true')
  expect(await sheets.getAttribute('title')).toContain('Upgrade')

  // Docs stays a normal, clickable tile (not locked).
  await expect(docs).toBeVisible()
  await expect(docs).not.toHaveAttribute('data-locked', 'true')
})
