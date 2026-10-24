// Three things the owner found testing 4.3.42 (2026-10-24):
//
//   EI-1 "The Workcentre view on desks doesn't support mouse scroll or flick."
//        The view is drawn over the desk canvas, whose native wheel listener
//        cancelled every scroll and panned the hidden desk instead.
//   EI-2 "The widget, tool and file embed within other objects forces the full
//        desk experience with header; it should toggle on and off as pure
//        data, or original object." Each placement now chooses, and keeps it.
//   EI-3/4 "Things like scratchpad don't allow drawing lines, only dots,
//        because the wider document mouse functions prioritise, such as move
//        the widget." A stroke on an embedded scratchpad must draw a line,
//        and must not move the object it sits in.
//
// Pointer input is Playwright's (CDP mouse events); it reaches the same
// pointer handlers a trackpad does.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

type Api = typeof window.api

async function open(window: Page, what: 'task' | 'document', id: string): Promise<void> {
  await window.evaluate(
    ([kind, i]) => {
      const v = (window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void; goDocument: (x: string) => void } } }).__fbView
      if (kind === 'task') v?.getState().goTask(i)
      else v?.getState().goDocument(i)
    },
    [what, id] as const
  )
}

/** The scratchpad file's strokes, from what was saved, not from the DOM. */
async function strokes(window: Page, fileId: string): Promise<Array<{ points: number[][] }>> {
  return window.evaluate(async (id) => {
    const api = (window as unknown as { api: Api }).api
    const f = await api.widgetFiles.get(id)
    try {
      return (JSON.parse(f?.content || '{}') as { strokes?: Array<{ points: number[][] }> }).strokes ?? []
    } catch {
      return []
    }
  }, fileId)
}

/** Horizontal reach of a stroke, in widget pixels. A dot reaches ~0. */
function reach(s: { points: number[][] } | undefined): number {
  if (!s || s.points.length === 0) return 0
  const xs = s.points.map((p) => p[0])
  return Math.max(...xs) - Math.min(...xs)
}

async function drag(window: Page, x: number, y: number, dx: number): Promise<void> {
  await window.mouse.move(x, y)
  await window.mouse.down()
  for (let i = 1; i <= 12; i++) await window.mouse.move(x + (dx * i) / 12, y + i * 2)
  await window.mouse.up()
}

test('EI-1 the Workcentre scrolls with the wheel, and the desk behind it does not pan', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const taskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Scroll desk' })
    for (let i = 0; i < 40; i++) {
      await api.widgets.create({ taskId: task.id, kind: 'sticky', content: `Note ${i}`, x: (i % 4) * 260, y: Math.floor(i / 4) * 220, width: 240, height: 200 } as never)
    }
    return task.id
  })
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await open(window, 'task', taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 15_000 })
  await window.locator('[data-testid="view-selector-btn"]').first().click()
  await window.locator('[data-testid="view-opt-workcentre"]').click()
  const scroller = window.locator('[data-testid="workcentre-scroll"]')
  await expect(window.locator('[data-testid="workcentre-grid"]')).toBeVisible({ timeout: 10_000 })

  const before = await scroller.evaluate((el) => ({ top: el.scrollTop, room: el.scrollHeight - el.clientHeight }))
  expect(before.room, 'the grid must overflow, or this proves nothing').toBeGreaterThan(100)
  const panBefore = await window.evaluate(() => {
    const s = (window as unknown as { __fbWidgets: { getState: () => { panX: number; panY: number } } }).__fbWidgets.getState()
    return { x: s.panX, y: s.panY }
  })

  const box = (await scroller.boundingBox())!
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await window.mouse.wheel(0, 500)
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 3_000 }).toBeGreaterThan(before.top + 100)

  const panAfter = await window.evaluate(() => {
    const s = (window as unknown as { __fbWidgets: { getState: () => { panX: number; panY: number } } }).__fbWidgets.getState()
    return { x: s.panX, y: s.panY }
  })
  expect(panAfter, 'the hidden desk panned under the Workcentre').toEqual(panBefore)
})

test('EI-2 an embed shows data alone by default, switches to the original object, and keeps the choice', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { docId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    const file = (await api.widgetFiles.create({ kind: 'sticky', content: 'Embedded sticky text' } as never, {} as never)) as { id: string }
    const doc = (await api.documents.create({
      docType: 'doc',
      title: 'Embed display doc',
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Above' }] }, { type: 'widgetEmbed', attrs: { widgetId: `wf:${file.id}` } }] }
    } as never)) as { id: string }
    return { docId: doc.id }
  })
  await open(window, 'document', docId)
  const embed = window.locator('[data-testid="widget-embed"]')
  await expect(embed).toBeVisible({ timeout: 10_000 })
  await expect(embed).toContainText('Embedded sticky text')

  // Data: the content, and no desk header around it.
  await expect(embed).toHaveAttribute('data-embed-display', 'data')
  await expect(embed.locator('[data-widget-header]')).toHaveCount(0)

  // Original: the object as the desk draws it, header included.
  await embed.hover()
  await embed.locator('[data-testid="embed-display-toggle"]').click()
  await expect(embed).toHaveAttribute('data-embed-display', 'object')
  await expect(embed.locator('[data-widget-header]')).toHaveCount(1)

  // Kept by the placement: it survives leaving and reopening the document.
  await window.waitForTimeout(1_200) // the document's own save debounce
  await window.evaluate(() => (window as unknown as { __fbView?: { getState: () => { goHome: () => void } } }).__fbView?.getState().goHome())
  await open(window, 'document', docId)
  await expect(window.locator('[data-testid="widget-embed"]')).toHaveAttribute('data-embed-display', 'object', { timeout: 10_000 })
  await expect(window.locator('[data-testid="widget-embed"] [data-widget-header]')).toHaveCount(1)
})

