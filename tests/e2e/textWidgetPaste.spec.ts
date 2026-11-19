// A grid pasted into a sticky can be undone (owner, 2026-11-19: "check for
// similar issues with all other widgets and fix").
//
//   TW-1  Paste a range (tab-separated) into a sticky: it becomes a table in
//         the note, and ⌘Z in the note takes it back out. (The converted text
//         was set straight into the box, past its undo, so ⌘Z did nothing.)
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

test('TW-1 a range pasted into a sticky becomes a table, and ⌘Z takes it back', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const { window } = launched
  await waitForReady(window)
  const id = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'StickyDesk' })
    return (await api.widgets.create({ taskId: desk.id, kind: 'sticky', title: '', content: 'Start', x: 120, y: 100, width: 360, height: 260 })).id
  })
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /StickyDesk/ }).first().click()
  // A sticky shows its text until it is clicked into.
  await window.locator(`[data-widget-id="${id}"]`).getByText('Start', { exact: true }).click({ timeout: 15_000 })
  const box = window.locator(`[data-widget-id="${id}"] textarea`).first()
  await expect(box).toBeFocused({ timeout: 5_000 })
  await installClipboardStub(window, { 'text/plain': 'Name\tCity\nAnn\tNYC' })
  await window.keyboard.press('End')
  await window.keyboard.press(`${MOD}+v`)
  await expect.poll(() => box.inputValue()).toMatch(/\|\s*Name\s*\|\s*City\s*\|/)
  expect(await box.inputValue()).toMatch(/^Start/)
  await window.keyboard.press(`${MOD}+z`)
  await expect.poll(() => box.inputValue()).toBe('Start')
})
