// E2E: MainPane's CapabilityGate backbone gates OS-level feature surfaces.
//
// The enforcement backbone (src/renderer/src/components/MainPane.tsx, using the
// VIEW_CAPABILITY map in src/renderer/src/lib/viewCapability.ts) wraps every
// gated view kind in a CapabilityGate. This proves it end to end through the real
// client code, with only the two network hops stubbed at the Playwright route
// layer, exactly as segmentSwitcherEntitlements.spec.ts and
// officeEntitlements.spec.ts do it.
//
//   1. With mail:false resolved, navigating to the mail view shows the locked
//      panel (data-capability="mail").
//   2. With chat:false resolved, the messages view shows the locked panel
//      (data-capability="chat").
//   3. An ENABLED surface (calendar with time_blocking:true) renders normally,
//      with no gate — proving the gate is entitlement-driven, not blanket.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { answerAsServerForUnknownToken } from './_fakeSignal'
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
  // Everything else the signed-in app asks the signal server, answered here as
  // the deployed server answers this stub token (it used to go to production).
  await answerAsServerForUnknownToken(window)
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

// Land directly on an OS-level view by seeding the persisted "last view" and
// reloading. The route stubs and the encrypted session survive the reload, so
// the capabilities store re-resolves against the same stubbed map and MainPane
// renders (or gates) the target surface.
async function openView(window: Page, view: Record<string, unknown>): Promise<void> {
  await window.evaluate((v) => {
    localStorage.setItem('fb.view.last', JSON.stringify(v))
  }, view)
  await window.reload()
  await waitForReady(window)
}

test('mail:false — the mail view shows the capability gate', async () => {
  const email = `mp-mail-off-${Date.now()}@example.com`
  launched = await launchApp()
  const { app, window } = launched

  const capsMap = freeMapWith({ mail: false })
  const getCalls = await stubAuthAndCaps(window, email, 'acc_mp_mail', capsMap, { mail: 'org' })

  await waitForReady(window)
  await confirmIncomingSession(app, window, 'stub-mp-mail-token', email)
  await expect.poll(getCalls, { timeout: 5_000 }).toBeGreaterThan(0)

  await openView(window, { kind: 'mail' })

  const gate = window.locator('[data-testid="capability-gate"]')
  await expect(gate).toBeVisible({ timeout: 10_000 })
  await expect(gate).toHaveAttribute('data-capability', 'mail')
})

test('chat:false — the messages view shows the capability gate', async () => {
  const email = `mp-chat-off-${Date.now()}@example.com`
  launched = await launchApp()
  const { app, window } = launched

  const capsMap = freeMapWith({ chat: false })
  const getCalls = await stubAuthAndCaps(window, email, 'acc_mp_chat', capsMap, { chat: 'user' })

  await waitForReady(window)
  await confirmIncomingSession(app, window, 'stub-mp-chat-token', email)
  await expect.poll(getCalls, { timeout: 5_000 }).toBeGreaterThan(0)

  await openView(window, { kind: 'messages' })

  const gate = window.locator('[data-testid="capability-gate"]')
  await expect(gate).toBeVisible({ timeout: 10_000 })
  await expect(gate).toHaveAttribute('data-capability', 'chat')
})

test('time_blocking:true — the calendar view renders with no gate', async () => {
  const email = `mp-cal-on-${Date.now()}@example.com`
  launched = await launchApp()
  const { app, window } = launched

  // Calendar entitled (free default), mail off to prove selectivity: only the
  // gated surface gates, the entitled one renders normally.
  const capsMap = freeMapWith({ time_blocking: true, mail: false })
  const getCalls = await stubAuthAndCaps(window, email, 'acc_mp_cal', capsMap, { mail: 'org' })

  await waitForReady(window)
  await confirmIncomingSession(app, window, 'stub-mp-cal-token', email)
  await expect.poll(getCalls, { timeout: 5_000 }).toBeGreaterThan(0)

  await openView(window, { kind: 'calendar' })

  // The calendar surface is present and there is no locked panel over it.
  await expect(window.locator('[data-testid^="calendar-mode-"]').first()).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('[data-testid="capability-gate"]')).toHaveCount(0)
})
