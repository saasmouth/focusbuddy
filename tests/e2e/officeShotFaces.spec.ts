/**
 * What the office apps SHOW, read the way a person reads the screen. Each case
 * is a defect seen in the rails-tabs-41 whole-window screenshots that every
 * selector-level spec passed straight through:
 *
 *   SF-1 Cells headings read "A A", "B B" … (the letter, then a name that was
 *        only the letter again).
 *   SF-2 Write's Styles button read "Styles — apply and customise paragraph
 *        styles" over two lines; its font size read "—" in an empty document.
 *   SF-3 Write's empty document drew no prompt at all.
 *   SF-4 A diagram created outside the store sat in the open-item tray as
 *        "Document", struck through as if deleted.
 *   SF-5 The PlexiiAssist pill covered the corner of Diagrams' minimap.
 *
 * Same window as the screenshot sweep (1400 x 900), because SF-2's wrap and
 * SF-5's overlap depend on it.
 */

import { test, expect, type Page, type ElectronApplication } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
let window: Page
let app: ElectronApplication

test.beforeAll(async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  window = launched.window
  app = launched.app
  await waitForReady(window)
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await chooseCloudAiSource(window)
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    win.setMinimumSize(800, 600)
    win.setBounds({ x: 60, y: 60, width: 1400, height: 900 })
  })
  await window.waitForTimeout(500)
})
test.afterAll(async () => {
  await launched?.dispose()
})

/** Created through the API, not the store: the way an AI tool or another device makes one. */
async function openNew(docType: string, title: string): Promise<string> {
  return window.evaluate(
    async ([dt, t]) => {
      const w = window as unknown as {
        api: { documents: { create: (o: Record<string, unknown>) => Promise<{ id: string }> } }
        __fbView?: { getState: () => { goDocument: (id: string) => void } }
      }
      const d = await w.api.documents.create({ docType: dt, title: t })
      w.__fbView?.getState().goDocument(d.id)
      return d.id
    },
    [docType, title] as const
  )
}

/** A control's face: its text without the icon glyph names (Material ligatures). */
function faceText(sel: string): Promise<string> {
  return window.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return '<missing>'
    const c = el.cloneNode(true) as Element
    c.querySelectorAll('.material-symbols-outlined, svg').forEach((n) => n.remove())
    return (c.textContent ?? '').trim()
  }, sel)
}

test('SF-1 a new sheet’s column headings read their letter once', async () => {
  await openNew('sheet', 'Faces sheet')
  await expect(window.locator('[data-testid="sheet-grid"]')).toBeVisible({ timeout: 10_000 })
  const headings = await window.evaluate(() =>
    [0, 1, 2, 3].map((c) => {
      const th = document.querySelector(`[data-testid="col-header-${c}"]`) as HTMLElement
      const name = (th.querySelector('input') as HTMLInputElement).value
      return [th.innerText.trim(), name].filter(Boolean).join(' ')
    })
  )
  expect(headings).toEqual(['A', 'B', 'C', 'D'])
})

test('SF-2 Write’s Styles button reads "Styles" on one line, and the font size shows a size', async () => {
  await openNew('doc', 'Faces doc')
  const styles = window.locator('[data-testid="doc-styles-btn"]')
  await expect(styles).toBeVisible({ timeout: 10_000 })
  expect(await faceText('[data-testid="doc-styles-btn"]')).toBe('Styles')
  const lines = await styles.evaluate((b) => {
    const span = Array.from(b.querySelectorAll('span')).find((s) => !s.classList.contains('material-symbols-outlined'))!
    return Math.round(span.getBoundingClientRect().height / parseFloat(getComputedStyle(span).lineHeight || '16'))
  })
  expect(lines, 'the Styles label wraps').toBe(1)
  const size = window.locator('[data-testid="doc-toolbar"] [data-bar-semantic="font-size"]')
  const paraPx = await window.evaluate(() => Math.round(parseFloat(getComputedStyle(document.querySelector('[data-testid="doc-editor-surface"] p')!).fontSize)))
  await expect(size).toHaveValue(String(paraPx))
})

test('SF-3 Write’s empty document shows where to type', async () => {
  await openNew('doc', 'Faces empty doc')
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 10_000 })
  const shown = await window.evaluate(() => getComputedStyle(document.querySelector('[data-testid="doc-editor-surface"] p')!, '::before').content)
  expect(shown).toContain('Write something')
})

test('SF-4 a diagram made outside the store is named in the tray, not struck through as gone', async () => {
  const id = await openNew('map', 'Faces diagram')
  await expect(window.locator('[data-testid="diagram-canvas"]')).toBeVisible({ timeout: 10_000 })
  const item = window.locator(`[data-testid="tray-item-document:${id}"]`)
  await expect(item).toContainText('Faces diagram', { timeout: 5_000 })
  const struck = await item.locator('span.truncate').evaluate((s) => getComputedStyle(s).textDecorationLine)
  expect(struck).not.toContain('line-through')
})

test('SF-5 the PlexiiAssist pill does not cover Diagrams’ minimap', async () => {
  await openNew('map', 'Faces minimap')
  const mini = window.locator('[data-testid="diagram-canvas"] .react-flow__minimap')
  await expect(mini).toBeVisible({ timeout: 10_000 })
  const pill = window.locator('[data-testid="assistant-pill"]')
  await expect(pill).toBeVisible()
  await expect
    .poll(async () => {
      const [m, p] = [await mini.boundingBox(), await pill.boundingBox()]
      if (!m || !p) return 'unmeasured'
      const overlap = m.x < p.x + p.width && m.x + m.width > p.x && m.y < p.y + p.height && m.y + m.height > p.y
      return overlap ? 'overlaps' : 'clear'
    }, { timeout: 3_000 })
    .toBe('clear')
})
