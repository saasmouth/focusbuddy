import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// The header right-click menu must be genuinely contextual: each widget kind
// surfaces its own action in the Context band, not a single generic spine. We
// seed a color, a table, and a section under one task and confirm each header
// menu shows the action specific to that kind.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seed(l: LaunchedApp): Promise<Record<string, string>> {
  const { window } = l
  await waitForReady(window)
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const t = await api.nodes.create({ parentId: null, kind: 'task', title: 'CtxActionsTest' })
    // A vertical column near the horizontal centre keeps every header clear of
    // the right-hand chrome panel once the canvas auto-fits.
    const mk = (kind: string, content: string, y: number) =>
      api.widgets.create({ taskId: t.id, kind: kind as never, title: '', content, x: 200, y, width: 220, height: 200 })
    const color = await mk('color', '#ff8800', 120)
    const table = await mk('table', '', 420)
    const section = await mk('section', '', 720)
    return { color: color.id, table: table.id, section: section.id }
  })
}

async function openTask(l: LaunchedApp): Promise<void> {
  const { window } = l
  await waitForReady(window)
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /CtxActionsTest/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
}

async function headerMenuText(l: LaunchedApp, widgetId: string): Promise<string> {
  const { window } = l
  await waitForReady(window)
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 8_000 })
  await window.click(`[data-widget-id="${widgetId}"]`, { button: 'right', position: { x: 110, y: 8 } })
  await window.waitForSelector('[data-canvas-ctx-menu]', { timeout: 4_000 })
  const text = await window.evaluate(
    () => (document.querySelector('[data-canvas-ctx-menu]') as HTMLElement)?.innerText ?? ''
  )
  // Close before the next assertion so menus don't stack.
  await window.keyboard.press('Escape')
  await window.waitForSelector('[data-canvas-ctx-menu]', { state: 'detached', timeout: 4_000 }).catch(() => {})
  return text
}

test('WCA-1 — each widget header menu surfaces its kind-specific action', async () => {
  launched = await launchApp()
  const ids = await seed(launched)
  await openTask(launched)

  const colorText = await headerMenuText(launched, ids.color)
  console.log('[WCA-1] color menu:', JSON.stringify(colorText))
  expect(colorText).toContain('Copy #ff8800')

  const tableText = await headerMenuText(launched, ids.table)
  console.log('[WCA-1] table menu:', JSON.stringify(tableText))
  expect(tableText).toContain('Add row')
  // Proof of contextuality: the table menu is NOT the color menu.
  expect(tableText).not.toContain('Copy #ff8800')

  const sectionText = await headerMenuText(launched, ids.section)
  console.log('[WCA-1] section menu:', JSON.stringify(sectionText))
  expect(sectionText).toContain('Section layout')
  expect(sectionText).not.toContain('Add row')
})
