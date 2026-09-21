// The consent prompt tells the truth about what it can remember.
//
// The gate used to FAIL OPEN on a page with no web address — no prompt at all.
// Now it asks, but it cannot store a standing grant (there is no site to key it
// under), so the prompt must not offer "Always allow" or promise that the
// choice can be revoked in Settings.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

test.setTimeout(180_000)
let launched: LaunchedApp | null = null
test.afterEach(async () => { if (launched) { await launched.dispose(); launched = null } })

async function pendingConsent(window: Page, host: string, rememberable: boolean): Promise<void> {
  await window.evaluate(
    ({ host, rememberable }) => {
      const w = window as any
      w.__fbBrowserAgent.setState({
        runs: {
          r1: {
            runId: 'r1', task: 'fill in the form', outcome: 'running', summary: '',
            pendingConsentHost: host, pendingConsentRememberable: rememberable,
            events: [], cost: null, findings: null, delivery: { state: 'idle', message: '' }
          }
        }
      })
      w.__fbWebPanel.getState().setActiveRun('r1')
    },
    { host, rememberable }
  )
}

test('a real site offers to remember the answer', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(() => (window as any).__fbView.getState().goOffice('browser'))
  await expect(window.locator('[data-testid="office-browser"]')).toBeVisible()

  await pendingConsent(window, 'example.com', true)
  await expect(window.locator('[data-testid="agent-consent-always"]')).toBeVisible()
  await expect(window.locator('[data-testid="agent-consent-once"]')).toHaveText('Just this once')
  await expect(window.locator('[data-testid="agent-consent-copy"]')).toContainText('revoke this any time')
})

test('a page with no web address asks without promising to remember', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(() => (window as any).__fbView.getState().goOffice('browser'))
  await expect(window.locator('[data-testid="office-browser"]')).toBeVisible()

  await pendingConsent(window, 'this page (it has no web address)', false)
  // No standing grant is possible, so none is offered.
  await expect(window.locator('[data-testid="agent-consent-always"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="agent-consent-once"]')).toHaveText('Allow')
  await expect(window.locator('[data-testid="agent-consent-copy"]')).toContainText('ask each time')
  await expect(window.locator('[data-testid="agent-consent-copy"]')).not.toContainText('Settings')
  // And declining is still there.
  await expect(window.locator('[data-testid="agent-consent-no"]')).toBeVisible()
})
