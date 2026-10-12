import { expect, test } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Regression for the launch prompt that used to flash for a frame forever.
//
// MissedTriagePrompt wraps its aria-modal panel in a scrim. The interruption
// coordinator originally read data-interruption-owner only from the panel,
// missed the marker on the wrapper, and classified the prompt as its OWN
// competing modal: quiet window -> mount -> self-block -> unmount -> repeat.
// This drives the real Electron renderer with a real missed block so the whole
// MutationObserver/render loop is covered, not just the owner lookup helper.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('missed-block triage stays open until dismissed, then stays closed', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const triage = window.locator('[data-testid="missed-triage"]')
  // launchApp normally dismisses this low-priority prompt so it cannot derail
  // unrelated specs. This spec owns it, so remove that global safety handler.
  await window.removeLocatorHandler(triage)

  await window.evaluate(async () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(9, 0, 0, 0)
    await window.api.timeBlocks.create({
      taskId: null,
      title: 'Stable missed block',
      startMs: yesterday.getTime(),
      durationMin: 30
    })
  })

  // A renderer reload is the launch-prompt boundary in this test: it resets
  // the module's once-per-session seam and makes it discover the seeded row.
  await window.reload()
  await waitForReady(window, { dismissModals: false })
  await expect(triage).toBeVisible({ timeout: 5_000 })
  await expect(triage.getByRole('dialog')).toHaveAttribute(
    'data-interruption-owner',
    'missed-triage'
  )

  // Longer than several old 750 ms hide/show cycles. Sampling continuously is
  // deliberate: a final visibility assertion could land on the one bright
  // frame and let the flashing bug pass.
  for (let i = 0; i < 20; i++) {
    await window.waitForTimeout(100)
    expect(await triage.isVisible(), `triage disappeared at sample ${i + 1}`).toBe(true)
  }

  await triage.getByRole('button', { name: 'Later', exact: true }).click()
  await expect(triage).toBeHidden()
  await window.waitForTimeout(1_600)
  await expect(triage).toBeHidden()
})
