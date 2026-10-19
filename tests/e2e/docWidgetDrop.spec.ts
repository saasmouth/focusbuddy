import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// "I'm dragging a sticky from the side menu, and it doesn't show as an
// editable sticky in the doc."
//
// It could not. The editor had no drop handler at all, and the only way in
// was a picker listing widgets ALREADY on a desk — so a new sticky had no
// route into a document and the drag said nothing when it failed.

let launched: LaunchedApp | null = null
test.afterEach(async () => { await launched?.app.close().catch(() => {}); launched = null })

const NEW_FILE_MIME = 'application/x-plexii-widget-new-file'

async function openADoc(window: LaunchedApp['window']): Promise<void> {
  const id = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const d = await api.documents.create({ docType: 'doc', title: 'Drop target' } as never)
    return (d as { id: string }).id
  })
  await window.evaluate((docId) => {
    const v = (window as unknown as { __fbView?: { getState: () => { goDocument: (i: string) => void } } }).__fbView
    v?.getState().goDocument(docId)
  }, id)
  await window.waitForSelector('.ProseMirror', { timeout: 20_000 })
  await window.waitForTimeout(700)
}

test('dragging a sticky from the side menu into a document embeds a live one', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openADoc(window)

  // Counted by the embed's own testid, NOT [data-widget-embed]: that
  // attribute is emitted by the headless HTML renderer, while the live
  // editor draws the node through a React NodeView. Asserting on it made a
  // working drop look broken.
  const count = (): Promise<number> =>
    window.evaluate(() => document.querySelectorAll('[data-testid^="widget-embed"]').length)
  const before = await count()

  await window.evaluate((mime) => {
    const dom = document.querySelector('.ProseMirror')!
    const r = dom.getBoundingClientRect()
    const dt = new DataTransfer()
    dt.setData(mime, 'sticky')
    const at = { clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 30), dataTransfer: dt, bubbles: true, cancelable: true }
    dom.dispatchEvent(new DragEvent('dragover', at))
    dom.dispatchEvent(new DragEvent('drop', at))
  }, NEW_FILE_MIME)
  await window.waitForTimeout(1500)

  const after = await count()
  expect(after, 'no embed appeared in the document').toBe(before + 1)

  // And it is a real file, not a placeholder.
  const files = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.widgetFiles.list()).filter((f) => f.kind === 'sticky').length
  })
  expect(files, 'the drop made no work widget file').toBeGreaterThan(0)
})

// The same drag must work in the other editors that can already RENDER an
// embed. Each has its own drop target and its own insert function, which is
// exactly why they share one helper to decide what was dropped.
for (const surface of [
  { docType: 'slides', ready: '[data-testid="slides-canvas"]', name: 'a slide' },
  { docType: 'design', ready: '[data-testid="design-editor"]', name: 'a design' },
  { docType: 'map', ready: '.react-flow', name: 'a diagram' }
] as const) {
  test(`dragging a sticky onto ${surface.name} embeds a live one`, async () => {
    launched = await launchApp()
    const { window } = launched
    await waitForReady(window)

    const id = await window.evaluate(async (docType) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const d = await api.documents.create({ docType, title: `Drop ${docType}` } as never)
      return (d as { id: string }).id
    }, surface.docType)
    await window.evaluate((docId) => {
      const v = (window as unknown as { __fbView?: { getState: () => { goDocument: (i: string) => void } } }).__fbView
      v?.getState().goDocument(docId)
    }, id)
    // A NEW DECK HAS NO SLIDE, and therefore no canvas to drop onto — the
    // editor shows only its menu bar until one exists. So add one the way a
    // user does, through the template gallery, rather than asserting against
    // a surface the product does not render yet.
    if (surface.docType === 'slides') {
      await window.locator('[data-testid="slides-add"]').first().click()
      await window.waitForSelector('[data-testid="slide-template-gallery"]', { timeout: 10_000 })
      await window.locator('[data-testid^="slide-template-"]').first().click()
    }
    await window.waitForSelector(surface.ready, { timeout: 20_000 })
    await window.waitForTimeout(900)

    // Counted INSIDE the drop surface, not across the page. A slide element
    // renders twice — once on the canvas and once in the thumbnail rail — so
    // a global count reports two embeds for one widget and fails a drop that
    // worked perfectly.
    const count = (): Promise<number> =>
      window.evaluate(
        (sel) => document.querySelector(sel)?.querySelectorAll('[data-testid^="widget-embed"]').length ?? 0,
        surface.ready
      )
    const before = await count()

    await window.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement
      const r = el.getBoundingClientRect()
      const dt = new DataTransfer()
      dt.setData('application/x-plexii-widget-new-file', 'sticky')
      const at = {
        clientX: Math.round(r.left + r.width / 2),
        clientY: Math.round(r.top + r.height / 2),
        dataTransfer: dt,
        bubbles: true,
        cancelable: true
      }
      el.dispatchEvent(new DragEvent('dragover', at))
      el.dispatchEvent(new DragEvent('drop', at))
    }, surface.ready)
    await window.waitForTimeout(1800)

    expect(await count(), `no embed appeared on ${surface.name}`).toBe(before + 1)
  })
}