test('EI-3 a stroke on a scratchpad embedded in a document draws a line', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { docId, fileId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    const file = (await api.widgetFiles.create({ kind: 'scratchpad', content: '' } as never, {} as never)) as { id: string }
    const doc = (await api.documents.create({
      docType: 'doc',
      title: 'Scratchpad doc',
      body: { type: 'doc', content: [{ type: 'widgetEmbed', attrs: { widgetId: `wf:${file.id}` } }, { type: 'paragraph', content: [{ type: 'text', text: 'Below' }] }] }
    } as never)) as { id: string; }
    return { docId: doc.id, fileId: file.id }
  })
  await open(window, 'document', docId)
  // The scratchpad's own drawing surface (it exists before and after the fix,
  // so a red on the old build is the bug, not a missing selector).
  const body = window.locator('[data-testid="widget-embed"] .touch-none').first()
  await expect(body).toBeVisible({ timeout: 10_000 })
  const b = (await body.boundingBox())!
  // First click makes the scratchpad the active widget, as on the desk.
  await window.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
  await drag(window, b.x + 30, b.y + b.height / 2, 160)
  await expect.poll(async () => reach((await strokes(window, fileId)).at(-1)), { timeout: 5_000 }).toBeGreaterThan(100)
  // And the document still holds the embed where it was: nothing was dragged.
  const kinds = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Api }).api
    const d = await api.documents.get(id)
    const body = (typeof d?.body === 'string' ? JSON.parse(d.body) : d?.body) as { content?: Array<{ type: string }> } | null
    return (body?.content ?? []).map((n) => n.type)
  }, docId)
  expect(kinds[0], 'the embed moved inside the document').toBe('widgetEmbed')
})

test('EI-4 a stroke on a scratchpad embedded in a deck draws a line and does not move the element', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { deckId, fileId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    const file = (await api.widgetFiles.create({ kind: 'scratchpad', content: '' } as never, {} as never)) as { id: string }
    const deck = (await api.documents.create({
      docType: 'slides',
      title: 'Scratchpad deck',
      body: {
        schemaVersion: 2,
        theme: 'plexi',
        size: { w: 1280, h: 720 },
        slides: [
          {
            id: 's1',
            schemaVersion: 2,
            layout: 'blank',
            notes: '',
            transition: 'none',
            background: { type: 'solid', color: '#ffffff' },
            elements: [{ id: 'e1', type: 'widget', widgetId: `wf:${file.id}`, x: 200, y: 120, w: 700, h: 420, z: 1 }]
          }
        ]
      }
    } as never)) as { id: string }
    return { deckId: deck.id, fileId: file.id }
  })
  await open(window, 'document', deckId)
  const body = window.locator('[data-testid="slides-canvas"] [data-element-id="e1"] .touch-none').first()
  await expect(body).toBeVisible({ timeout: 10_000 })
  const b = (await body.boundingBox())!
  await window.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
  await drag(window, b.x + 40, b.y + b.height / 2, 200)

  await expect.poll(async () => reach((await strokes(window, fileId)).at(-1)), { timeout: 5_000 }).toBeGreaterThan(100)
  const pos = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Api }).api
    const d = await api.documents.get(id)
    const body = (typeof d?.body === 'string' ? JSON.parse(d.body) : d?.body) as { slides: Array<{ elements: Array<{ id: string; x: number; y: number }> }> }
    const el = body.slides[0].elements.find((e) => e.id === 'e1')
    return el ? { x: el.x, y: el.y } : null
  }, deckId)
  expect(pos, 'the element was moved by a stroke inside it').toEqual({ x: 200, y: 120 })
})

test('EI-5 the grip still moves an embedded widget on a slide', async () => {
  // The other half of EI-4: content is the widget's, but the object must
  // still be movable, from its grip.
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { deckId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    const file = (await api.widgetFiles.create({ kind: 'scratchpad', content: '' } as never, {} as never)) as { id: string }
    const deck = (await api.documents.create({
      docType: 'slides',
      title: 'Grip deck',
      body: {
        schemaVersion: 2,
        theme: 'plexi',
        size: { w: 1280, h: 720 },
        slides: [{ id: 's1', schemaVersion: 2, layout: 'blank', notes: '', transition: 'none', background: { type: 'solid', color: '#ffffff' },
          elements: [{ id: 'e1', type: 'widget', widgetId: `wf:${file.id}`, x: 200, y: 120, w: 700, h: 420, z: 1 }] }]
      }
    } as never)) as { id: string }
    return { deckId: deck.id }
  })
  await open(window, 'document', deckId)
  const el = window.locator('[data-testid="slides-canvas"] [data-element-id="e1"]')
  await expect(el).toBeVisible({ timeout: 10_000 })
  await el.hover()
  const grip = el.locator('[data-testid="embed-grip"]')
  await expect(grip).toBeVisible()
  const g = (await grip.boundingBox())!
  await window.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
  await window.mouse.down()
  for (let i = 1; i <= 10; i++) await window.mouse.move(g.x + g.width / 2 + i * 8, g.y + g.height / 2 + i * 5)
  await window.mouse.up()
  await expect
    .poll(async () => window.evaluate(async (id) => {
      const api = (window as unknown as { api: Api }).api
      const d = await api.documents.get(id)
      const body = (typeof d?.body === 'string' ? JSON.parse(d.body) : d?.body) as { slides: Array<{ elements: Array<{ id: string; x: number }> }> }
      return body.slides[0].elements.find((e) => e.id === 'e1')?.x ?? 0
    }, deckId), { timeout: 5_000 })
    .toBeGreaterThan(220)
})
