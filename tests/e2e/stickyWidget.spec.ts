import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Sticky widget — rendered view, edit mode, checklist persistence, bold
// round-trip, toolbar actions. All tests use an isolated hermetic userData
// directory (no operator DB touched).

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// Boot the app, create a task + sticky widget with the given initial content,
// reload so the DB row is definitely flushed, then navigate to the task canvas.
// Returns { taskId, widgetId }.
async function seedStickyWidget(
  l: LaunchedApp,
  initialContent: string
): Promise<{ taskId: string; widgetId: string }> {
  const { window } = l
  await waitForReady(window)

  const seeded = await window.evaluate(
    async ({ content }: { content: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const t = await api.nodes.create({ parentId: null, kind: 'task', title: 'StickyTest' })
      const w = await api.widgets.create({
        taskId: t.id,
        kind: 'sticky',
        title: '',
        content,
        x: 100,
        y: 100,
        width: 300,
        height: 240
      })
      return { taskId: t.id, widgetId: w.id }
    },
    { content: initialContent }
  )

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /StickyTest/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForSelector(`[data-widget-id="${seeded.widgetId}"]`, { timeout: 6_000 })

  return seeded
}

// Read widget.content directly from the store/DB via the IPC api.
async function readContent(
  l: LaunchedApp,
  taskId: string,
  widgetId: string
): Promise<string> {
  return l.window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const all = await api.widgets.listByTask(tid)
      return all.find((w) => w.id === wid)?.content ?? '__NOT_FOUND__'
    },
    { tid: taskId, wid: widgetId }
  )
}

// ─── A: Checklist persistence ─────────────────────────────────────────────────

test('A — checklist persistence: tick two lines and verify content before and after reload', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const initialContent = '[ ] one\n[ ] two\n[ ] three'
  const { taskId, widgetId } = await seedStickyWidget(launched, initialContent)

  // Confirm the rendered view shows three checkboxes (lines 0, 1, 2).
  const check0 = window.locator(`[data-widget-id="${widgetId}"] [data-testid="sticky-check-0"]`)
  const check1 = window.locator(`[data-widget-id="${widgetId}"] [data-testid="sticky-check-1"]`)
  const check2 = window.locator(`[data-widget-id="${widgetId}"] [data-testid="sticky-check-2"]`)

  await expect(check0).toBeVisible({ timeout: 4_000 })
  await expect(check1).toBeVisible({ timeout: 2_000 })
  await expect(check2).toBeVisible({ timeout: 2_000 })

  // Tick lines at index 1 and 2.
  await check1.click()
  await check2.click()

  // Wait for the 600 ms debounce to flush the save to DB.
  await window.waitForTimeout(900)

  // Read content back from the DB before reload.
  const contentBeforeReload = await readContent(launched, taskId, widgetId)
  console.log('[A] content before reload:', JSON.stringify(contentBeforeReload))
  expect(contentBeforeReload).toBe('[ ] one\n[x] two\n[x] three')

  // Reload and re-navigate to exercise persistence through the DB round-trip.
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /StickyTest/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 6_000 })

  const contentAfterReload = await readContent(launched, taskId, widgetId)
  console.log('[A] content after reload:', JSON.stringify(contentAfterReload))
  expect(contentAfterReload).toBe('[ ] one\n[x] two\n[x] three')

  // The two ticked checkboxes remain ticked in the rendered view (check_box icon,
  // which we confirm via aria-label "Mark not done" on the ticked buttons).
  const tickedCount = await window.evaluate(
    (wid: string) =>
      document.querySelectorAll(
        `[data-widget-id="${wid}"] [data-sticky-check][aria-label="Mark not done"]`
      ).length,
    widgetId
  )
  console.log('[A] ticked checkbox count after reload:', tickedCount)
  expect(tickedCount).toBe(2)
})

// ─── B: Bold round-trip ────────────────────────────────────────────────────────

