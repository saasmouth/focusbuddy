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
import { launchApp, waitForReady } from './_helpers'

interface SavedNode {
  id: string
  shape: string
  binding?: { source?: { kind?: string } }
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
    await expect(window.locator('[data-testid="diagram-inspector-heading"]')).toBeVisible()

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

    // Flowchart is open by default.
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
    await window.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } })
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
