// Pasting into the assistant (owner, 2026-11-19: "check the ability to paste
// into the ai prompt").
//
//   CP-1  Copy a range somewhere, open the assistant on a desk, press ⌘V: it
//         lands in the composer, line by line with its tabs and blank line,
//         and no new widget appears on the desk. (The composer was never
//         focused on opening, so ⌘V went to the desk as a new widget; and
//         ProseMirror read the paste's HTML, flattening a range into one line.)
//
//   CP-2  A multi-line paste into the home bar's one-line Ask box is sent to
//         the assistant in its lines (the box can only show one line, and the
//         paste used to be sent as one run of words).
//
// The clipboard is the test's own (_clipboardStub.ts), never the system one.
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { installClipboardStub, MOD, installMainClipboardStub } from './_clipboardStub'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

test('CP-1 open the assistant and ⌘V: the range lands in the composer line by line, not on the desk', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'PasteDesk' })
    await api.widgets.create({ taskId: task.id, kind: 'sticky', title: '', content: 'A note', x: 120, y: 120, width: 220, height: 160 })
  })
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /PasteDesk/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 10_000 })
  const widgets = window.locator('[data-canvas-surface] [data-widget-id]')
  await expect(widgets).toHaveCount(1)

  // A range copied in a spreadsheet: TSV beside an HTML table, as Sheets writes it.
  await installClipboardStub(window, {
    'text/plain': 'Name\tCity\nAnn\tNYC\n\nBob\tLA',
    'text/html': '<table><tr><td>Name</td><td>City</td></tr><tr><td>Ann</td><td>NYC</td></tr><tr><td></td><td></td></tr><tr><td>Bob</td><td>LA</td></tr></table>'
  })
  await window.locator('[data-testid="assistant-pill"]').click()
  const composer = window.locator('[data-testid="chat-composer"]').first()
  await expect(composer).toBeVisible({ timeout: 10_000 })
  // Typing goes to the composer as soon as it opens.
  await expect.poll(() => window.evaluate(() => !!document.activeElement?.closest('[data-testid="chat-composer"]'))).toBe(true)

  await window.keyboard.press(`${MOD}+v`)
  await expect(composer.locator('p')).toHaveCount(4)
  expect(await composer.locator('p').allTextContents()).toEqual(['Name\tCity', 'Ann\tNYC', '', 'Bob\tLA'])
  // Nothing was pasted onto the desk.
  await window.waitForTimeout(500)
  await expect(widgets).toHaveCount(1)
})

test('CP-2 a multi-line paste into the home bar is sent to the assistant in its lines', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(() => (window as unknown as { __fbView: { getState: () => { goHome: () => void } } }).__fbView.getState().goHome())
  const box = window.locator('[data-testid="start-or-ask-input"]')
  await expect(box).toBeVisible({ timeout: 10_000 })
  // What is sent, caught at the chat store (no AI is reached).
  await window.evaluate(() => {
    const chat = (window as unknown as { __fbChat: { setState: (p: unknown) => void } }).__fbChat
    ;(window as unknown as { __sent: string[] }).__sent = []
    chat.setState({ send: async (_t: unknown, content: string) => { (window as unknown as { __sent: string[] }).__sent.push(content) } })
  })
  const EMAIL = 'Hi Ann,\n\nCan we move the review to Friday?\nThanks, Bo'
  await installClipboardStub(window, { 'text/plain': EMAIL })
  await box.click()
  await window.keyboard.type('Draft a reply to: ')
  await window.keyboard.press(`${MOD}+v`)
  await expect(box).toHaveValue('Draft a reply to: Hi Ann, Can we move the review to Friday? Thanks, Bo')
  await window.keyboard.press('Enter')
  await expect.poll(() => window.evaluate(() => (window as unknown as { __sent: string[] }).__sent)).toEqual([`Draft a reply to: ${EMAIL}`])
})
