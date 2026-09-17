// Show more must fetch a page from the SERVER, not reveal rows the app already
// downloaded and hid.
//
// There is no IMAP server in e2e and `window.api` is a contextBridge object --
// non-writable and non-configurable -- so the IPC cannot be stubbed from the
// renderer. What this covers is the UI contract on the real component: the
// control is offered only when the server said older mail exists, the count
// says what is held OF WHAT, the end state is honest, and clicking reaches the
// real channel and reports a failure instead of swallowing it. The paging
// arithmetic is in tests/unit/mailPaging.test.ts and the append/cursor/dedupe
// behaviour in tests/unit/mailPagingStore.test.ts.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

test.setTimeout(120_000)

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openMail(window: Page): Promise<void> {
  await window.locator('[data-testid="switch-office"]').click()
  await window.locator('[data-testid="office-comms-app-mail"]').click()
}

/**
 * Seed the mail store as if a first page had just come back from the server.
 * `held` messages are in hand; `total` is what the mailbox holds.
 */
async function seedInbox(
  window: Page,
  opts: { held: number; total: number; hasMore: boolean }
): Promise<void> {
  await window.evaluate(
    ({ held, total, hasMore }) => {
      const w = window as unknown as {
        __fbMail: { setState: (s: Record<string, unknown>) => void }
      }
      // uids count down from `total`, newest first, the way a real page arrives.
      const messages = Array.from({ length: held }, (_, i) => {
        const uid = total - i
        return {
          uid,
          fromName: `Sender ${uid}`,
          fromAddress: `s${uid}@example.com`,
          subject: `Message ${uid}`,
          date: uid * 100000,
          seen: true,
          flagged: false,
          hasAttachments: false,
          messageId: `<${uid}@example.com>`,
          inReplyTo: null,
          references: []
        }
      })
      w.__fbMail.setState({
        account: { configured: true, email: 'me@example.com' },
        loadedAccount: true,
        messages,
        hasMore,
        nextCursor: messages.length > 0 ? messages[messages.length - 1].uid : null,
        total,
        loadingList: false,
        loadingMore: false,
        error: null
      })
    },
    opts
  )
}

test('1. offers Show more, and says what is held of what, when older mail remains', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openMail(window)
  await seedInbox(window, { held: 40, total: 95, hasMore: true })

  await expect(window.locator('[data-testid="mail-load-more"]')).toBeVisible({ timeout: 8000 })
  // "40" alone would read as "you have 40 emails", and the rows above are
  // CONVERSATIONS, so the unit has to be said too.
  await expect(window.locator('[data-testid="mail-loaded-count"]')).toHaveText('40 of 95 messages')
  await expect(window.locator('[data-testid="mail-list-end"]')).toHaveCount(0)
})

test('2. does not offer Show more once the whole mailbox is in hand', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openMail(window)
  await seedInbox(window, { held: 95, total: 95, hasMore: false })

  await expect(window.locator('[data-testid="mail-list-end"]')).toBeVisible({ timeout: 8000 })
  await expect(window.locator('[data-testid="mail-load-more"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="mail-loaded-count"]')).toHaveText('95 of 95 messages')
})

test('3. a mailbox smaller than one page never offers Show more', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openMail(window)
  await seedInbox(window, { held: 12, total: 12, hasMore: false })

  await expect(window.locator('[data-testid="mail-list-end"]')).toBeVisible({ timeout: 8000 })
  await expect(window.locator('[data-testid="mail-load-more"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="mail-loaded-count"]')).toHaveText('12 of 12 messages')
})

test('4. clicking reaches the real channel, and a failure is reported not swallowed', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openMail(window)
  // The seeded account is not a real connected mailbox, so the fetch this click
  // makes genuinely fails in main. That is the point: the button must call
  // through, and a page that cannot be fetched must say so rather than quietly
  // leaving the list as it was.
  await seedInbox(window, { held: 40, total: 95, hasMore: true })

  await window.locator('[data-testid="mail-load-more"]').click()

  // An honest error, and the list untouched.
  await expect(window.locator('[data-testid="mail-loaded-count"]')).toHaveText('40 of 95 messages', {
    timeout: 10_000
  })
  const state = await window.evaluate(() =>
    (
      window as unknown as {
        __fbMail: {
          getState: () => { error: string | null; loadingMore: boolean; hasMore: boolean }
        }
      }
    ).__fbMail.getState()
  )
  expect(state.error, 'a failed page must surface an error').toBeTruthy()
  // The spinner must not be left running, and the page must stay retryable.
  expect(state.loadingMore).toBe(false)
  expect(state.hasMore).toBe(true)
  await expect(window.locator('[data-testid="mail-load-more"]')).toBeVisible()
})
