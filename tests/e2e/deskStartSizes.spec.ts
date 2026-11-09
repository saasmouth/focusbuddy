/**
 * deskStartSizes.spec.ts: the owner's starting-sizes standard, in the running app.
 *
 * DSS-1  Added from the side menu: the standard size, as stored.
 * DSS-2  Made with no size, the way an agent or MCP does it: the standard too.
 * DSS-3 to 5  Cells, Deck and Design start with their AI panel closed on a desk.
 * DSS-6  Added with no spot chosen: each takes its place in the view.
 * DSS-7  Made with no position, the way an agent or MCP does it: the same places.
 * DSS-8  The "Set up with AI" chip keeps clear of every control it could cover.
 * DSS-9  The minimap panel is 220 x 160.
 * DSS-10 A new Home opens with its cards at the standard sizes.
 * DSS-11 Build with AI lays a desk out by the same zones (the AI reply is stubbed).
 * DSS-12 A new empty Section stands at the standard size.
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

// Each on a desk of its own, in view: a widget off-screen does not mount its body.
async function openAppOnDesk(window: Page, kind: 'sheet' | 'slides' | 'design', width: number, height: number): Promise<void> {
  const deskId = await openNewDesk(window, `${kind} on a desk`)
  await window.evaluate(
    async ({ id, kind, width, height }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const doc = await api.documents.create({ docType: kind, title: `${kind} doc` })
      await api.widgets.create({ taskId: id, kind, title: doc.title, content: doc.id, x: 40, y: 40, width, height })
    },
    { id: deskId, kind, width, height }
  )
  await window.reload()
  await waitForReady(window)
  await window.evaluate((i) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
    w.__fbView?.getState().goTask(i)
  }, deskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 10_000 })
}

test('DSS-3: Cells starts with its AI panel closed on a desk', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openAppOnDesk(window, 'sheet', 960, 620)
  await expect(window.locator('[data-testid="sheet-ai-toggle"]').first()).toHaveAttribute(
    'aria-label',
    'Show PlexiiAssist',
    { timeout: 15_000 }
  )
})

test('DSS-4: Deck starts with its AI panel closed on a desk', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openAppOnDesk(window, 'slides', 960, 620)
  await expect(window.locator('[data-testid="slides-shell"]').first()).toBeAttached({ timeout: 15_000 })
  await expect(window.locator('[data-testid="slides-ai-assistant"]')).toHaveCount(0)
})

test('DSS-5: Design starts with its AI panel closed on a desk', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openAppOnDesk(window, 'design', 740, 560)
  await expect(window.getByRole('button', { name: 'Show the side pane' }).first()).toBeAttached({ timeout: 15_000 })
})

type Placed = { kind: string; x: number; y: number; width: number; height: number }

const placed = (window: Page): Promise<Placed[]> =>
  window.evaluate(() => {
    const s = (window as unknown as { __fbWidgets: { getState: () => { widgets: Placed[] } } }).__fbWidgets.getState()
    return s.widgets.map(({ kind, x, y, width, height }) => ({ kind, x, y, width, height }))
  })

// The part of the desk you can actually see: the side menu floats over its left edge.
const viewNow = (window: Page): Promise<{ left: number; top: number; right: number; bottom: number }> =>
  window.evaluate(() => {
    const s = (window as unknown as { __fbWidgets: { getState: () => { panX: number; panY: number; zoom: number } } }).__fbWidgets.getState()
    const r = document.querySelector('[data-canvas-surface="true"]')!.getBoundingClientRect()
    const menu = document.querySelector('[data-testid="desk-sidebar"], [data-testid="desk-sidebar-collapsed"]')!.getBoundingClientRect()
    const toCanvas = (px: number): number => (px - s.panX) / s.zoom
    const top = (r.top - r.top - s.panY) / s.zoom
    return { left: toCanvas(menu.right), top, right: toCanvas(r.right), bottom: top + r.height / s.zoom }
  })

const clash = (a: Placed, b: Placed): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

test('DSS-6: added with no spot chosen, each takes its place in the view', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openNewDesk(window, 'Best placement')
  await addWidgetToDesk(window, 'table')
  await addWidgetToDesk(window, 'task-list')
  await addWidgetToDesk(window, 'sticky')
  const rows = await placed(window)
  const view = await viewNow(window)
  const of = (kind: string): Placed => rows.find((r) => r.kind === kind)!
  // The main stage: at the left edge, top of the view.
  expect(of('table').x - view.left, JSON.stringify({ rows, view })).toBeLessThanOrEqual(40)
  expect(of('table').y - view.top).toBeLessThanOrEqual(40)
  // The right rail: against the right edge.
  expect(view.right - (of('task-list').x + of('task-list').width), JSON.stringify({ rows, view })).toBeLessThanOrEqual(40)
  // Everything inside the view and clear of everything else.
  for (const r of rows) {
    expect(r.x, r.kind).toBeGreaterThanOrEqual(view.left)
    expect(r.y, r.kind).toBeGreaterThanOrEqual(view.top)
    expect(r.x + r.width, r.kind).toBeLessThanOrEqual(view.right)
    expect(r.y + r.height, r.kind).toBeLessThanOrEqual(view.bottom)
  }
  rows.forEach((a, i) => rows.slice(i + 1).forEach((b) => expect(clash(a, b), `${a.kind} on ${b.kind}`).toBe(false)))
})

test('DSS-7: made with no position, each takes its place on the desk; a position given is kept', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const deskId = await openNewDesk(window, 'Agent placement')
  const made = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const out: Array<{ kind: string; x: number; y: number }> = []
    for (const kind of ['table', 'inbox', 'sticky'] as const) {
      const w = await api.widgets.create({ taskId: id, kind, title: kind, content: '' })
      out.push({ kind: w.kind, x: w.x, y: w.y })
    }
    const kept = await api.widgets.create({ taskId: id, kind: 'note', title: 'n', content: '', x: 333, y: 444 })
    out.push({ kind: kept.kind, x: kept.x, y: kept.y })
    return out
  }, deskId)
  expect(made).toEqual([
    { kind: 'table', x: 20, y: 20 },
    { kind: 'inbox', x: 880, y: 20 },
    { kind: 'sticky', x: 1100, y: 460 },
    { kind: 'note', x: 333, y: 444 }
  ])
})

test('DSS-8: the Set up with AI chip keeps clear of every control it could cover', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const deskId = await openNewDesk(window, 'Chip')
  const kinds = ['calculator', 'color', 'voice-recorder', 'file', 'webhook', 'inbound-hook', 'task-link', 'card', 'sticky', 'note'] as const
  const ids = await window.evaluate(
    async ({ id, kinds }) => {
      const s = (window as unknown as { __fbWidgets: { getState: () => { create: (d: object) => Promise<{ id: string }> } } }).__fbWidgets.getState()
      const out: Record<string, string> = {}
      let x = 20
      let y = 20
      for (const kind of kinds) {
        out[kind] = (await s.create({ taskId: id, kind, content: '', x, y, width: 300, height: 240 })).id
        x += 320
        if (x > 1000) {
          x = 20
          y += 260
        }
      }
      return out
    },
    { id: deskId, kinds }
  )
  await window.waitForTimeout(800)
  const read = (id: string): Promise<{ slot: string | null; hits: string[] }> =>
    window.evaluate((i) => {
      const frame = document.querySelector(`[data-widget-id="${i}"]`)
      const overlay = frame?.querySelector<HTMLElement>('[data-setup-chip-slot]') ?? null
      if (!overlay) return { slot: null, hits: [] }
      const chip = overlay.querySelector('button')!.getBoundingClientRect()
      const body = frame!.querySelector('[data-widget-body]')!
      const hits = Array.from(body.querySelectorAll<HTMLElement>('button,[role="button"],select,input:not([type="hidden"]),a[href]'))
        .filter((el) => !overlay.contains(el))
        .filter((el) => {
          const r = el.getBoundingClientRect()
          const whole = body.getBoundingClientRect()
          return (
            r.width > 0 &&
            r.width * r.height < whole.width * whole.height * 0.5 &&
            r.left < chip.right && chip.left < r.right && r.top < chip.bottom && chip.top < r.bottom
          )
        })
        .map((el) => el.getAttribute('aria-label') || el.textContent || el.tagName)
      return { slot: overlay.getAttribute('data-setup-chip-slot'), hits }
    }, id)
  // Nothing to set up on these, so no chip at all.
  expect((await read(ids.calculator)).slot).toBeNull()
  expect((await read(ids.color)).slot).toBeNull()
  // Still offered where there is something to set up.
  expect((await read(ids.note)).slot).toBe('bottom')
  for (const kind of kinds) {
    const got = await read(ids[kind])
    if (got.slot === 'none') continue
    expect(got.hits, `${kind} chip (${got.slot}) covers a control`).toEqual([])
  }
})

test('DSS-9: the minimap panel opens at the standard size', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openNewDesk(window, 'Minimap')
  await addWidgetToDesk(window, 'sticky')
  await window.locator('[data-testid="minimap-fab-toggle"]').click()
  const panel = window.locator('[data-testid="minimap-fab-panel"]')
  await expect(panel).toBeVisible()
  await expect
    .poll(async () => {
      const b = await panel.boundingBox()
      return b ? [Math.round(b.width), Math.round(b.height)] : null
    })
    .toEqual([220, 160])
})

test('DSS-10: a new Home opens with its cards at the standard sizes', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(() => {
    ;(window as unknown as { __fbView: { getState: () => { goHome: () => void } } }).__fbView.getState().goHome()
  })
  await expect(window.locator('[data-testid="home-widget-grid"]')).toBeVisible({ timeout: 20_000 })
  await window.waitForTimeout(500)
  const box = async (kind: string): Promise<{ width: number; height: number }> => {
    const b = await window.locator(`[data-widget-kind="${kind}"]`).first().boundingBox()
    expect(b, `${kind} is on the new Home`).not.toBeNull()
    return b!
  }
  const pulse = await box('pulse')
  const agenda = await box('agenda')
  const activity = await box('activity')
  const quick = await box('quick')
  expect(Math.abs(agenda.width - pulse.width)).toBeLessThanOrEqual(2)
  expect(agenda.height).toBeGreaterThan(pulse.height * 1.9)
  expect(activity.height).toBeGreaterThan(pulse.height * 1.9)
  expect(quick.width).toBeGreaterThan(pulse.width * 1.9)
  expect(Math.abs(quick.height - pulse.height)).toBeLessThanOrEqual(2)
})

test('DSS-11: Build with AI lays a desk out by zone', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await window.evaluate(() =>
    (window as unknown as { api: { ai: { setMode: (m: string) => Promise<unknown> } } }).api.ai.setMode('cloud')
  )
  // A test stub for the model's reply, in the listed order that a plain row would use.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('setup:buildFromPrompt')
    ipcMain.handle('setup:buildFromPrompt', async () => ({
      ok: true,
      suggestions: [
        { id: 'a', kind: 'sticky', title: 'Reminder', reason: 'test', content: 'Test sticky' },
        { id: 'b', kind: 'note', title: 'Notes', reason: 'test', content: 'Test note' },
        { id: 'c', kind: 'inbox', title: 'Mail', reason: 'test', content: '' },
        { id: 'd', kind: 'table', title: 'Tracker', reason: 'test', content: '' }
      ]
    }))
  })
  await openNewDesk(window, 'Built by AI')
  await window.locator('[data-testid="pill-build"]').first().click()
  await expect(window.getByRole('heading', { name: 'Build with AI' })).toBeVisible({ timeout: 6_000 })
  await window.locator('textarea').first().fill('Track my clients')
  await window.getByRole('button', { name: /Generate/ }).click()
  await window.getByRole('button', { name: /Add 4 to canvas/ }).click()
  await expect.poll(async () => (await placed(window)).length, { timeout: 8_000 }).toBe(4)
  const rows = await placed(window)
  const of = (kind: string): Placed => rows.find((r) => r.kind === kind)!
  const view = await window.evaluate(() => {
    const s = (window as unknown as { __fbWidgets: { getState: () => { zoom: number } } }).__fbWidgets.getState()
    const r = document.querySelector('[data-canvas-surface="true"]')!.getBoundingClientRect()
    const menu = document.querySelector('[data-testid="desk-sidebar"], [data-testid="desk-sidebar-collapsed"]')!.getBoundingClientRect()
    return (r.width - menu.right) / s.zoom
  })
  const info = JSON.stringify({ rows, view })
  // The table claims the main stage though the model listed it last.
  expect({ x: of('table').x, y: of('table').y }, info).toEqual({ x: 60, y: 60 })
  // The note reads beside it.
  expect(of('note').x, info).toBe(820)
  expect(of('note').y, info).toBe(60)
  // The mail list keeps to the right edge of what you can see.
  expect(Math.abs(40 + view - (of('inbox').x + of('inbox').width)), info).toBeLessThanOrEqual(60)
  // Nothing runs off the right, and the sticky the model listed first did not take the top left.
  for (const r of rows) expect(r.x + r.width, `${r.kind} ${info}`).toBeLessThanOrEqual(40 + view)
  expect(of('sticky').x, info).toBeGreaterThan(60)
  rows.forEach((a, i) => rows.slice(i + 1).forEach((b) => expect(clash(a, b), `${a.kind} on ${b.kind}`).toBe(false)))
})

test('DSS-12: a new empty Section stands at the standard size', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const deskId = await openNewDesk(window, 'Empty section')
  const id = await window.evaluate(async (desk) => {
    const s = (window as unknown as { __fbWidgets: { getState: () => { create: (d: object) => Promise<{ id: string }> } } }).__fbWidgets.getState()
    return (await s.create({ taskId: desk, kind: 'section', title: 'Group', content: '', x: 40, y: 40, width: 740, height: 340 })).id
  }, deskId)
  const frame = window.locator(`[data-widget-id="${id}"]`)
  await expect(frame).toBeVisible()
  const zoom = await window.evaluate(() => (window as unknown as { __fbWidgets: { getState: () => { zoom: number } } }).__fbWidgets.getState().zoom)
  await expect
    .poll(async () => {
      const b = await frame.boundingBox()
      return b ? [Math.round(b.width / zoom), Math.round(b.height / zoom)] : null
    })
    .toEqual([740, 340])
})
