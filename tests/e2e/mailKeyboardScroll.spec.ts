// Regression: the mail list must scroll to keep the highlighted thread inside
// its own visible window.
//
// The list is a scroller sitting under a fixed header bar (the compose /
// "Mail · N unread" row). Keyboard triage moved the selection without ever
// scrolling that list, so walking up with `k` landed on rows hidden above the
// fold — under the header bar — and walking down with `j` ran off the bottom,
// leaving the reading pane showing a message whose row was nowhere on screen.
//
// The mailbox is stubbed at the ipcMain boundary, so this needs no IMAP server
// and no credentials.
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, gotoView, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function stubMailbox(app: LaunchedApp['app']): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      uid: 1000 + i,
      fromName: `Sender ${i + 1}`,
      fromAddress: `sender${i + 1}@example.test`,
      subject: `Message ${i + 1} about the quarterly plan`,
      date: Date.parse('2026-08-20T09:00:00Z') - i * 3_600_000,
      seen: i % 3 !== 0,
      flagged: false,
      hasAttachments: false,
      messageId: `<m${i}@example.test>`,
      inReplyTo: null,
      references: []
    }))
    ipcMain.removeHandler('mail:getAccount')
    ipcMain.handle('mail:getAccount', () => ({
      configured: true,
      host: 'imap.example.test',
      port: 993,
      secure: true,
      user: 'me@example.test',
      email: 'me@example.test',
      authKind: 'password'
    }))
    ipcMain.removeHandler('mail:list')
    ipcMain.handle('mail:list', () => ({ ok: true, items }))
    ipcMain.removeHandler('mail:get')
    ipcMain.handle('mail:get', (_e: unknown, uid: number) => ({
      ok: true,
      message: {
        uid,
        fromName: 'Sender',
        fromAddress: 'sender@example.test',
        to: 'me@example.test',
        subject: `Message ${uid - 999}`,
        date: Date.parse('2026-08-20T09:00:00Z'),
        text: 'Body.',
        html: null,
        attachments: [],
        messageId: null,
        references: [],
        recipients: []
      }
    }))
    ipcMain.removeHandler('mail:markSeen')
    ipcMain.handle('mail:markSeen', () => ({ ok: true }))
  })
}

interface Selection {
  index: number
  scrollTop: number
  fullyVisible: boolean
  aboveFold: boolean
  belowFold: boolean
}

// Where the highlighted thread sits relative to the list's visible window.
async function selection(window: Page): Promise<Selection> {
  return window.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="mail-thread"]'))
    const list = document.querySelector<HTMLElement>('[data-testid="mail-list"]')
    if (!list) throw new Error('no mail list')
    const listBox = list.getBoundingClientRect()
    const row = rows.find((r) => r.dataset.mailThreadActive === 'true')
    if (!row) throw new Error('no highlighted thread')
    const rowBox = row.getBoundingClientRect()
    return {
      index: rows.indexOf(row),
      scrollTop: Math.round(list.scrollTop),
      fullyVisible: rowBox.top >= listBox.top - 1 && rowBox.bottom <= listBox.bottom + 1,
      aboveFold: rowBox.bottom <= listBox.top + 1,
      belowFold: rowBox.top >= listBox.bottom - 1
    }
  })
}

async function openMail(): Promise<Page> {
  launched = await launchApp()
  const { app, window } = launched
  await waitForReady(window)
  // The mail store loads the (unconfigured) account at boot, so stub the
  // handlers and reload so the stub is the first thing the renderer sees.
  await stubMailbox(app)
  await window.reload()
  await waitForReady(window)
  await gotoView(window, 'goMail')
  await expect(window.locator('[data-testid="mail-thread"]').first()).toBeVisible({
    timeout: 10_000
  })
  return window
}

test('j walks down the inbox without losing the highlighted thread off the bottom', async () => {
  const window = await openMail()
  await window.locator('[data-testid="mail-thread"]').first().click()
  await expect.poll(async () => (await selection(window)).index).toBe(0)

  for (let i = 0; i < 18; i++) {
    await window.keyboard.press('j')
    await window.waitForTimeout(70)
  }

  const sel = await selection(window)
  expect(sel.index).toBe(18)
  expect(sel.belowFold).toBe(false)
  expect(sel.fullyVisible).toBe(true)
  // Reaching row 18 in a ~13-row window is only possible if the list scrolled.
  expect(sel.scrollTop).toBeGreaterThan(0)
})

test('k walks back up without hiding the first threads under the header bar', async () => {
  const window = await openMail()
  await window.locator('[data-testid="mail-thread"]').first().click()
  await expect.poll(async () => (await selection(window)).index).toBe(0)

  for (let i = 0; i < 18; i++) {
    await window.keyboard.press('j')
    await window.waitForTimeout(70)
  }
  for (let i = 0; i < 18; i++) {
    await window.keyboard.press('k')
    await window.waitForTimeout(70)
  }

  const sel = await selection(window)
  expect(sel.index).toBe(0)
  expect(sel.aboveFold).toBe(false)
  expect(sel.fullyVisible).toBe(true)
  expect(sel.scrollTop).toBe(0)
})

test('k from a hand-scrolled list brings the thread back out from under the header', async () => {
  const window = await openMail()
  await window.locator('[data-testid="mail-thread"]').first().click()
  await expect.poll(async () => (await selection(window)).index).toBe(0)

  // Scroll down by hand — the selected first thread is now above the fold.
  const box = await window.locator('[data-testid="mail-thread"]').nth(3).boundingBox()
  await window.mouse.move(box!.x + 40, box!.y + 10)
  await window.mouse.wheel(0, 500)
  await expect.poll(async () => (await selection(window)).scrollTop).toBeGreaterThan(0)
  expect((await selection(window)).aboveFold).toBe(true)

  // One keypress must bring the selection back into view rather than moving it
  // deeper into the hidden region.
  await window.keyboard.press('k')
  await window.waitForTimeout(150)

  const sel = await selection(window)
  expect(sel.index).toBe(0)
  expect(sel.aboveFold).toBe(false)
  expect(sel.fullyVisible).toBe(true)
})
