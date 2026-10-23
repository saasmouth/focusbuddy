import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, openProduct, suppressFeatureSpotlights } from './_helpers'
import { signInWithFakeSignal } from './_fakeSignal'

// Verification spec for PlexiChat 2100 rungs 3-7 (Briefing, thread summary,
// translate, intent composer), driven in MessagesView, which is where every
// control it checks lives (messages-briefing, thread-summarise,
// messages-translate-lang, msg-menu-*; the composer's Clarify).
//
// How it gets there, and why it changed:
// - MessagesView is the PlexiiChat app in Office's Communicate tools
//   (9f72888e), reached with openProduct(window, 'chat'), as plexichatFeatures
//   does. This spec used to call goMessages() on the view store, but the
//   'messages' route has rendered FlowView since 2038f0ef ("PlexiChat Flow: one
//   prioritized stream replaces the channel maze"), which has no "Messages"
//   heading and none of these controls, so every test stopped at its first
//   assertion. Chat is no longer plan-gated either (de386f8a made it free).
// - Signed in through _fakeSignal (5d1d3beb): the session is seeded into the
//   renderer's real stores (__fbAccount / __fbMessaging) and every request to
//   the signal server is answered locally, so nothing reaches production. The
//   old seed looked for a `__stores` global that has never existed and, not
//   finding it, logged a note and returned, so rungs 3-7 checked nothing.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openChat(window: Page): Promise<void> {
  await suppressFeatureSpotlights(window)
  await openProduct(window, 'chat')
  await expect(window.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible({ timeout: 8_000 })
}

const CONV = { id: 'conv-2100', title: 'buddy' }
const HOLA = { id: 'msg-1', conversationId: CONV.id, fromAccount: 'acc_other', body: 'hola', createdAt: 1, editedAt: null, deletedAt: null, replyCount: 0 }

// ── Boot + console-error check ─────────────────────────────────────────────
test('P2100-boot — app boots and navigates to chat with no console errors referencing the changed modules', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const consoleErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => consoleErrors.push(String(err)))

  await waitForReady(window)
  await openChat(window)
  await window.waitForTimeout(1000)

  const flagged = consoleErrors.filter((e) =>
    /MessagesView|ChatComposer|BriefingPanel|BotRolesConfig|RecallPanel|PulsePanel|messagingClient/i.test(e)
  )
  if (flagged.length > 0) {
    console.log('FLAGGED CONSOLE ERRORS:\n' + flagged.join('\n'))
  }
  expect(flagged, 'no console errors referencing changed modules').toHaveLength(0)
})

// ── Rung 3: Briefing panel ────────────────────────────────────────────────
test('P2100-3 — Needs-you briefing button opens the briefing panel', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openChat(window)
  await signInWithFakeSignal(window, { conversation: CONV, messages: [HOLA] })

  await window.locator('[data-testid="messages-briefing"]').click()
  await expect(window.locator('[data-testid="briefing-panel"]')).toBeVisible({ timeout: 4_000 })
})

// ── Rung 4: thread summarise + honest no-summary result ───────────────────
test('P2100-4 — thread Summarise renders and resolves to an honest no-network result', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openChat(window)

  const parent = { id: 'p1', conversationId: 'conv-thr', fromAccount: 'acc_other', body: 'root', createdAt: 1, editedAt: null, deletedAt: null, replyCount: 3 }
  const fake = await signInWithFakeSignal(window, { conversation: { id: 'conv-thr', title: 'buddy' }, messages: [parent] })
  // Three replies open in the thread panel (Summarise needs at least three).
  await window.evaluate((cid) => {
    const w = window as unknown as { __fbMessaging: { setState: (s: object) => void } }
    const replies = [1, 2, 3].map((n) => ({
      id: `r${n}`, conversationId: cid, fromAccount: 'acc_other', body: `reply ${n}`, createdAt: n + 1, editedAt: null, deletedAt: null, replyCount: 0
    }))
    w.__fbMessaging.setState({ threadsByParent: { p1: replies }, activeThreadId: 'p1' })
  }, 'conv-thr')

  await expect(window.locator('[data-testid="thread-summarise"]')).toBeVisible({ timeout: 4_000 })
  await window.locator('[data-testid="thread-summarise"]').click()
  // The request really went to the (fake) server...
  await expect.poll(() => fake.requests.includes('POST /conversations/conv-thr/messages/p1/summary'), { timeout: 5_000 }).toBe(true)
  // ...which answered with no summary (no org key here). The panel must say
  // it is unavailable, never show a fabricated sentence.
  await expect(window.locator('[data-testid="thread-summary"]')).toHaveText('Summary unavailable here.', { timeout: 6_000 })
})

// ── Rung 6: translate control + language select present ───────────────────
test('P2100-6 — translate action and language select render on an active conversation', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openChat(window)
  await signInWithFakeSignal(window, { conversation: CONV, messages: [HOLA] })

  await expect(window.locator('[data-testid="messages-translate-lang"]')).toBeVisible({ timeout: 4_000 })
  // DEC-126: Translate lives in the message's ⋯ menu (on every message, not just your own)
  await window.locator('[data-testid="msg-menu-msg-1"]').click()
  await expect(window.locator('[data-testid="msg-translate-msg-1"]')).toBeVisible({ timeout: 4_000 })
})

// ── Rung 7: intent composer clarify button ─────────────────────────────────
test('P2100-7 — composer Clarify button present when a conversation is active', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openChat(window)
  await signInWithFakeSignal(window, { conversation: CONV, messages: [HOLA] })

  // Clarify acts on a draft, so it is offered only once there is one
  // (fa3f2bf0, where it shipped: `draft.trim().length > 0`).
  const composer = window.locator('[data-testid="message-composer"]')
  await expect(composer).toBeVisible({ timeout: 5_000 })
  const clarify = window.locator('[data-testid="composer-clarify"]')
  await expect(clarify).toHaveCount(0)
  await composer.click()
  await window.keyboard.type('can we move it to thursday', { delay: 5 })
  await expect(clarify).toBeVisible()
})
