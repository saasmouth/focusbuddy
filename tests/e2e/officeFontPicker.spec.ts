// The font picker works inside the office shell's ContextBar.
//
// Row 2 scrolls sideways (overflow-x: auto), which clips vertically too, so the
// picker's panel used to be cut to the 36px row: it opened, but its search box
// and font list were unreachable. The panel is portalled now. This checks, per
// app, that the panel extends below the bar, that its search field and a font
// row are genuinely on top where they are drawn, and that picking a font
// applies it. Each converted app with a font control adds itself to APPS.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, selectBarTab, type LaunchedApp } from './_helpers'

interface FontCase {
  name: string
  docType: string
  bar: string
  /** Bring a font control on screen (select text, pick a tab). */
  prepare: (window: Page) => Promise<void>
  /** Read back the applied font family, from the app's own state. */
  applied: (window: Page) => Promise<string>
}

const APPS: FontCase[] = [
  {
    name: 'PlexiiWrite',
    docType: 'doc',
    bar: 'doc-toolbar',
    prepare: async (window) => {
      const editor = window.locator('[data-testid="doc-editor-surface"]') // the ProseMirror editable itself
      await expect(editor).toBeVisible({ timeout: 12_000 })
      await editor.click()
      await window.keyboard.type('Font check')
      await window.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
      await selectBarTab(window, 'doc-toolbar', 'home')
    },
    // Every font family used inside the editor's text (a selector list would return the <p>
    // before the styled <span> inside it, in document order).
    applied: (window) =>
      window.evaluate(() =>
        [...new Set(Array.from(document.querySelectorAll('[data-testid="doc-editor-surface"] p, [data-testid="doc-editor-surface"] p *')).map((el) => getComputedStyle(el).fontFamily))].join('|')
      )
  },
  {
    name: 'PlexiiDeck',
    docType: 'slides',
    bar: 'slides-toolbar',
    prepare: async (window) => {
      const text = window.locator('[data-testid="slide-element"][data-eltype="text"]').first()
      await expect(text).toBeVisible({ timeout: 12_000 })
      await text.click({ force: true }) // the element layer is pointer-events:none; the frame beneath selects
      await selectBarTab(window, 'slides-toolbar', 'home')
      await expect(window.locator('[data-testid="slides-font"]')).toBeVisible()
    },
    applied: (window) =>
      window.evaluate(async () => {
        const api = (window as unknown as { api: typeof window.api }).api
        const docs = await api.documents.list()
        const doc = await api.documents.get(docs[0]!.id)
        const els = ((doc?.body as { slides?: Array<{ elements?: Array<{ type: string; fontFamily?: string }> }> })?.slides?.[0]?.elements ?? []).filter((e) => e.type === 'text')
        return els.map((e) => e.fontFamily ?? '').join('|')
      })
  }
]

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function onTop(window: Page, selector: string): Promise<boolean> {
  return window.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) return false
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return false
    const hit = document.elementFromPoint(r.left + Math.min(12, r.width / 2), r.top + r.height / 2)
    return !!hit && (hit === el || el.contains(hit))
  }, selector)
}

for (const app of APPS) {
  test(`${app.name} — the font picker opens fully over the bar and applies a font`, async () => {
    launched = await launchApp()
    const { window } = launched
    await waitForReady(window)
    await window.evaluate(() => (window as unknown as { api: { ai: { setMode: (m: string) => Promise<unknown> } } }).api.ai.setMode('auto'))
    const intro = window.locator('[data-testid="local-ai-intro-dismiss"]')
    await window.evaluate(async (t: string) => {
      const w = window as unknown as { api: { documents: { create: (o: Record<string, unknown>) => Promise<{ id: string }> } }; __fbView?: { getState: () => { goDocument: (id: string) => void } } }
      const d = await w.api.documents.create({ docType: t, title: 'Font picker' })
      w.__fbView?.getState().goDocument(d.id)
    }, app.docType)
    if (await intro.isVisible().catch(() => false)) await intro.click()
    await app.prepare(window)

    const btn = window.locator(`[data-testid="${app.bar}"] [data-testid="font-picker-btn"]`)
    await btn.click()
    const panel = window.locator('[data-testid="font-picker-panel"]')
    await expect(panel).toBeVisible()
    const [p, bar] = await window.evaluate((barSel) => {
      const r = (el: Element | null): { top: number; bottom: number; height: number } => {
        const b = el!.getBoundingClientRect()
        return { top: b.top, bottom: b.bottom, height: b.height }
      }
      return [r(document.querySelector('[data-testid="font-picker-panel"]')), r(document.querySelector(barSel))]
    }, `[data-testid="${app.bar}"]`)
    expect(p.height, 'the panel is its full height, not cut to the row').toBeGreaterThan(120)
    expect(p.bottom, 'the panel extends below the bar').toBeGreaterThan(bar.bottom + 60)
    expect(await onTop(window, '[data-testid="font-picker-panel"] input'), 'the search field is on top').toBe(true)

    // Pick "Serif" (a generic stack every app offers) and read it back from the app.
    const serif = panel.getByRole('button', { name: 'Serif', exact: true })
    await serif.scrollIntoViewIfNeeded()
    // A clipped panel still reports its full box, so prove the row is what a click would hit.
    await serif.evaluate((el) => el.setAttribute('data-probe', 'serif'))
    expect(await onTop(window, '[data-probe="serif"]'), 'the font row is on top (not clipped by Row 2)').toBe(true)
    await serif.click()
    await expect(panel).toHaveCount(0)
    await expect.poll(() => app.applied(window), { timeout: 6_000 }).toMatch(/Georgia/)

    // Escape closes it too, and an outside press does.
    await btn.click()
    await expect(panel).toBeVisible()
    await panel.locator('input').press('Escape')
    await expect(panel).toHaveCount(0)
  })
}