test('a work widget can be dropped INTO a widget on a desk', async () => {
  // "Widget in widget." It needs no separate mechanism: a doc widget on a
  // desk renders the same DocEditor a full-pane document does, so the drop
  // handler added for documents serves nesting too. Worth a test precisely
  // BECAUSE it is emergent — nothing names this case, so nothing would fail
  // if a future change broke it.
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Nesting' })
    const doc = await api.documents.create({ docType: 'doc', title: 'Inner doc' } as never)
    const w = await api.widgets.create({
      taskId: task.id, kind: 'doc', content: (doc as { id: string }).id,
      x: 80, y: 80, width: 900, height: 600
    } as never)
    return { taskId: task.id, widgetId: (w as { id: string }).id }
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const v = (window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }).__fbView
    v?.getState().goTask(id)
  }, ids.taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 15_000 })
  await window.waitForSelector('.ProseMirror', { timeout: 15_000 })
  await window.waitForTimeout(1200)

  const inner = (): Promise<number> =>
    window.evaluate(
      () => document.querySelector('.ProseMirror')?.querySelectorAll('[data-testid^="widget-embed"]').length ?? 0
    )
  const before = await inner()

  await window.evaluate(() => {
    const el = document.querySelector('.ProseMirror') as HTMLElement
    const r = el.getBoundingClientRect()
    const dt = new DataTransfer()
    dt.setData('application/x-plexii-widget-new-file', 'sticky')
    const at = { clientX: Math.round(r.left + 30), clientY: Math.round(r.top + 20), dataTransfer: dt, bubbles: true, cancelable: true }
    el.dispatchEvent(new DragEvent('dragover', at))
    el.dispatchEvent(new DragEvent('drop', at))
  })
  await window.waitForTimeout(1800)

  expect(await inner(), 'no widget nested inside the widget').toBe(before + 1)
})

test('a sticky dropped on a drawing becomes a placed object', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const id = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const d = await api.documents.create({ docType: 'draw', title: 'Drop draw' } as never)
    return (d as { id: string }).id
  })
  await window.evaluate((docId) => {
    const v = (window as unknown as { __fbView?: { getState: () => { goDocument: (i: string) => void } } }).__fbView
    v?.getState().goDocument(docId)
  }, id)
  await window.waitForSelector('[data-testid="draw-studio"]', { timeout: 20_000 })
  await window.waitForTimeout(900)

  const count = (): Promise<number> =>
    window.evaluate(() => document.querySelectorAll('[data-testid^="widget-embed"]').length)
  const before = await count()
  await window.evaluate(() => {
    const el = document.querySelector('[data-testid="draw-studio"]') as HTMLElement
    const r = el.getBoundingClientRect()
    const dt = new DataTransfer()
    dt.setData('application/x-plexii-widget-new-file', 'sticky')
    const at = { clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2), dataTransfer: dt, bubbles: true, cancelable: true }
    el.dispatchEvent(new DragEvent('dragover', at))
    el.dispatchEvent(new DragEvent('drop', at))
  })
  await window.waitForTimeout(1800)
  expect(await count(), 'no widget was placed on the drawing').toBe(before + 1)
})

test('a sheet takes a widget both anchored to a cell and floating', async () => {
  // "Sheets should allow both embedded in cell, or unembedded over the top."
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const id = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const d = await api.documents.create({ docType: 'sheet', title: 'Drop sheet' } as never)
    return (d as { id: string }).id
  })
  await window.evaluate((docId) => {
    const v = (window as unknown as { __fbView?: { getState: () => { goDocument: (i: string) => void } } }).__fbView
    v?.getState().goDocument(docId)
  }, id)
  await window.waitForSelector('[data-testid="sheet-grid-wrap"]', { timeout: 20_000 })
  await window.waitForTimeout(900)

  // Dropped ONTO a cell: anchors to it.
  await window.evaluate(() => {
    const el = document.querySelector('[data-testid="sheet-grid-wrap"]') as HTMLElement
    const r = el.getBoundingClientRect()
    const dt = new DataTransfer()
    dt.setData('application/x-plexii-widget-new-file', 'sticky')
    const at = { clientX: Math.round(r.left + 120), clientY: Math.round(r.top + 60), dataTransfer: dt, bubbles: true, cancelable: true }
    el.dispatchEvent(new DragEvent('dragover', at))
    el.dispatchEvent(new DragEvent('drop', at))
  })
  await window.waitForTimeout(1800)

  const placed = await window.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="sheet-widget-"]')).map((e) => e.getAttribute('data-mode'))
  )
  expect(placed, 'nothing was placed on the sheet').toHaveLength(1)
  expect(placed[0], 'a drop on a cell should anchor to it').toBe('cell')

  // And it can be switched to floating, which is the other half of the ask.
  await window.locator('[data-testid^="sheet-widget-"] button').first().click()
  await window.waitForTimeout(700)
  const after = await window.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="sheet-widget-"]')).map((e) => e.getAttribute('data-mode'))
  )
  expect(after[0], 'could not switch the placement to floating').toBe('float')
})
