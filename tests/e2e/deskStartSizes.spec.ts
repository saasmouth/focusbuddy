/**
 * deskStartSizes.spec.ts: the owner's starting-sizes standard, in the running app.
 *
 * DSS-1  Added from the side menu: the standard size, as stored.
 * DSS-2  Made with no size, the way an agent or MCP does it: the standard too.
 * DSS-3  Cells, Deck and Design start with their AI panel closed on a desk.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, openNewDesk, addWidgetToDesk, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

type Row = { kind: string; width: number; height: number }

const stored = (window: Page, deskId: string): Promise<Row[]> =>
  window.evaluate(async (id) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.widgets.listByTask(id)).map((w) => ({ kind: w.kind, width: w.width, height: w.height }))
  }, deskId)

test('DSS-1: a work widget added from the side menu starts at the standard size', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const deskId = await openNewDesk(window, 'Starting sizes')
  const want: Record<string, [number, number]> = {
    sticky: [200, 200],
    note: [420, 420],
    timer: [200, 300],
    table: [740, 440]
  }
  for (const kind of Object.keys(want)) await addWidgetToDesk(window, kind)
  const rows = await stored(window, deskId)
  for (const [kind, [width, height]] of Object.entries(want)) {
    expect(rows.find((r) => r.kind === kind), kind).toMatchObject({ width, height })
  }
})

test('DSS-2: a widget made with no size starts at the standard, not a guess', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const deskId = await openNewDesk(window, 'No size given')
  const made = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const out: Array<{ kind: string; width: number; height: number }> = []
    for (const kind of ['note', 'webview', 'living-doc', 'task-list'] as const) {
      const w = await api.widgets.create({ taskId: id, kind, title: kind, content: '' })
      out.push({ kind: w.kind, width: w.width, height: w.height })
    }
    return out
  }, deskId)
  expect(made).toEqual([
    { kind: 'note', width: 420, height: 420 },
    { kind: 'webview', width: 1060, height: 600 },
    { kind: 'living-doc', width: 520, height: 420 },
    { kind: 'task-list', width: 420, height: 380 }
  ])
})

test('DSS-3: Cells, Deck and Design start with their AI panel closed on a desk', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const deskId = await openNewDesk(window, 'Apps on a desk')
  await window.evaluate(async (id) => {
    const api = (window as unknown as { api: typeof window.api }).api
    let x = 40
    for (const [kind, width, height] of [
      ['sheet', 960, 620],
      ['slides', 960, 620],
      ['design', 740, 560]
    ] as const) {
      const doc = await api.documents.create({ docType: kind, title: `${kind} on a desk` })
      await api.widgets.create({ taskId: id, kind, title: doc.title, content: doc.id, x, y: 40, width, height })
      x += width + 40
    }
  }, deskId)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((i) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
    w.__fbView?.getState().goTask(i)
  }, deskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 10_000 })

  // Cells: the toggle offers to show it.
  await expect(window.locator('[data-testid="sheet-ai-toggle"]').first()).toHaveAttribute(
    'aria-label',
    'Show PlexiiAssist',
    { timeout: 15_000 }
  )
  // Deck: the assistant pane is not on screen.
  await expect(window.locator('[data-testid="slides-side-panel"]').first()).toBeAttached({ timeout: 15_000 })
  await expect(window.locator('[data-testid="slides-ai-assistant"]')).toHaveCount(0)
  // Design: its toggle offers to show the side pane.
  await expect(window.getByRole('button', { name: 'Show the side pane' }).first()).toBeAttached({ timeout: 15_000 })
})
