// Pasting into the assistant (owner, 2026-11-19: "check the ability to paste
// into the ai prompt").
//
//   CP-1  Copy a range somewhere, open the assistant on a desk, press ⌘V: it
//         lands in the composer, line by line with its tabs and blank line,
//         and no new widget appears on the desk. (The composer was never
//         focused on opening, so ⌘V went to the desk as a new widget; and
//         ProseMirror read the paste's HTML, flattening a range into one line.)
//
// The clipboard is the test's own (_clipboardStub.ts), never the system one.
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { installClipboardStub, MOD } from './_clipboardStub'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

test('CP-1 open the assistant and ⌘V: the range lands in the composer line by line, not on the desk', async () => {
  launched = await launchApp()
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
