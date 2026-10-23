/**
 * widgetCaptureUpgrades.spec.ts
 *
 * Exercises three widget improvements shipped together:
 *
 *   1. StickyWidget auto-grow — typing past the visible area enlarges the
 *      widget height (grow-only, capped at 640). Persisted via widgets store.
 *
 *   2. CardWidget full-fill + icon — the accent-popover's "Fill background"
 *      toggle applies an rgba tint to the card root; the icon picker lets the
 *      user stamp an emoji on the title row. Both fields persist as JSON in
 *      widget.content ({bgFill, icon}).
 *
 *   3. MarkdownWidget "Copy as markdown" toolbar button — button exists with
 *      the right title and is clickable without throwing a page error.
 *
 * All tests are hermetic: isolated userData dir, no network, no AI keys.
 */

import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// ---------------------------------------------------------------------------
// Shared lifecycle
// ---------------------------------------------------------------------------

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ---------------------------------------------------------------------------
// Helper: seed a task + widget, reload, open the desk
// ---------------------------------------------------------------------------

async function seedAndOpenDesk(
  l: LaunchedApp,
  kind: string,
  widgetOpts: {
    content: string
    width?: number
    height?: number
  }
): Promise<{ taskId: string; widgetId: string }> {
  const { window } = l
  await waitForReady(window)

  const seeded = await window.evaluate(
    async ({
      kind,
      content,
      width,
      height
    }: {
      kind: string
      content: string
      width: number
      height: number
    }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const task = await api.nodes.create({
        parentId: null,
        kind: 'task',
        title: `Test-${kind}`
      })
      const w = await api.widgets.create({
        taskId: task.id,
        kind: kind as never,
        title: '',
        content,
        x: 100,
        y: 100,
        width,
        height
      })
      return { taskId: task.id, widgetId: w.id }
    },
    {
      kind,
      content: widgetOpts.content,
      width: widgetOpts.width ?? 280,
      height: widgetOpts.height ?? 200
    }
  )

  // Reload so the sidebar tree reflects the new task.
  await window.reload()
  await waitForReady(window)

  // Open the desk by clicking the task card in the sidebar.
  await window.getByRole('button', { name: new RegExp(`Test-${kind}`) }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })

  return seeded
}

// ---------------------------------------------------------------------------
// Helper: re-fetch a widget from the DB via IPC
// ---------------------------------------------------------------------------

async function fetchWidget(
  l: LaunchedApp,
  taskId: string,
  widgetId: string
): Promise<{ height: number; width: number; content: string } | null> {
  return l.window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const all = await api.widgets.listByTask(tid)
      const w = all.find((x) => x.id === wid)
      return w ? { height: w.height, width: w.width, content: w.content } : null
    },
    { tid: taskId, wid: widgetId }
  )
}

// ---------------------------------------------------------------------------
// 1. Sticky auto-grow
// ---------------------------------------------------------------------------

test('sticky widget grows height when text overflows, capped at 640', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  const { taskId, widgetId } = await seedAndOpenDesk(launched, 'sticky', {
    content: 'seed',
    width: 200,
    height: 160
  })

  // Wait for the sticky widget to mount on the canvas.
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 6_000 })

  // Confirm the initial stored height is 160.
  const initial = await fetchWidget(launched, taskId, widgetId)
  expect(initial).not.toBeNull()
  expect(initial!.height).toBe(160)

  // Click into the sticky textarea and type enough lines to overflow the
  // 160px-tall widget. 30 lines is always enough to push scrollHeight >
  // clientHeight in the real renderer.
  // A sticky with text shows its rendered view; one click on it drops into the
  // raw textarea (StickyWidget's edit mode). Only empty stickies start editable.
  await window.locator(`[data-widget-id="${widgetId}"] .fb-sticky-rendered`).click()
  const textarea = window.locator(`[data-widget-id="${widgetId}"] textarea`)
  await expect(textarea).toBeVisible({ timeout: 4_000 })
  await textarea.click()
  // First clear the seed text, then type many newline-separated lines.
  await textarea.fill('')
  const bulkText = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join('\n')
  await textarea.fill(bulkText)

  // The auto-grow effect fires on the `text` state change (useEffect watching
  // [text, widget.height, ...]). Give React + the debounced IPC save time to
  // commit the new height to SQLite. The update debounce is 600 ms.
  await window.waitForFunction(
    async ({ wid, tid }: { wid: string; tid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const all = await api.widgets.listByTask(tid)
      const w = (all as Array<{ id: string; height: number }>).find((x) => x.id === wid)
      return w ? w.height > 160 : false
    },
    { wid: widgetId, tid: taskId },
    { timeout: 5_000 }
  )

  // Read back from DB to confirm persistence.
  const updated = await fetchWidget(launched, taskId, widgetId)
  expect(updated).not.toBeNull()
  expect(updated!.height).toBeGreaterThan(160)
  expect(updated!.height).toBeLessThanOrEqual(640)

  expect(pageErrors).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// 2. Card full-fill + icon
// ---------------------------------------------------------------------------

test('card widget fill toggle sets bgFill=true in persisted content', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  const { taskId, widgetId } = await seedAndOpenDesk(launched, 'card', {
    content: JSON.stringify({ title: 'Hello', body: '', accent: '#6366f1' }),
    width: 280,
    height: 200
  })

  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 6_000 })

  // The accent swatch (Card colour button) is hidden until hover. Use CSS
  // hover on the card root so the button enters the visible opacity window.
  const cardRoot = window.locator(`[data-widget-id="${widgetId}"]`).first()
  await cardRoot.hover()

  // Wait for the colour swatch button to be visible (it uses opacity-0 →
  // group-hover:opacity-100 which Tailwind applies as a CSS class).
  const swatchBtn = window.locator(`[data-widget-id="${widgetId}"] button[aria-label="Card colour"]`)
  await expect(swatchBtn).toBeVisible({ timeout: 4_000 })
  await swatchBtn.click()

  // The fill toggle is inside the now-open popover.
  const fillToggle = window.locator('[data-testid="card-fill-toggle"]')
  await expect(fillToggle).toBeVisible({ timeout: 3_000 })
  await fillToggle.click()

  // After clicking, the button text should include "✓ Fill background".
  await expect(fillToggle).toContainText('✓ Fill background', { timeout: 3_000 })

  // Give the 300 ms debounce time to commit to SQLite.
  await window.waitForTimeout(600)

  // Verify persistence: re-read widget content and parse the JSON.
  const stored = await fetchWidget(launched, taskId, widgetId)
  expect(stored).not.toBeNull()
  const parsed = JSON.parse(stored!.content) as { bgFill?: boolean }
  expect(parsed.bgFill).toBe(true)

  expect(pageErrors).toHaveLength(0)
})

