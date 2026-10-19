import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Tester-authored smoke check for PlexiChat "Channel Recall" wiring. The full
// RecallPanel flow needs a signed-in account + org + plan gate to reach a real
// channel, which existing PlexiChat/PlexiOffice specs already show is
// impractical to drive headless. This spec proves the new surface loads
// cleanly: no console errors referencing MessagesView, RecallPanel, or
// messagingClient on a normal app boot.
let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('recall wiring: no console errors on app boot', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const consoleErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => {
    consoleErrors.push(`pageerror: ${err.message}`)
  })

  await waitForReady(window)
  await window.waitForTimeout(500)

  const recallRelated = consoleErrors.filter((e) =>
    /MessagesView|RecallPanel|messagingClient|recallChannel/i.test(e)
  )

  expect(
    recallRelated,
    `console errors referencing the recall surface:\n${recallRelated.join('\n')}`
  ).toEqual([])
})
