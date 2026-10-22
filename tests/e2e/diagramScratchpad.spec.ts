import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// diagramScratchpad.spec.ts
//
// Verifies the two new widget kinds — 'diagram' and 'scratchpad' — mount,
// render their UI, and persist content to the DB.
//
// Both widgets are created directly via window.api.widgets.create (bypassing
// the palette gate entirely) so the Pro gating on 'diagram' doesn't block the
// test on a free account.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ── shared helpers ─────────────────────────────────────────────────────────

/** Boot app + dismiss modal, returns the first window. */
async function boot(l: LaunchedApp): Promise<void> {
  const { window } = l
  await waitForReady(window)
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})
}

async function seedWidget(
  l: LaunchedApp,
  kind: 'diagram' | 'scratchpad',
  content = ''
): Promise<{ taskId: string; widgetId: string }> {
  const { window } = l
  await waitForReady(window)
  const seeded = await window.evaluate(
    async ({ k, c }: { k: string; c: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const task = await api.nodes.create({
        parentId: null,
        kind: 'task',
        title: `${k} test`
      })
      const w = await api.widgets.create({
        taskId: task.id,
        kind: k as 'diagram' | 'scratchpad',
        title: '',
        content: c,
        x: 100,
        y: 100,
        width: 760,
        height: 520,
        color: null
      })
      return { taskId: task.id, widgetId: w.id }
    },
    { k: kind, c: content }
  )

  // Reload → navigate to the task so the canvas mounts.
  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip2.isVisible().catch(() => false)) await skip2.click().catch(() => {})

  await window.getByRole('button', { name: `${kind} test` }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  return seeded
}

// ── BOOT: no uncaught renderer errors ─────────────────────────────────────

test('BOOT: app boots with no uncaught renderer errors', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  await boot(launched)
  // Give the app a moment to settle.
  await window.waitForTimeout(500)
  expect(errors).toHaveLength(0)
})

// ── DIAGRAM ────────────────────────────────────────────────────────────────

test('DIAGRAM: React Flow canvas mounts with toolbar and no console errors', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await boot(launched)
  await seedWidget(launched, 'diagram')

  // The React Flow container must be present in the DOM.
  await window.waitForSelector('.react-flow', { timeout: 8_000 })
  const rfVisible = await window.locator('.react-flow').first().isVisible()
  expect(rfVisible).toBe(true)

  // Toolbar buttons: Box, Circle, Text, Image.
  const toolbar = window.locator('[title="Add Box"]')
  await expect(toolbar.first()).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[title="Add Circle / Venn"]').first()).toBeVisible()
  await expect(window.locator('[title="Add Text"]').first()).toBeVisible()
  await expect(window.locator('[title="Add an image / icon node (upload)"]').first()).toBeVisible()

  // No uncaught page errors (covers ReactFlowProvider missing, process-not-defined, etc.)
  expect(errors).toHaveLength(0)
})

test('DIAGRAM: clicking Box toolbar button adds a node (no crash)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await boot(launched)
  const seeded = await seedWidget(launched, 'diagram')

  // Click "Box" in the toolbar via direct DOM click (avoids coord-based
  // intercept from sidebar overlaps).
  await window.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>('[title="Add Box"]')
    if (!btn) throw new Error('Add Box toolbar button not found')
    btn.click()
  })
  await window.waitForTimeout(600) // let React re-render + debounced persist

  // A React Flow node should now be in the DOM.
  const nodeCount = await window.evaluate(
    () => document.querySelectorAll('.react-flow__node').length
  )
  expect(nodeCount).toBeGreaterThanOrEqual(1)

  // No page errors.
  expect(errors).toHaveLength(0)

  // Persistence: widget.content becomes valid JSON with at least one node. The
  // save is debounced, so poll for it: a fixed wait read '' under load (the
  // 80815a8e baseline failed with "Unexpected end of JSON input" that way).
  const readNodes = async (): Promise<number> => {
    const content = await window.evaluate(
      async ({ tid, wid }: { tid: string; wid: string }) => {
        const api = (window as unknown as { api: typeof window.api }).api
        const widgets = await api.widgets.listByTask(tid)
        return widgets.find((w) => w.id === wid)?.content ?? null
      },
      { tid: seeded.taskId, wid: seeded.widgetId }
    )
    if (!content) return -1 // not persisted yet
    const parsed = JSON.parse(content) as { nodes?: unknown[]; edges?: unknown[] }
    return Array.isArray(parsed.nodes) ? parsed.nodes.length : -2
  }
  await expect.poll(readNodes, { timeout: 8_000, message: 'the diagram widget persisted at least one node' }).toBeGreaterThanOrEqual(1)
})