test('B — bold round-trip: **Friday** renders as <strong> and survives reload', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const { taskId, widgetId } = await seedStickyWidget(
    launched,
    'deadline **Friday** noon'
  )

  // Rendered view should show a <strong> element containing "Friday".
  const strongLocator = window.locator(`[data-widget-id="${widgetId}"] .fb-sticky-rendered strong`)
  await expect(strongLocator).toBeVisible({ timeout: 4_000 })
  const strongText = await strongLocator.textContent()
  console.log('[B] <strong> text content:', JSON.stringify(strongText))
  expect(strongText).toBe('Friday')

  // Content in DB still has the raw **Friday** markers.
  const contentBefore = await readContent(launched, taskId, widgetId)
  console.log('[B] content before reload:', JSON.stringify(contentBefore))
  expect(contentBefore).toContain('**Friday**')

  // Reload and re-check.
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /StickyTest/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 6_000 })

  const contentAfter = await readContent(launched, taskId, widgetId)
  console.log('[B] content after reload:', JSON.stringify(contentAfter))
  expect(contentAfter).toContain('**Friday**')

  // Bold still visible in rendered view.
  const strongAfter = window.locator(`[data-widget-id="${widgetId}"] .fb-sticky-rendered strong`)
  await expect(strongAfter).toBeVisible({ timeout: 4_000 })
  const strongTextAfter = await strongAfter.textContent()
  expect(strongTextAfter).toBe('Friday')
})

// ─── C: Edit toggle ────────────────────────────────────────────────────────────

test('C — edit toggle: click rendered text enters edit mode; blur returns to rendered; checkbox click does not enter edit mode', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  // Seed a note with a checklist line plus plain text so we have both surfaces.
  const { widgetId } = await seedStickyWidget(launched, '[ ] task one\nsome plain text')

  // Rendered view is shown initially (textarea is absent, rendered div present).
  const renderedDiv = window.locator(`[data-widget-id="${widgetId}"] .fb-sticky-rendered`)
  const textarea = window.locator(`[data-widget-id="${widgetId}"] .fb-sticky-textarea`)

  await expect(renderedDiv).toBeVisible({ timeout: 4_000 })
  await expect(textarea).not.toBeVisible()

  // Clicking the rendered note text (not a checkbox) enters edit mode.
  // The plain text line is a safe click target away from the checkbox.
  await renderedDiv.click()
  await expect(textarea).toBeVisible({ timeout: 3_000 })
  console.log('[C] textarea visible after clicking rendered text: true')

  // Blur the textarea to return to rendered view.
  await textarea.blur()
  await expect(renderedDiv).toBeVisible({ timeout: 3_000 })
  await expect(textarea).not.toBeVisible()
  console.log('[C] rendered view restored after blur: true')

  // Clicking a checkbox does NOT enter edit mode.
  const check0 = window.locator(`[data-widget-id="${widgetId}"] [data-testid="sticky-check-0"]`)
  await expect(check0).toBeVisible({ timeout: 2_000 })
  await check0.click()

  // Textarea must remain absent after the checkbox click.
  await window.waitForTimeout(300)
  const editingAfterCheckbox = await textarea.isVisible()
  console.log('[C] textarea visible after checkbox click (must be false):', editingAfterCheckbox)
  expect(editingAfterCheckbox).toBe(false)
})

// ─── D: Toolbar checklist toggle ──────────────────────────────────────────────

test('D — toolbar checklist toggle converts plain lines to checkboxes and back', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  // Seed an empty sticky so it starts in edit mode; type two lines.
  const { taskId, widgetId } = await seedStickyWidget(launched, '')

  // Empty sticky starts in edit mode. Type two plain lines.
  const textarea = window.locator(`[data-widget-id="${widgetId}"] .fb-sticky-textarea`)
  await expect(textarea).toBeVisible({ timeout: 4_000 })
  await textarea.click()
  await textarea.fill('alpha\nbeta')

  // Wait for the 600 ms debounce to settle.
  await window.waitForTimeout(900)

  // Click the checklist toolbar button.
  const checklistBtn = window.locator(`[data-widget-id="${widgetId}"] [data-testid="sticky-checklist"]`)
  await expect(checklistBtn).toBeVisible({ timeout: 3_000 })
  await checklistBtn.click()

  await window.waitForTimeout(900)

  // Content should now be "[ ] alpha\n[ ] beta".
  const afterToggleOn = await readContent(launched, taskId, widgetId)
  console.log('[D] content after toggle ON:', JSON.stringify(afterToggleOn))
  expect(afterToggleOn).toBe('[ ] alpha\n[ ] beta')

  // Click checklist button again to strip checkboxes.
  await checklistBtn.click()
  await window.waitForTimeout(900)

  const afterToggleOff = await readContent(launched, taskId, widgetId)
  console.log('[D] content after toggle OFF:', JSON.stringify(afterToggleOff))
  expect(afterToggleOff).toBe('alpha\nbeta')
})
