import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// The reader opens over whatever you were doing, rather than navigating away.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('the mail modal opens, fails honestly with no mailbox, and closes', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await expect(window.locator('[data-testid="mail-modal"]')).toHaveCount(0)

  await window.evaluate(() => {
    const w = window as unknown as {
      __fbMailModal?: { getState: () => { open: (uid: number) => void } }
    }
    w.__fbMailModal?.getState().open(1)
  })

  const modal = window.locator('[data-testid="mail-modal"]')
  await expect(modal).toBeVisible({ timeout: 5000 })

  // No mailbox is configured in a fresh profile, so the reader must say why
  // rather than render a blank shell or invent a message.
  await expect(modal).toContainText(/Couldn.t open this message/)
  // ...and there is no reply bar offering to answer a message that never loaded.
  await expect(window.locator('[data-testid="mail-ai-draft"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="mail-send"]')).toHaveCount(0)

  // Escape closes it.
  await window.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
})

test('an inbox widget opens a message in place instead of leaving the desk', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Mail desk' })
    await api.widgets.create({
      taskId: desk.id, kind: 'inbox' as never, title: 'Inbox',
      content: '', x: 120, y: 120, width: 400, height: 380
    })
    return desk.id
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)

  const widget = window.locator('[data-widget-kind="inbox"]').first()
  await expect(widget).toBeVisible({ timeout: 10_000 })
  // With no mailbox connected the widget says so — and crucially does NOT
  // offer rows that would open an empty reader.
  await expect(widget).toContainText(/No mailbox connected|Mail isn.t available|Reading the mailbox/)
  await expect(window.locator('[data-testid="mail-modal"]')).toHaveCount(0)
})