test('DIAGRAM: pre-seeded graph renders existing nodes on mount', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const seedContent = JSON.stringify({
    nodes: [
      { id: 'n1', type: 'shape', position: { x: 100, y: 100 }, data: { label: 'Alpha', shape: 'box', color: '#2563eb' } },
      { id: 'n2', type: 'shape', position: { x: 300, y: 100 }, data: { label: 'Beta', shape: 'circle', color: '#16a34a' } }
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', markerEnd: { type: 'arrowclosed' }, animated: false }
    ]
  })

  await boot(launched)
  await seedWidget(launched, 'diagram', seedContent)

  await window.waitForSelector('.react-flow__node', { timeout: 8_000 })
  const nodeCount = await window.evaluate(
    () => document.querySelectorAll('.react-flow__node').length
  )
  expect(nodeCount).toBe(2)

  expect(errors).toHaveLength(0)
})

test('DIAGRAM: content persists to DB after adding a node (read-back)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await boot(launched)
  const seeded = await seedWidget(launched, 'diagram')

  // Add a Circle node via toolbar.
  await window.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>('[title="Add Circle / Venn"]')
    if (!btn) throw new Error('Add Circle button not found')
    btn.click()
  })
  // Wait for the debounced persist (500ms in the widget).
  await window.waitForTimeout(1000)

  const content = await window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      return widgets.find((w) => w.id === wid)?.content ?? null
    },
    { tid: seeded.taskId, wid: seeded.widgetId }
  )

  expect(content).not.toBeNull()
  expect(content!.length).toBeGreaterThan(10) // not empty string
  const parsed = JSON.parse(content!) as { nodes: unknown[]; edges: unknown[] }
  expect(parsed.nodes.length).toBeGreaterThanOrEqual(1)
  expect(errors).toHaveLength(0)
})

// ── SCRATCHPAD ─────────────────────────────────────────────────────────────

test('SCRATCHPAD: toolbar and SVG surface mount with no errors', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await boot(launched)
  await seedWidget(launched, 'scratchpad')

  // Pen and eraser toolbar buttons.
  await expect(window.locator('[title="Pen"]').first()).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[title="Eraser"]').first()).toBeVisible()

  // SVG drawing surface is mounted.
  const svgVisible = await window.evaluate(
    () => !!document.querySelector('.react-flow, svg') // scratchpad renders an <svg>
  )
  expect(svgVisible).toBe(true)

  // Color swatches render (7 colors).
  const colorBtns = await window.evaluate(
    () => document.querySelectorAll('[aria-label^="Colour "]').length
  )
  expect(colorBtns).toBeGreaterThanOrEqual(7)

  expect(errors).toHaveLength(0)
})

