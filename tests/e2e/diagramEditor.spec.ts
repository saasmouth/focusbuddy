/**
 * PlexiDiagrams editor, driven through the real UI:
 *  DGM-1  selection is unmistakable: clicking a shape draws the selection frame
 *         and the status bar names it; clicking empty canvas clears both.
 *  DGM-2  the shape library inserts shapes from several categories, search
 *         finds a shape, and Ctrl/Cmd+A selects everything.
 *  DGM-3  connections: quick-add creates a linked shape, Tidy reroutes without
 *         error, and the edge is written to the saved document.
 *  DGM-4  data sources: the Data dialog lists Tables / Widgets / Apps / Tools and
 *         inserting an app tile persists an app-bound node.
 *
 * Setup goes through window.api (no file dialogs); every assertion that matters
 * reads the saved document back from window.api.documents.get.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, placeElement, waitForReady } from './_helpers'

interface SavedNode {
  id: string
  shape: string
  binding?: { source?: { kind?: string } }
  style?: { bold?: boolean }
}
interface SavedBody {
  nodes?: SavedNode[]
  edges?: { id: string; source: string; target: string }[]
}

async function createMap(window: Page, title: string): Promise<string> {
  return window.evaluate(async (t: string) => {
    const w = window as unknown as {
      api: { documents: { create: (o: Record<string, unknown>) => Promise<{ id: string }> } }
      __fbView?: { getState: () => { goDocument: (id: string) => void } }
    }
    const d = await w.api.documents.create({ docType: 'map', title: t })
    w.__fbView?.getState().goDocument(d.id)
    return d.id
  }, title)
}

async function readBody(window: Page, id: string): Promise<SavedBody> {
  return window.evaluate(async (docId: string) => {
    const api = (window as unknown as { api: { documents: { get: (id: string) => Promise<{ body: unknown } | null> } } }).api
    const doc = await api.documents.get(docId)
    return (doc?.body ?? {}) as SavedBody
  }, id)
}

async function waitForSaved(window: Page, id: string, pred: (b: SavedBody) => boolean): Promise<SavedBody> {
  let body: SavedBody = {}
  await expect
    .poll(
      async () => {
        body = await readBody(window, id)
        return pred(body)
      },
      { timeout: 10_000 }
    )
    .toBe(true)
  return body
}

async function openEditor(title: string): Promise<{ window: Page; id: string; errors: string[]; dispose: () => Promise<void> }> {
  const { window, dispose } = await launchApp()
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  await waitForReady(window)
  // Since 4.3.39 a fresh profile routes AI locally, and without the bundled model
  // a "Local AI needs a one-time download" notice sits over every editor's
  // toolbar row. These specs are not about AI, so choose the automatic cloud
  // source first, as an existing user would have (the repo's pattern).
  await window.evaluate(() => (window as unknown as { api: { ai: { setMode: (m: string) => Promise<unknown> } } }).api.ai.setMode('auto'))
  await expect(window.locator('[data-testid="local-ai-missing"]')).toHaveCount(0, { timeout: 5_000 })
  // The one-time "Local AI is now built in" card sits bottom-centre on a fresh
  // profile, over the editor's lower panels. Dismiss it ("Got it") whenever it
  // is what stands in the way of an action, as a real user would.
  await window.addLocatorHandler(window.locator('[data-testid="local-ai-intro"]'), async (card) => {
    await card.locator('[data-testid="local-ai-intro-dismiss"]').click({ timeout: 4_000 })
  }, { noWaitAfter: true })
  const id = await createMap(window, title)
  await expect(window.locator('[data-testid="diagram-editor"]')).toBeVisible({ timeout: 12_000 })
  await expect(window.locator('.react-flow__node').first()).toBeVisible({ timeout: 8_000 })
  return { window, id, errors, dispose }
}

test('DGM-1 — selecting a shape shows a clear selection frame and status; clicking away clears it', async () => {
  const { window, errors, dispose } = await openEditor('Selection')
  try {
    const node = window.locator('.react-flow__node').first()
    const summary = window.locator('[data-testid="diagram-selection-summary"]')
    await expect(window.locator('[data-testid="diagram-selection-frame"]')).toHaveCount(0)

    await node.click()
    const frame = window.locator('[data-testid="diagram-selection-frame"]')
    await expect(frame).toHaveCount(1)
    await expect(frame).toBeVisible()
    // A solid ~2px coloured border on screen, not a hairline, at any canvas zoom.
    // (Device-pixel snapping under the app's UI zoom can shave a fraction.)
    const screenBorder = (): Promise<number> =>
      frame.evaluate((el) => {
        const vp = document.querySelector('.react-flow__viewport') as HTMLElement
        const zoom = new DOMMatrixReadOnly(getComputedStyle(vp).transform).a
        return parseFloat(getComputedStyle(el).borderTopWidth) * zoom
      })
    expect(await screenBorder()).toBeGreaterThanOrEqual(1.5)
    await window.locator('[data-testid="diagram-selection-summary"]').hover()
    await window.locator('.react-flow__pane').hover()
    for (let i = 0; i < 4; i++) await window.mouse.wheel(0, 240)
    await window.waitForTimeout(300)
    expect(await screenBorder()).toBeGreaterThanOrEqual(1.5)
    await expect(summary).toHaveText('1 shape selected')
    // The contextual Shape tab appears with the selection (office shell, D3: it does not steal focus).
    await expect(window.locator('[data-testid="diagram-toolbar-tab-shape"]')).toBeVisible()
    await expect(window.locator('[data-testid="diagram-toolbar-tab-home"]')).toHaveAttribute('aria-selected', 'true')

    // Click a point that really is bare canvas (not a node, minimap or control).
    const spot = await window.evaluate(() => {
      const r = document.querySelector('.react-flow__pane')!.getBoundingClientRect()
      for (const fy of [0.15, 0.5, 0.85]) {
        for (const fx of [0.1, 0.3, 0.7, 0.9]) {
          const x = r.left + r.width * fx
          const y = r.top + r.height * fy
          if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y }
        }
      }
      return null
    })
    expect(spot).not.toBeNull()
    await window.mouse.click(spot!.x, spot!.y)
    await expect(frame).toHaveCount(0)
    await expect(summary).not.toContainText('selected')
    expect(errors).toEqual([])
  } finally {
    await dispose()
  }
})

test('DGM-2 — library inserts shapes across categories, search finds one, select-all selects everything', async () => {
  const { window, id, errors, dispose } = await openEditor('Library')
  try {
    const before = (await readBody(window, id)).nodes?.length ?? 0

    // The library is an overlay panel opened from the rail; Flowchart is open in it by default.
    await window.locator('[data-testid="diagram-toggle-library"]').click()
    await window.locator('[data-testid="map-add-decision"]').click()
    // Search reaches shapes in closed categories.
    await window.locator('[data-testid="diagram-shape-search"]').fill('cylinder')
    const hit = window.locator('[data-testid^="map-add-"]').first()
    await expect(hit).toBeVisible()
    await hit.click()
    await window.locator('[data-testid="diagram-shape-search"]').fill('')

    const body = await waitForSaved(window, id, (b) => (b.nodes?.length ?? 0) >= before + 2)
    expect(body.nodes!.some((n) => n.shape === 'decision')).toBe(true)

    // Select all from the canvas.
    // Click bare canvas: top-right, clear of the library panel (left) and the minimap (bottom-right).
    const paneBox = (await window.locator('.react-flow__pane').boundingBox())!
    await window.locator('.react-flow__pane').click({ position: { x: paneBox.width - 40, y: 40 } })
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
    const total = body.nodes!.length
    await expect(window.locator('[data-testid="diagram-selection-summary"]')).toContainText(`${total} shapes`)
    await expect(window.locator('[data-testid="diagram-selection-frame"]')).toHaveCount(total)
    await expect(window.locator('[data-testid="diagram-selection-bounds"]')).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await dispose()
  }
})

test('DGM-3 — quick-add creates a connected shape, Tidy reroutes cleanly, and the edge persists', async () => {
  const { window, id, errors, dispose } = await openEditor('Connections')
  try {
    const node = window.locator('.react-flow__node').first()
    await node.hover()
    await node.click()
    const quick = window.locator('[data-testid="diagram-quick-right"]')
    await expect(quick).toBeVisible()
    await quick.click()

    const body = await waitForSaved(window, id, (b) => (b.nodes?.length ?? 0) >= 2 && (b.edges?.length ?? 0) >= 1)
    const edge = body.edges![0]
    const ids = new Set(body.nodes!.map((n) => n.id))
    expect(ids.has(edge.source) && ids.has(edge.target)).toBe(true)
    await expect(window.locator('.react-flow__edge')).toHaveCount(body.edges!.length)

    const tidy = window.locator('[data-testid="diagram-tidy"]')
    await expect(tidy).toBeEnabled()
    await tidy.click()
    await expect(window.locator('[data-testid="map-export-status"]')).toBeVisible()
    // Selecting the line also shows as selected.
    await window.locator('.react-flow__edge').first().click({ force: true })
    await expect(window.locator('[data-testid="diagram-selection-summary"], [data-testid="map-export-status"]').first()).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await dispose()
  }
})

test('DGM-4 — Data dialog offers Tables, Widgets, Apps and Tools; an app tile is inserted and bound', async () => {
  const { window, id, errors, dispose } = await openEditor('Data sources')
  try {
    await window.locator('[data-testid="diagram-toolbar-tab-insert"]').click()
    await window.locator('[data-testid="diagram-data"]').click()
    for (const tab of ['tables', 'widgets', 'apps', 'tools']) {
      await expect(window.locator(`[data-testid="diagram-data-tab-${tab}"]`)).toBeVisible()
    }
    await window.locator('[data-testid="diagram-data-tab-apps"]').click()
    const firstApp = window.locator('[data-testid="diagram-data-dialog"] input[type="checkbox"]').first()
    await expect(firstApp).toBeVisible()
    await firstApp.check()
    await window.locator('[data-testid="diagram-data-apps-insert"]').click()

    const body = await waitForSaved(window, id, (b) => (b.nodes ?? []).some((n) => n.binding?.source?.kind === 'app'))
    expect(body.nodes!.find((n) => n.binding?.source?.kind === 'app')!.shape).toBe('app-tile')
    expect(errors).toEqual([])
  } finally {
    await dispose()
  }
})

test('DGM-5 — copy style / paste style shortcuts (⌥⌘C / ⌥⌘V) carry a style to another shape', async () => {
  const { window, id, errors, dispose } = await openEditor('Style shortcuts')
  try {
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    // A second shape to paste onto.
    await window.locator('[data-testid="diagram-toggle-library"]').click()
    await window.locator('[data-testid="map-add-decision"]').click()
    await window.locator('[data-testid="diagram-toggle-library"]').click()
    const both = await waitForSaved(window, id, (b) => (b.nodes?.length ?? 0) >= 2)
    const [first, second] = [both.nodes![0]!, both.nodes![1]!]
    const nodeEl = (nid: string) => window.locator(`.react-flow__node[data-id="${nid}"]`)
    // Make the first shape bold, then copy its style.
    await nodeEl(first.id).click()
    await window.keyboard.press(`${mod}+b`)
    await waitForSaved(window, id, (b) => !!b.nodes?.find((n) => n.id === first.id)?.style?.bold)
    await window.keyboard.press(`Alt+${mod}+KeyC`)
    // Paste it onto the second.
    await nodeEl(second.id).click()
    await window.keyboard.press(`Alt+${mod}+KeyV`)
    const after = await waitForSaved(window, id, (b) => !!b.nodes?.find((n) => n.id === second.id)?.style?.bold)
    expect(after.nodes!.find((n) => n.id === second.id)!.style!.bold).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await dispose()
  }
})

test('DGM-6 — Edit → Copy style / Paste style carry a style to another shape', async () => {
  const { window, id, errors, dispose } = await openEditor('Style menu')
  try {
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await window.locator('[data-testid="diagram-toggle-library"]').click()
    await window.locator('[data-testid="map-add-decision"]').click()
    await window.locator('[data-testid="diagram-toggle-library"]').click()
    const both = await waitForSaved(window, id, (b) => (b.nodes?.length ?? 0) >= 2)
    const [first, second] = [both.nodes![0]!, both.nodes![1]!]
    const nodeEl = (nid: string) => window.locator(`.react-flow__node[data-id="${nid}"]`)
    const editMenu = async (item: string): Promise<void> => {
      await window.locator('[data-testid="draw-menubar-edit"]').click()
      await window.locator('[data-testid="draw-menubar-edit-list"]').getByText(item, { exact: true }).click()
    }
    await nodeEl(first.id).click()
    await window.keyboard.press(`${mod}+b`)
    await waitForSaved(window, id, (b) => !!b.nodes?.find((n) => n.id === first.id)?.style?.bold)
    await editMenu('Copy style')
    // Something that re-renders the editor between copy and paste: the copied
    // style must survive it (it used to be lost on every render).
    await nodeEl(second.id).click()
    await editMenu('Paste style')
    const after = await waitForSaved(window, id, (b) => !!b.nodes?.find((n) => n.id === second.id)?.style?.bold)
    expect(after.nodes!.find((n) => n.id === second.id)!.style!.bold).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await dispose()
  }
})

test('DGM-7 — a hidden shape is recoverable: Hide shape, then Layers › Show all hidden', async () => {
  const { window, id, errors, dispose } = await openEditor('Hide and show')
  try {
    const node = window.locator('.react-flow__node').first()
    const nid = (await node.getAttribute('data-id'))!
    await node.click({ button: 'right', timeout: 5_000 })
    // Hide shape sits in More actions ▸ (the shared right-click shape, SPEC §9.3).
    await window.locator('[data-testid="diagram-context-menu"] [data-testid="ctx-moreActions"]').hover({ timeout: 5_000 })
    await window.locator('[data-testid="diagram-ctx-hide"]').click({ timeout: 5_000 })
    await expect(window.locator(`.react-flow__node[data-id="${nid}"]`)).toHaveCount(0)
    await waitForSaved(window, id, (b) => !!(b.nodes ?? []).find((n) => n.id === nid && (n as { hidden?: boolean }).hidden))
    // The Layers panel says so and brings it back.
    await window.locator('[data-testid="diagram-layers-toggle"]').click({ timeout: 5_000 })
    const show = window.locator('[data-testid="diagram-show-hidden"]')
    await expect(show).toBeVisible()
    await show.click({ timeout: 5_000 })
    await expect(window.locator(`.react-flow__node[data-id="${nid}"]`)).toHaveCount(1)
    await waitForSaved(window, id, (b) => !(b.nodes ?? []).some((n) => (n as { hidden?: boolean }).hidden))
    await expect(show).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await dispose()
  }
})

test('DGM-8 — Insert › Work widget from a desk… opens the Data dialog on the Work widgets tab', async () => {
  const { window, errors, dispose } = await openEditor('Insert widget')
  try {
    await window.locator('[data-testid="draw-menubar-insert"]').click({ timeout: 5_000 })
    await window.locator('[data-testid="draw-menubar-insert-list"]').getByText('Work widget from a desk…', { exact: true }).click({ timeout: 5_000 })
    await expect(window.locator('[data-testid="diagram-data-widget"]')).toBeVisible()
    // and "From a Plexii table…" still opens on Tables
    await window.locator('[data-testid="diagram-data-dialog"] [title="Close"]').first().click({ timeout: 5_000 })
    await expect(window.locator('[data-testid="diagram-data-dialog"]')).toHaveCount(0)
    await window.locator('[data-testid="draw-menubar-insert"]').click({ timeout: 5_000 })
    await window.locator('[data-testid="draw-menubar-insert-list"]').getByText('From a Plexii table…', { exact: true }).click({ timeout: 5_000 })
    await expect(window.locator('[data-testid="diagram-gen-table"]')).toBeVisible()
    await expect(window.locator('[data-testid="diagram-data-widget"]')).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await dispose()
  }
})

test('DGM-9 — armed shape tools (office shell D4): click places, drag sizes, back to Select; double-click locks; Esc and M', async () => {
  const { window, id, errors, dispose } = await openEditor('Armed tools')
  try {
    const canvas = window.locator('[data-testid="diagram-canvas"]')
    const tool = (): Promise<string | null> => canvas.getAttribute('data-tool')
    const count = async (): Promise<number> => (await readBody(window, id)).nodes?.length ?? 0
    const start = await count()

    // Click to place: the rail's shapes flyout shows Process; one click arms it.
    await placeElement(window, 'diagram', 'process', { canvas: '[data-testid="diagram-canvas"]' })
    await waitForSaved(window, id, (b) => (b.nodes?.length ?? 0) === start + 1)
    expect(await tool()).toBe('select') // returns to Select after placing

    // Drag to size, with a tool picked from the flyout (it becomes the visible member).
    await placeElement(window, 'diagram', 'circle', { canvas: '[data-testid="diagram-canvas"]', railTestid: 'diagram-rail', flyout: 'shapes', at: { x: 300, y: 120 }, drag: { dx: 180, dy: 90 } })
    const sized = await waitForSaved(window, id, (b) => (b.nodes?.length ?? 0) === start + 2)
    const circle = sized.nodes!.find((n) => n.shape === 'circle')!
    const zoom = await window.evaluate(() => {
      const vp = document.querySelector('.react-flow__viewport') as HTMLElement
      return new DOMMatrixReadOnly(getComputedStyle(vp).transform).a
    })
    const w = (circle as { width?: number }).width!
    const h = (circle as { height?: number }).height!
    expect(Math.abs(w - 180 / zoom)).toBeLessThan(6)
    expect(Math.abs(h - 90 / zoom)).toBeLessThan(6)
    await expect(window.locator('[data-testid="diagram-tool-circle"]')).toBeVisible() // last-used shows on the rail

    // Double-click keeps the tool armed (tool lock) until Esc.
    await window.locator('[data-testid="diagram-tool-circle"]').dblclick()
    await expect(canvas).toHaveAttribute('data-tool', 'shape:circle')
    const box = (await canvas.boundingBox())!
    await window.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.6)
    await window.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.7)
    await waitForSaved(window, id, (b) => (b.nodes?.length ?? 0) === start + 4)
    expect(await tool()).toBe('shape:circle')
    await canvas.focus()
    await window.keyboard.press('Escape')
    expect(await tool()).toBe('select')

    // The suite shape letter arms Process (M), and the rail shows it pressed.
    await window.keyboard.press('m')
    await expect(canvas).toHaveAttribute('data-tool', 'shape:process')
    await expect(window.locator('[data-testid="diagram-tool-process"]')).toHaveAttribute('aria-pressed', 'true')
    await window.keyboard.press('Escape')
    expect(errors).toEqual([])
  } finally {
    await dispose()
  }
})


test('DGM-10 — the AI lives in the shared right side pane: rail, Insert tab and top-bar toggle open it; it collapses to an edge tab and is remembered', async () => {
  const { window, id, errors, dispose } = await openEditor('Side pane')
  try {
    const pane = window.locator('[data-testid="diagram-sidepane"]')
    const edge = window.locator('[data-testid="diagram-sidepane-edge"]')
    await expect(edge).toBeVisible() // collapsed by default: a slim edge tab, the canvas keeps its width
    await expect(pane).toHaveCount(0)

    // The rail's AI item opens it and shows pressed; the prompt keeps its testid.
    await window.locator('[data-testid="map-ai"]').click()
    await expect(window.locator('[data-testid="diagram-ai-pane"] [data-testid="diagram-ai-prompt"]')).toBeVisible()
    await expect(window.locator('[data-testid="map-ai"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(window.locator('[data-testid="diagram-sidepane-toggle"]')).toHaveAttribute('aria-pressed', 'true')
    // It does not take focus on its own (a pane that reopens on load must not steal the keyboard).
    expect(await window.evaluate(() => document.activeElement?.getAttribute('data-testid'))).not.toBe('diagram-ai-prompt')

    // Collapse from its header, reopen from the edge tab, collapse from the top-bar toggle.
    await window.locator('[data-testid="diagram-sidepane-collapse"]').click()
    await expect(edge).toBeVisible()
    await expect(window.locator('[data-testid="map-ai"]')).toHaveAttribute('aria-pressed', 'false')
    await window.locator('[data-testid="diagram-sidepane-open-ai"]').click()
    await expect(pane).toBeVisible()
    await window.locator('[data-testid="diagram-sidepane-toggle"]').click()
    await expect(edge).toBeVisible()

    // Insert › AI diagram opens it (and never closes it if already open).
    await window.locator('[data-testid="diagram-toolbar-tab-insert"]').click()
    await window.locator('[data-testid="diagram-insert-ai"]').click()
    await expect(pane).toBeVisible()
    await window.locator('[data-testid="diagram-insert-ai"]').click()
    await expect(pane).toBeVisible()

    // Remembered per app: reopen the diagram after a reload and the pane is still open.
    await window.reload()
    await waitForReady(window)
    await window.evaluate((docId: string) => (window as unknown as { __fbView?: { getState: () => { goDocument: (i: string) => void } } }).__fbView?.getState().goDocument(docId), id)
    await expect(window.locator('[data-testid="diagram-editor"]')).toBeVisible({ timeout: 12_000 })
    await expect(pane).toBeVisible()
    await expect(window.locator('[data-testid="diagram-ai-prompt"]')).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await dispose()
  }
})
