import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// P4 verification (console-error sweep): boots the built app and navigates to
// the PlexiChat route, watching for console errors / page errors that
// reference the new P4 surfaces (ChatPanel, ProposalCards, MessagesView,
// channelActions, messagingClient). Rendering an actual proposal card requires
// a signed-in org + a bot message with proposals, which requires a live
// Anthropic key — not available in this test env, and out of scope for this
// check. Card-rendering + consume logic is covered instead by
// tests/unit/aiChatProposals.test.ts (routeIncomingMessage/mapMessage).

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('P4 — app boots and PlexiChat route loads with no console errors referencing P4 surfaces', async () => {
  launched = await launchApp()
  const { window } = launched

  const consoleErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => {
    consoleErrors.push(`pageerror: ${err.message}`)
  })

  await waitForReady(window)

  await window.getByRole('button', { name: /^PlexiiChat/ }).first().click()
  await expect(window.getByRole('heading', { name: 'PlexiiChat' })).toBeVisible({ timeout: 6_000 })

  // Give any lazy chunk (ChatPanel/MessagesView) time to mount and settle.
  await window.waitForTimeout(1_000)

  const relevantErrors = consoleErrors.filter((e) =>
    /ChatPanel|ProposalCards|MessagesView|channelActions|messagingClient/i.test(e)
  )
  expect(relevantErrors, JSON.stringify(consoleErrors, null, 2)).toEqual([])
})