test('SCRATCHPAD: pointer events on the drawing surface cause no crash (interactive guard)', async () => {
  // The scratchpad only draws when isActive=true (the widget was explicitly
  // clicked to focus it in the canvas). Without a real activation click the
  // surface's onPointerDown returns early. This test confirms the guard works
  // silently — no exception, no corrupt DB state — and that the surface element
  // is present and accepts pointer events without throwing.
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await boot(launched)
  const seeded = await seedWidget(launched, 'scratchpad')

  // Activate the widget by clicking the WidgetFrame container first, then
  // simulate a draw stroke. data-widget-id is set by WidgetFrame.
  const widgetSelector = `[data-widget-id="${seeded.widgetId}"]`
  await window.waitForSelector(widgetSelector, { timeout: 5_000 })

  // Click the frame to activate (sets isActive in the widget store).
  await window.evaluate((sel: string) => {
    const frame = document.querySelector<HTMLElement>(sel)
    if (!frame) throw new Error(`WidgetFrame not found: ${sel}`)
    frame.click()
  }, widgetSelector)
  await window.waitForTimeout(100)

  // Now simulate a stroke on the drawing surface.
  await window.evaluate(() => {
    const surface = document.querySelector<HTMLDivElement>('[style*="crosshair"]')
    if (!surface) throw new Error('Scratchpad drawing surface not found')
    const rect = surface.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    surface.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true,
      clientX: cx, clientY: cy,
      pointerId: 1, pressure: 0.5, buttons: 1
    }))
    surface.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, cancelable: true,
      clientX: cx + 20, clientY: cy + 10,
      pointerId: 1, pressure: 0.5, buttons: 1
    }))
    surface.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true,
      clientX: cx + 20, clientY: cy + 10,
      pointerId: 1, pressure: 0, buttons: 0
    }))
  })
  await window.waitForTimeout(400)

  // Whether or not the stroke committed (depends on activation timing), the
  // content field must be either empty-string (initial) or valid JSON.
  // The key invariant: no page crash, no corrupt DB.
  const content = await window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      return widgets.find((w) => w.id === wid)?.content ?? null
    },
    { tid: seeded.taskId, wid: seeded.widgetId }
  )
  expect(content).not.toBeNull()
  // If content is non-empty it must parse as valid JSON.
  if (content!.length > 0) {
    const parsed = JSON.parse(content!) as { strokes: unknown[] }
    expect(Array.isArray(parsed.strokes)).toBe(true)
  }
  // No page errors — this is the real pass criterion.
  expect(errors).toHaveLength(0)
})

test('SCRATCHPAD: directly writing a stroke to content field persists and reads back', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await boot(launched)
  const seeded = await seedWidget(launched, 'scratchpad')

  // Write a known stroke payload directly via the widget store (mirrors how the
  // component itself calls update()). This exercises the persistence path
  // without depending on pointer events being routed through the canvas hit test.
  const strokeContent = JSON.stringify({
    strokes: [
      { points: [[50, 50, 0.5], [80, 70, 0.6], [110, 90, 0.4]], color: '#1c1917', size: 6 }
    ]
  })

  await window.evaluate(
    async ({ wid, c }: { wid: string; c: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.update(wid, { content: c })
    },
    { wid: seeded.widgetId, c: strokeContent }
  )

  // Read back.
  const readBack = await window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      return widgets.find((w) => w.id === wid)?.content ?? null
    },
    { tid: seeded.taskId, wid: seeded.widgetId }
  )
  expect(readBack).not.toBeNull()
  const parsed = JSON.parse(readBack!) as { strokes: Array<{ color: string }> }
  expect(parsed.strokes).toHaveLength(1)
  expect(parsed.strokes[0].color).toBe('#1c1917')

  expect(errors).toHaveLength(0)
})

// ── REGRESSION ────────────────────────────────────────────────────────────

test('REGRESSION: existing sticky widget still renders after new widget kinds added', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await boot(launched)

  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Sticky reg test' })
    const w = await api.widgets.create({
      taskId: task.id, kind: 'sticky', title: '', content: 'hello regression',
      x: 100, y: 100, width: 320, height: 240, color: null
    })
    return { taskId: task.id, widgetId: w.id }
  })

  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip3 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip3.isVisible().catch(() => false)) await skip3.click().catch(() => {})

  await window.getByRole('button', { name: 'Sticky reg test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  // The sticky widget must be visible in the canvas.
  // WidgetFrame renders a data-widget-id attribute.
  await window.waitForSelector(`[data-widget-id="${seeded.widgetId}"]`, { timeout: 5_000 })
  const visible = await window.locator(`[data-widget-id="${seeded.widgetId}"]`).first().isVisible()
  expect(visible).toBe(true)

  expect(errors).toHaveLength(0)
})
