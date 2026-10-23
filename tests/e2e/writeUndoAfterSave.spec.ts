/**
 * Undo survives the autosave, in both hosts.
 *
 * Reported against 4.3.41: PlexiiWrite loses its ENTIRE undo history about a
 * second after any edit, typing included. A second is the debounced save, and
 * the mechanism was the echo of our own write being mistaken for somebody
 * else's edit:
 *
 *   The main process emits documents:changed from inside the write, so the
 *   broadcast reaches the renderer BEFORE the write's promise resolves. At that
 *   moment the store's active.bodyRev is still the old revision and the queued
 *   body has already been taken from pendingBodies — so every guard the
 *   listener had was satisfied. It refetched, bumped bodyEpoch, and bodyEpoch is
 *   in the editor's React key: the editor remounted and the undo stack with it.
 *
 * The remount is RIGHT for a genuine external change — office editors seed
 * their content on mount, so a body swapped without one leaves stale text at a
 * current revision and the next keystroke overwrites somebody's work. It is
 * catastrophic for our own echo.
 *
 * Unit cover is tests/unit/writeUndoSurvivesSave.test.ts (the store) and
 * tests/unit/twoEditorsOneDocument.test.tsx (the widget). This spec is the
 * thing a person actually does: type, wait for the save, press undo.
 *
 * WHICH CASE IS THE GUARD. Rebuilt with the in-flight guard removed, WUS-1
 * FAILS — the typed sentence is still there after ⌘Z — and WUS-2 passes. That
 * is right rather than a weakness: the widget never had this bug, because it
 * clears its pending body only after the write, so its unsaved-text guard is
 * still set when the echo lands. WUS-1 guards the reported regression; WUS-2
 * guards the widget against acquiring it.
 *
 * AND THE BUNDLE HAS TO BE CURRENT. `npx playwright test` launches whatever is
 * in out/ and does not build, which is why the package script is
 * `npm run build && playwright test`. Run bare, this spec passed both with the
 * fix and with the fix deliberately removed, against a bundle seven hours old.
 * Build before trusting either colour.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

/** Longer than the 600ms store debounce and the 500ms widget one, with room. */
const PAST_THE_SAVE = 2_000

async function typeInto(window: Page, text: string): Promise<void> {
  const surface = window.locator('[data-testid="doc-editor-surface"]')
  await expect(surface).toBeVisible({ timeout: 8_000 })
  await surface.click()
  await surface.type(text, { delay: 10 })
  await expect(surface).toContainText(text, { timeout: 4_000 })
}

test('WUS-1 — Documents view: undo still works two seconds after typing', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    const docId = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const doc = await api.documents.create({ docType: 'doc', title: 'Undo After Save' })
      return doc.id
    })
    // Straight through the view store: the gotoView helper takes no argument
    // and widening it for one spec would touch every caller.
    await window.evaluate((id) => {
      const w = window as unknown as {
        __fbView?: { getState: () => { goDocument?: (docId: string) => void } }
      }
      w.__fbView?.getState().goDocument?.(id)
    }, docId)

    await typeInto(window, 'Sentence that undo must remove')

    // THE WAIT IS THE TEST. Pressing undo immediately always worked; the undo
    // stack was destroyed by the save that lands afterwards.
    await window.waitForTimeout(PAST_THE_SAVE)

    const surface = window.locator('[data-testid="doc-editor-surface"]')
    await surface.click()
    await window.keyboard.press('Meta+z')

    await expect(surface).not.toContainText('Sentence that undo must remove', { timeout: 4_000 })
  } finally {
    await dispose()
  }
})

test('WUS-2 — desk widget: undo still works two seconds after typing', async () => {
  // The widget is a different host with its own debounce and its own copy of
  // the body, and it survived the bug for a different reason than the fix —
  // it clears its pending body only after the write. Worth its own case, since
  // reordering two lines there would reintroduce the same loss.
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    const taskId = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'WUS-2 Task' })
      const doc = await api.documents.create({ docType: 'doc', title: 'Widget Undo' })
      await api.widgets.create({
        taskId: task.id,
        kind: 'doc' as never,
        title: 'Widget Undo',
        content: doc.id,
        x: 80,
        y: 80,
        width: 640,
        height: 480
      })
      return task.id
    })

    await window.reload()
    await waitForReady(window)
    await window.getByRole('button', { name: /WUS-2 Task/ }).first().click()
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })

    await typeInto(window, 'Widget text that undo must remove')
    await window.waitForTimeout(PAST_THE_SAVE)

    const surface = window.locator('[data-testid="doc-editor-surface"]')
    await surface.click()
    await window.keyboard.press('Meta+z')

    await expect(surface).not.toContainText('Widget text that undo must remove', { timeout: 4_000 })
    void taskId
  } finally {
    await dispose()
  }
})
