import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea } from './_helpers'

// Visual-review shots for App-UI phase 5c: Inbox + Mail aligned to the design
// system (tokens replace 144 stone literals, fb-field, ramp, press, stagger).
// Throwaway; delete when the phase closes.

const OUT = process.env.SHOT_DIR ?? '/tmp'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openComms(window: import('@playwright/test').Page, app: string): Promise<void> {
  await switchArea(window, 'office')
  await window.locator(`[data-testid="office-comms-app-${app}"]`).click()
  await window.waitForTimeout(600)
}

for (const theme of ['dark', 'atelier'] as const) {
  test(`mail setup + inbox, ${theme}`, async () => {
    launched = await launchApp()
    const { window } = launched
    await waitForReady(window)
    await window.setViewportSize({ width: 1440, height: 900 })
    await window.evaluate((t) => localStorage.setItem('fb.theme.mode', t), theme)
    await window.reload()
    await waitForReady(window)

    await openComms(window, 'mail')
    await expect(window.getByRole('heading', { name: /connect your email/i })).toBeVisible()
    // Advanced open so the fb-field inputs and SSL row are in frame.
    await window.getByRole('button', { name: /imap server settings/i }).click()
    await window.waitForTimeout(300)
    await window.screenshot({ path: `${OUT}/5c-mail-setup-${theme}.png` })

    await openComms(window, 'inbox')
    await expect(window.getByRole('heading', { name: /^PlexiInbox$/i })).toBeVisible()
    await window.screenshot({ path: `${OUT}/5c-inbox-${theme}.png` })
  })
}
