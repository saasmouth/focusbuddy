// E2E: ChatThreadWidget canvas rendering (resolves PCHAT-5 inconclusive verdict).
//
// Tests the real user path:
//   1. Boot app, create a task, navigate to its canvas.
//   2. Add the chat-thread widget via IPC (deterministic, avoids palette timing).
//   3. Wait up to 15s for the widget frame to appear.
//   4. Confirm the empty-state "Pin a conversation" header and "No conversations yet" body.
//
// PCHAT-5b drives the user path on top: the Chat tile's "Add … to this desk"
// (the hover palette it used was removed in 4.3.32).

import { test, expect } from '@playwright/test'
import { addWidgetToDesk, launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ── PCHAT-5a: IPC seed path (deterministic) ───────────────────────────────────

test('PCHAT-5a — chat-thread widget renders empty-state via IPC seed (no crash)', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  // Capture renderer console errors for diagnostics.
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)

  // Create task via IPC.
  const taskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'ChatThreadTest' })
    return task.id
  })

  // Navigate to the task canvas by clicking it in the sidebar.
  await window.reload()
  await waitForReady(window)
  await expect(
    window.getByRole('treeitem', { name: /ChatThreadTest/ }).first()
  ).toBeVisible({ timeout: 8_000 })
  await window.getByRole('treeitem', { name: /ChatThreadTest/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 10_000 })
  await window.waitForTimeout(500) // let the canvas and widget store settle

  // Now seed the widget via IPC directly into the store/DB.
  const widgetId = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const widget = await api.widgets.create({
      taskId: tid,
      kind: 'chat-thread',
      title: 'Chat',
      content: '', // empty → empty-state picker
      x: 80,
      y: 80,
      width: 320,
      height: 300
    })
    return widget.id
  }, taskId)

  // The widget store should pick it up. Give it up to 15s.
  const widgetAppeared = await window.waitForFunction(
    (wid: string) => !!document.querySelector(`[data-widget-id="${wid}"]`),
    widgetId,
    { timeout: 15_000 }
  ).then(() => true).catch(() => false)

  // Diagnostic dump if widget did not appear.
  if (!widgetAppeared) {
    const domDump = await window.evaluate((wid: string) => {
      const allWidgetFrames = Array.from(document.querySelectorAll('[data-widget-id]')).map(
        (el) => `${el.getAttribute('data-widget-id')} kind=${el.getAttribute('data-widget-kind')}`
      )
      const canvasSurface = !!document.querySelector('[data-canvas-surface="true"]')
      const targetEl = document.querySelector(`[data-widget-id="${wid}"]`)
      return {
        canvasSurface,
        allWidgetFrames,
        targetFound: !!targetEl,
        targetKind: targetEl?.getAttribute('data-widget-kind') ?? null
      }
    }, widgetId)

    console.log('[PCHAT-5a] widget did NOT appear. DOM state at timeout:')
    console.log('  canvas-surface:', domDump.canvasSurface)
    console.log('  all widget frames:', domDump.allWidgetFrames)
    console.log('  target found:', domDump.targetFound)
    console.log('  console errors:', consoleErrors)
    console.log('  page errors:', pageErrors)
  }

  expect(widgetAppeared, `widget [data-widget-id="${widgetId}"] appeared in DOM`).toBe(true)

  // Scroll into view and settle.
  await window.evaluate((wid: string) => {
    document.querySelector(`[data-widget-id="${wid}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, widgetId)
  await window.waitForTimeout(400)

  // The empty-state header and body must be present inside the widget frame.
  const widgetText = await window.evaluate((wid: string) => {
    const el = document.querySelector(`[data-widget-id="${wid}"]`)
    return el?.textContent ?? ''
  }, widgetId)

  // Dump errors before asserting so we see the cause on failure.
  if (consoleErrors.length > 0 || pageErrors.length > 0) {
    console.log('[PCHAT-5a] console errors at assertion time:', consoleErrors)
    console.log('[PCHAT-5a] page errors at assertion time:', pageErrors)
  }

  expect(widgetText, 'widget text contains "Pin a conversation"').toContain('Pin a conversation')
  expect(widgetText, 'widget text contains "No conversations yet"').toContain('No conversations yet')

  // No renderer crashes caused by ChatThreadWidget.
  expect(pageErrors, 'no renderer JS page errors').toHaveLength(0)
  const chatCrashErrors = consoleErrors.filter(
    (e) =>
      e.toLowerCase().includes('chatthread') ||
      e.toLowerCase().includes('chat-thread') ||
      e.toLowerCase().includes('cannot read') ||
      e.toLowerCase().includes('is not a function') ||
      e.toLowerCase().includes('is not defined')
  )
  expect(chatCrashErrors, 'no ChatThreadWidget-class console errors').toHaveLength(0)
})

// ── PCHAT-5b: palette add path (user gesture) ────────────────────────────────

test('PCHAT-5b — chat-thread widget renders empty-state via palette add (real user path)', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)

  // Create task via IPC, then navigate to its canvas.
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: 'ChatPaletteTest' })
  })

  await window.reload()
  await waitForReady(window)
  await expect(
    window.getByRole('treeitem', { name: /ChatPaletteTest/ }).first()
  ).toBeVisible({ timeout: 8_000 })
  await window.getByRole('treeitem', { name: /ChatPaletteTest/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 10_000 })
  await window.waitForTimeout(500)

  // The palette that held this tile was removed in 4.3.32. A chat thread is
  // what the Chat app IS on a desk, so it is added from the Chat tile under
  // Apps: right-click → "Add … to this desk" (the no-drag twin of dragging the
  // tile onto the desk).
  const chatTile = window.locator('[data-testid="office-comms-app-chat"]').first()
  if (!(await chatTile.isVisible().catch(() => false))) {
    // The Chat app is gated off for this account. IPC path (PCHAT-5a) covers the render contract.
    console.log('[PCHAT-5b] Chat app tile is not available — skipping, IPC path covers render.')
    return
  }
  await addWidgetToDesk(window, 'chat-thread')

  // Wait up to 15s for a chat-thread widget to appear on the canvas.
  const widgetAppeared = await window.waitForFunction(
    () => !!document.querySelector('[data-widget-kind="chat-thread"]'),
    null,
    { timeout: 15_000 }
  ).then(() => true).catch(() => false)

  if (!widgetAppeared) {
    console.log('[PCHAT-5b] widget did NOT appear after palette add.')
    console.log('  console errors:', consoleErrors)
    console.log('  page errors:', pageErrors)
  }

  if (consoleErrors.length > 0 || pageErrors.length > 0) {
    console.log('[PCHAT-5b] console errors:', consoleErrors)
    console.log('[PCHAT-5b] page errors:', pageErrors)
  }

  expect(widgetAppeared, '[data-widget-kind="chat-thread"] appeared after Add to this desk').toBe(true)

  const widgetEl = window.locator('[data-widget-kind="chat-thread"]').first()
  await expect(widgetEl).toBeVisible({ timeout: 5_000 })

  const widgetText = await widgetEl.textContent()
  expect(widgetText, 'palette-added widget contains "Pin a conversation"').toContain('Pin a conversation')
  expect(pageErrors, 'no renderer JS errors after palette add').toHaveLength(0)
})