test('card widget icon picker sets an emoji in persisted content', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  const { taskId, widgetId } = await seedAndOpenDesk(launched, 'card', {
    content: JSON.stringify({ title: 'Icon test', body: '', accent: '#6366f1' }),
    width: 280,
    height: 200
  })

  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 6_000 })

  // The icon button is opacity-0 when no icon is set; hover the card to show it.
  const cardRoot = window.locator(`[data-widget-id="${widgetId}"]`).first()
  await cardRoot.hover()

  // Click the icon button (aria-label="Card icon").
  const iconBtn = window.locator(`[data-widget-id="${widgetId}"] [data-testid="card-icon-button"]`)
  await expect(iconBtn).toBeVisible({ timeout: 4_000 })
  await iconBtn.click()

  // The icon picker should now be visible.
  const picker = window.locator('[data-testid="card-icon-picker"]')
  await expect(picker).toBeVisible({ timeout: 3_000 })

  // Click the first emoji in the picker (💡).
  const firstEmoji = picker.locator('button').first()
  const chosenEmoji = await firstEmoji.textContent()
  await firstEmoji.click()

  // The picker should close; give the debounce time to flush.
  await expect(picker).toHaveCount(0, { timeout: 3_000 })
  await window.waitForTimeout(600)

  // Verify the icon button now shows the chosen emoji.
  await expect(iconBtn).toContainText(chosenEmoji ?? '💡', { timeout: 3_000 })

  // Verify persistence.
  const stored = await fetchWidget(launched, taskId, widgetId)
  expect(stored).not.toBeNull()
  const parsed = JSON.parse(stored!.content) as { icon?: string }
  expect(parsed.icon).toBeTruthy()
  expect(parsed.icon).toBe(chosenEmoji)

  expect(pageErrors).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// 3. Markdown "Copy as markdown" button
// ---------------------------------------------------------------------------

test('markdown widget has "Copy as markdown" toolbar button and clicking it causes no page error', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  const { widgetId } = await seedAndOpenDesk(launched, 'markdown', {
    content: '# Hi\n\n- one\n- two',
    width: 400,
    height: 260
  })

  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 6_000 })

  // The "Copy as markdown" button is in the toolbar (title attribute).
  const copyBtn = window
    .locator(`[data-widget-id="${widgetId}"] button[title="Copy as markdown"]`)
    .first()

  await expect(copyBtn).toBeVisible({ timeout: 5_000 })

  // Click it — this calls navigator.clipboard.writeText internally. Electron's
  // test renderer has clipboard access; the important assertion is that the
  // click completes without throwing a page error.
  await copyBtn.click()

  // Brief pause to let any async clipboard write settle.
  await window.waitForTimeout(300)

  // Attempt to read clipboard. navigator.clipboard.readText requires focus
  // and is available in Electron. We treat a read failure as non-fatal (the
  // button existing + no error is the primary assertion).
  let clipboardText: string | null = null
  try {
    clipboardText = await window.evaluate(async () => {
      return navigator.clipboard.readText()
    })
  } catch {
    // readText can throw in some Electron/headless configurations — not fatal.
  }

  if (clipboardText !== null) {
    // If we can read it, assert it contains the heading text.
    expect(clipboardText).toContain('Hi')
  }

  // Primary assertion: no page errors, button was clickable.
  expect(pageErrors).toHaveLength(0)
})
