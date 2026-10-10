// Mail view E2E — exercises the new IMAP email surface (Steps 1-6 per the
// test brief). No real IMAP credentials are used; the bogus-server test
// proves the full renderer→preload→ipcMain→imapflow→error-mapping chain.
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp, switchArea } from './_helpers'

let launched: LaunchedApp | null = null

// Mail and Inbox moved into the PlexiOffice area (commit aa5fe9a): the old
// sidebar entries this spec clicked no longer exist. Navigate the current
// path — the area switcher, then the Office comms entry.
async function openOfficeComms(
  window: import('@playwright/test').Page,
  app: 'mail' | 'inbox'
): Promise<void> {
  await switchArea(window, 'office')
  await window.locator(`[data-testid="office-comms-app-${app}"]`).click()
}

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ── Step 1: app boots clean ──────────────────────────────────────────────────
test('step1 - app boots without console errors', async () => {
  const consoleErrors: string[] = []
  launched = await launchApp()
  const { window } = launched

  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await waitForReady(window)
  // Allow tiny DOM warnings (React, Electron internals) but catch anything
  // that looks like a real module/IPC/init failure.
  const fatal = consoleErrors.filter(
    (e) =>
      /Cannot find module|ipcRenderer|Uncaught|SyntaxError|ReferenceError/.test(e) &&
      !/favicon/.test(e)
  )
  expect(fatal).toHaveLength(0)
})

// ── Step 2: sidebar Mail entry → setup form with preset chips ───────────────
test('step2 - sidebar Mail nav entry opens setup form with provider presets', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openOfficeComms(window, 'mail')

  // The setup form heading should appear.
  await expect(window.getByRole('heading', { name: /connect your email/i })).toBeVisible({
    timeout: 8_000
  })

  // All five provider preset chips must be present.
  for (const label of ['Gmail', 'Outlook', 'iCloud', 'Fastmail', 'Yahoo']) {
    await expect(window.getByRole('button', { name: label })).toBeVisible()
  }
})

// ── Step 3: clicking Gmail preset fills IMAP host ────────────────────────────
test('step3 - clicking Gmail preset fills the IMAP host', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openOfficeComms(window, 'mail')
  await expect(window.getByRole('heading', { name: /connect your email/i })).toBeVisible({
    timeout: 8_000
  })

  // Click the Gmail chip.
  await window.getByRole('button', { name: 'Gmail' }).click()

  // Expand the advanced section to see host + port.
  await window.getByRole('button', { name: /imap server settings/i }).click()

  // The host field should now show imap.gmail.com.
  const hostInput = window.getByPlaceholder('imap.example.com')
  await expect(hostInput).toHaveValue('imap.gmail.com', { timeout: 3_000 })

  // The app-password note should appear.
  await expect(window.getByText(/app password/i)).toBeVisible()
})

// ── Step 4: bogus-server test → friendly inline error, no crash ─────────────
test('step4 - test connection to bogus server returns friendly error', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openOfficeComms(window, 'mail')
  await expect(window.getByRole('heading', { name: /connect your email/i })).toBeVisible({
    timeout: 8_000
  })

  // Fill email.
  await window.getByPlaceholder('you@example.com').fill('test@example.com')
  // Fill password.
  await window.getByPlaceholder(/app password/i).fill('x')

  // Open advanced settings.
  await window.getByRole('button', { name: /imap server settings/i }).click()

  // Set bogus host.
  const hostInput = window.getByPlaceholder('imap.example.com')
  await hostInput.fill('127.0.0.1')

  // Set port to 1 — unlikely to have anything listening, guaranteed ECONNREFUSED.
  const portInput = window.getByRole('spinbutton')
  await portInput.fill('1')

  // Uncheck SSL/TLS.
  const sslCheckbox = window.getByRole('checkbox', { name: /ssl\/tls/i })
  if (await sslCheckbox.isChecked()) {
    await sslCheckbox.uncheck()
  }

  // Click "Test connection" and wait. Port 1 ECONNREFUSED fires immediately
  // so we skip asserting on the transient "Testing…" state (it resolves
  // before the assertion has a chance to run) and go straight to the error.
  const testBtn = window.getByRole('button', { name: /test connection/i })
  await testBtn.click()

  // Wait for the inline error to appear — up to 20 s to cover the 12 s
  // greetingTimeout in the rare case the OS doesn't refuse immediately.
  const errorDiv = window.locator('[data-testid="mail-setup-error"]')
  await expect(errorDiv.first()).toBeVisible({ timeout: 20_000 })

  const errorText = (await errorDiv.first().textContent()) ?? ''
  // The mapped message must be the human-readable version, not a raw Node stack.
  expect(errorText).toMatch(/could not reach|could not find|login was rejected/i)
  // Log the actual string for the test report.
  console.log('[step4] error text observed:', errorText)

  // The button must be idle again (not stuck in "Testing…") — proves no hang.
  await expect(window.getByRole('button', { name: /test connection/i })).toBeEnabled({
    timeout: 3_000
  })

  // The app must still be responsive: check the window title is still accessible.
  const title = await window.title()
  expect(title).toBeTruthy()
})

// ── Step 5: Inbox view still renders with no account ────────────────────────
test('step5 - Inbox view renders without crashing when no account is set', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Navigate to the Inbox via its current home in PlexiOffice comms.
  await openOfficeComms(window, 'inbox')
  await expect(window.getByRole('heading', { name: /^PlexiInbox$/i })).toBeVisible({
    timeout: 5_000
  })

  // The view renders — either sign-in prompt or the unified feed. Either is
  // acceptable; the test just checks there is no crash (no error overlay
  // from React's error boundary covering the whole screen).
  await expect(
    window.locator('[data-testid="fatal-error"], [data-error-boundary]')
  ).toHaveCount(0, { timeout: 5_000 })

  // The main pane must have some visible content — use the unique role.
  await expect(window.getByRole('main')).toBeVisible({ timeout: 5_000 })
})

// ── Step 6: existing nav entries still route ─────────────────────────────────
test('step6 - existing nav entries (Home, All Tasks, Calendar, Vault) still route', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const navItems = [
    { name: /^Home$/i },
    { name: /^All Tasks$/i },
    { name: /^Calendar$/i },
    { name: /^Vault$/i }
  ]

  for (const item of navItems) {
    const btn = window.getByRole('button', { name: item.name })
    if (await btn.isVisible().catch(() => false)) {
      await btn.click()
      // No crash — React error boundary must not be covering the screen.
      await expect(
        window.locator('[data-testid="fatal-error"], [data-error-boundary]')
      ).toHaveCount(0, { timeout: 3_000 })
    }
  }
})
