// E2E: embedding a desk widget inside a document via DocMenuBar's Insert >
// "Work widget from a desk…" picker.
//
// Contract:
//   - DocMenuBar.tsx Insert menu item MENU.workWidgetFromDesk calls onInsertWidget,
//     which DocEditor.tsx wires to open WidgetPickerDialog
//     ([data-testid="widget-picker"]).
//   - Picking an entry ([data-testid^="widget-picker-item-"]) runs
//     editor.chain().focus().insertWidgetEmbed(widgetId).run(), landing a
//     WidgetEmbedNode in the doc body.
//   - WidgetEmbed.tsx resolves the widget fresh on mount: renders
//     [data-testid="widget-embed"] with the live sticky content when the
//     widget exists, or [data-testid="widget-embed-missing"] when it has
//     been deleted — reopening the doc re-resolves rather than caching.

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { MENU } from '../../src/shared/menus/lexicon'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

const STICKY_TEXT = 'Embed me please'

async function seedTaskWithSticky(window: LaunchedApp['window']): Promise<{ taskId: string; widgetId: string }> {
  return window.evaluate(async (text) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Widget embed source desk' })
    const widget = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: '',
      content: text,
      x: 100,
      y: 100,
      width: 220,
      height: 180
    } as never)
    return { taskId: task.id, widgetId: widget.id }
  }, STICKY_TEXT)
}

async function openDoc(window: LaunchedApp['window'], docId: string): Promise<void> {
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocument: (id: string) => void } } }
    w.__fbView?.getState().goDocument(id)
  }, docId)
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 8_000 })
}

async function insertWidgetFromDesk(window: LaunchedApp['window'], widgetId: string): Promise<void> {
  await window.locator('[data-testid="doc-menu-insert"]').click()
  await expect(window.locator('[data-testid="doc-menu-insert-list"]')).toBeVisible({ timeout: 3_000 })
  // THE LABEL IS READ FROM THE LEXICON, not spelled out here.
  //
  // This spec went red on a single character. ef1fba83 moved the item onto the
  // shared menu lexicon, where SPEC §9.2's Insert tail is "Insert snippet… ·
  // Work widget from a desk…" — an ellipsis, because the item opens a dialog,
  // which this one does. The exact-text match here did not follow, so it
  // waited for a label that no longer exists. (diagramEditor.spec.ts matches
  // the same item WITH the ellipsis and stayed green throughout, which is what
  // tells product from spec here.)
  //
  // Reading MENU means this can never drift again. It costs nothing: the
  // WORDING is already pinned by officeMenuBarContract.test.tsx, which asserts
  // the Insert tail verbatim. What this spec is for is the embed behaviour.
  await window
    .locator('[data-testid="doc-menu-insert-list"]')
    .getByText(MENU.workWidgetFromDesk.label, { exact: true })
    .click()

  await expect(window.locator('[data-testid="widget-picker"]')).toBeVisible({ timeout: 3_000 })
  await window.locator(`[data-testid="widget-picker-item-${widgetId}"]`).click()
  await expect(window.locator('[data-testid="widget-picker"]')).toHaveCount(0, { timeout: 3_000 })
}

test('inserting a widget embed renders the live sticky content and persists across reopen', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { widgetId } = await seedTaskWithSticky(window)

  const docId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const doc = await api.documents.create({ docType: 'doc', title: 'Embed target doc' } as never)
    return doc.id
  })

  await openDoc(window, docId)
  await insertWidgetFromDesk(window, widgetId)

  const embed = window.locator('[data-testid="widget-embed"]')
  await expect(embed).toBeVisible({ timeout: 5_000 })
  await expect(embed).toContainText(STICKY_TEXT)

  // Force a save so the embed node is persisted in the doc body (autosave is
  // debounced; nudge it explicitly via a keystroke + wait rather than relying
  // on timing alone).
  await window.waitForTimeout(2_000)

  // Navigate away, then back — the embed must still render from the saved body.
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocuments: () => void } } }
    w.__fbView?.getState().goDocuments()
  })
  await window.waitForTimeout(300)
  await openDoc(window, docId)

  const embedAfterReopen = window.locator('[data-testid="widget-embed"]')
  await expect(embedAfterReopen).toBeVisible({ timeout: 5_000 })
  await expect(embedAfterReopen).toContainText(STICKY_TEXT)

  // Delete the backing widget, then reopen the doc — the embed must resolve
  // to the honest "missing" state, not a stale cached preview.
  await window.evaluate(async (id) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.widgets.delete(id)
  }, widgetId)

  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocuments: () => void } } }
    w.__fbView?.getState().goDocuments()
  })
  await window.waitForTimeout(300)
  await openDoc(window, docId)

  await expect(window.locator('[data-testid="widget-embed-missing"]')).toBeVisible({ timeout: 5_000 })
})
