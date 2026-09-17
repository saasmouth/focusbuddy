import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, gotoView, type LaunchedApp } from './_helpers'

// Triage in the real app.
//
// There is no IMAP server in a test profile, so the account and the messages
// are pushed straight into the mail store — that is enough to render the real
// MailView with its real toolbar. What is NOT faked is anything the feature
// itself does: the button, the panel, the IPC round trip and the honest error
// when there is no API key are all genuine.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

const FIXTURE = [
  {
    uid: 101,
    fromName: 'Dolan Studio',
    fromAddress: 'billing@dolan.example',
    subject: 'Invoice 4471 — paid',
    date: Date.now() - 86_400_000 * 3,
    seen: true,
    flagged: false,
    hasAttachments: true,
    messageId: '<a@dolan.example>',
    inReplyTo: null,
    references: [],
    unsubscribe: null,
    oneClickUnsubscribe: false
  },
  {
    uid: 102,
    fromName: 'Weekly Roundup',
    fromAddress: 'news@roundup.example',
    subject: 'Nine things about nothing',
    date: Date.now() - 86_400_000,
    seen: false,
    flagged: false,
    hasAttachments: false,
    messageId: '<b@roundup.example>',
    inReplyTo: null,
    references: [],
    unsubscribe: { kind: 'http' as const, target: 'https://roundup.example/out' },
    oneClickUnsubscribe: true
  }
]

async function seedInbox(window: LaunchedApp['window']): Promise<void> {
  await window.evaluate((items) => {
    const store = (window as unknown as { __fbMail?: { setState: (s: unknown) => void } }).__fbMail
    if (!store) throw new Error('__fbMail test handle is missing')
    store.setState({
      account: {
        configured: true,
        host: 'imap.invalid',
        port: 993,
        secure: true,
        user: 'tester',
        email: 'tester@invalid'
      },
      loadedAccount: true,
      messages: items,
      loadingList: false,
      error: null,
      hasMore: false
    })
  }, FIXTURE)
}

test('Mail offers the tidy-up button, and the panel reports honestly with no key', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await gotoView(window, 'goMail')
  await seedInbox(window)

  const open = window.locator('[data-testid="mail-triage-open"]')
  await expect(open).toBeVisible({ timeout: 10_000 })
  await open.click()

  const panel = window.locator('[data-testid="mail-triage-panel"]')
  await expect(panel).toBeVisible({ timeout: 10_000 })

  // No API key and no IMAP server in a test profile, so triage cannot run. It
  // must SAY so. The empty state -- "your inbox looks sorted already" -- would
  // be a convincing lie here: same blank screen, opposite meaning, and the
  // person walks away believing an inbox was read that never was. Asserting the
  // error specifically is the whole point of this test.
  const error = window.locator('[data-testid="mail-triage-error"]')
  await expect(error).toBeVisible({ timeout: 20_000 })
  expect(((await error.textContent()) ?? '').trim().length).toBeGreaterThan(0)
  await expect(window.locator('[data-testid="mail-triage-empty"]')).toBeHidden()

  await window.locator('[data-testid="mail-triage-close"]').click()
  await expect(panel).toBeHidden()
})

test('opening the panel moves no mail', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await gotoView(window, 'goMail')
  await seedInbox(window)

  // Record every mutating call the panel could make, then open it. The whole
  // design rests on triage proposing and never acting, so this asserts it
  // rather than trusting the code to keep being written that way.
  await window.evaluate(() => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const calls: string[] = []
    ;(window as unknown as { __mutations: string[] }).__mutations = calls
    for (const name of ['move', 'trash', 'spam', 'createFolder']) {
      const original = api.mail[name]
      api.mail[name] = (...args: unknown[]) => {
        calls.push(name)
        return original(...args)
      }
    }
  })

  await window.locator('[data-testid="mail-triage-open"]').click()
  await expect(window.locator('[data-testid="mail-triage-panel"]')).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('[data-testid="mail-triage-error"]')).toBeVisible({ timeout: 20_000 })

  const mutations = await window.evaluate(
    () => (window as unknown as { __mutations: string[] }).__mutations
  )
  expect(mutations).toEqual([])
})
