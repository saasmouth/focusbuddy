import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

// Regression: Stage Manager "New desk" / "New room" used to create a blank
// "Untitled" node directly. They now dispatch fb:command-new-task, which the
// Sidebar listens for and opens NewNodeDialog (the build wizard) instead.

test('fb:command-new-task with kind:task opens the wizard, no blank node created', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    const nodeCountBefore = await window.evaluate(() => {
      const w = window as unknown as {
        __fbView?: { getState: () => Record<string, unknown> }
      }
      // Best-effort: not asserting on this store directly, just capturing a
      // baseline signal if one is exposed.
      return document.querySelectorAll('[data-widget-id]').length
    })

    await window.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('fb:command-new-task', { detail: { parentId: null, kind: 'task' } })
      )
    })

    const dialog = window.locator('[role="dialog"]')
    await expect(dialog).toBeVisible()
    await expect(window.locator('[data-testid="newnode-name"]')).toBeVisible()
    await expect(dialog.getByText('Importance', { exact: false })).toBeVisible()
    // The field reads 'Due (optional)' since 7038f7526.
    await expect(dialog.getByText(/^Due\b/).first()).toBeVisible()

    const nodeCountAfter = await window.evaluate(
      () => document.querySelectorAll('[data-widget-id]').length
    )
    expect(nodeCountAfter).toBe(nodeCountBefore)

    // Close without submitting — confirms nothing was created merely by
    // opening the wizard.
    await window.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  } finally {
    await dispose()
  }
})

test('fb:command-new-task with kind:folder opens the Room wizard, no task fields', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    await window.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('fb:command-new-task', { detail: { parentId: null, kind: 'folder' } })
      )
    })

    const dialog = window.locator('[role="dialog"]')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('h3')).toContainText('New Room')
    await expect(window.locator('[data-testid="newnode-name"]')).toBeVisible()

    // Task-only fields must NOT render for a Room.
    await expect(dialog.getByText('Importance', { exact: false })).toHaveCount(0)
    await expect(dialog.getByText('Due date', { exact: false })).toHaveCount(0)
  } finally {
    await dispose()
  }
})
