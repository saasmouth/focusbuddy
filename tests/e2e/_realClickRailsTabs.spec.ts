// REAL input proof for the rail and tab contract (SPEC §3.9), one rail tool and
// one tab per office app, plus one real arm-and-drag placement in Deck.
// Not part of the suite (underscore = sweep): it moves the real mouse.
//
// Playwright input goes through CDP and bypasses the macOS hit-test, so a
// control under a window drag region (or a hover-gated cover) passes every
// e2e and still does nothing for a person (memory: titlebar-drag-region-eats-
// clicks). These clicks are CGEvents posted by the click/drag tools, with the
// window pinned on top, and every click first checks that elementFromPoint at
// the target point IS the control. RR-0 proves the method can fail: a drag
// region laid over the tab strip makes the real click miss while Playwright's
// click still lands.
//
// Run: npx playwright test _realClickRailsTabs   (PLEXI_APP=preview3, throwaway profile)
// Screenshots of each app's rail and tabs go to RAILS_REAL_SHOTS.

import { test, expect, type Page, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'
import { seedDrawDoc, openDocument, v1Body } from './_drawHelpers'

const CLICK = process.env.RAILS_REAL_CLICK ?? '/private/tmp/claude-501/vsreal/click'
const DRAG = process.env.RAILS_REAL_DRAG ?? '/private/tmp/claude-501/files-flyout-logs/real/drag'
const SHOTS = process.env.RAILS_REAL_SHOTS ?? '/private/tmp/claude-501/rails-tabs-41-shots'

let launched: LaunchedApp | null = null
let window: Page
let app: ElectronApplication

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true })
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
    win.setAlwaysOnTop(true, 'floating')
    win.show()
    win.focus()
  })
  await window.waitForTimeout(700)
})
test.afterAll(async () => {
  if (launched) {
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setAlwaysOnTop(false)).catch(() => undefined)
    await launched.dispose()
  }
})

async function toScreen(x: number, y: number): Promise<{ x: number; y: number }> {
  const cb = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentBounds())
  const iw = await window.evaluate(() => window.innerWidth)
  const s = cb.width / iw
  return { x: Math.round(cb.x + x * s), y: Math.round(cb.y + y * s) }
}

/** The control's centre, and whether it is what a person would hit there (one read). */
async function target(sel: string): Promise<{ x: number; y: number; onTop: boolean }> {
  return window.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null
    if (!el) return { x: 0, y: 0, onTop: false }
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { x, y, onTop: !!hit && (hit === el || el.contains(hit)) }
  }, sel)
}

async function realClick(sel: string): Promise<void> {
  const t = await target(sel)
  expect(t.onTop, `${sel} is covered at its centre`).toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus())
  const p = await toScreen(t.x, t.y)
  execFileSync(CLICK, [String(p.x), String(p.y)])
  await window.waitForTimeout(400)
}

async function openNew(docType: string): Promise<void> {
  await window.evaluate(async (dt) => {
    const w = window as unknown as { api: { documents: { create: (o: Record<string, unknown>) => Promise<{ id: string }> } }; __fbView?: { getState: () => { goDocument: (id: string) => void } } }
    const d = await w.api.documents.create({ docType: dt, title: 'Real clicks' })
    w.__fbView?.getState().goDocument(d.id)
  }, docType)
}

interface Case {
  name: string
  open: () => Promise<void>
  shell: string
  bar: string
  rail: string
  /** A rail item and the attribute that proves the click landed. */
  tool: string
  toolProof: [string, string]
  tab: string
}

const q = (id: string): string => `[data-testid="${id}"]`

const CASES: Case[] = [
  { name: 'Write', open: () => openNew('doc'), shell: 'doc-shell', bar: 'doc-toolbar', rail: 'doc-rail', tool: 'doc-toggle-styles', toolProof: ['aria-pressed', 'true'], tab: 'layout' },
  { name: 'Cells', open: () => openNew('sheet'), shell: 'sheet-shell', bar: 'sheet-toolbar', rail: 'sheet-rail', tool: 'sheet-rail-filter', toolProof: ['aria-pressed', 'true'], tab: 'data' },
  { name: 'Deck', open: () => openNew('slides'), shell: 'slides-shell', bar: 'slides-toolbar', rail: 'slides-rail', tool: 'slides-tool-rect', toolProof: ['aria-pressed', 'true'], tab: 'design' },
  { name: 'Design', open: () => openNew('design'), shell: 'design-shell', bar: 'design-toolbar', rail: 'design-rail', tool: 'design-tool-text', toolProof: ['aria-pressed', 'true'], tab: 'arrange' },
  { name: 'Diagrams', open: () => openNew('map'), shell: 'diagram-shell', bar: 'diagram-toolbar', rail: 'diagram-rail', tool: 'diagram-tool-text', toolProof: ['aria-pressed', 'true'], tab: 'arrange' },
  {
    name: 'Draw',
    open: async () => openDocument(window, await seedDrawDoc(window, v1Body([]))),
    shell: 'draw-shell',
    bar: 'draw-bar',
    rail: 'draw-toolbox',
    tool: 'draw-tool-hand',
    toolProof: ['aria-pressed', 'true'],
    tab: 'insert'
  }
]

test('RR-0 the method can fail: a drag region over the tabs eats the real click while Playwright’s click still lands', async () => {
  await openNew('slides')
  await expect(window.locator(q('slides-toolbar-tab-home'))).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 })
  await window.evaluate(() => {
    const strip = document.querySelector('[data-testid="slides-toolbar"] [role="tablist"]')!.getBoundingClientRect()
    const d = document.createElement('div')
    d.id = 'rr0-drag'
    Object.assign(d.style, { position: 'fixed', left: `${strip.left}px`, top: `${strip.top}px`, width: `${strip.width}px`, height: `${strip.height}px`, pointerEvents: 'none', zIndex: '9999' })
    d.style.setProperty('-webkit-app-region', 'drag')
    document.body.appendChild(d)
  })
  await window.waitForTimeout(300)
  const t = await target(q('slides-toolbar-tab-insert'))
  const p = await toScreen(t.x, t.y)
  execFileSync(CLICK, [String(p.x), String(p.y)])
  await window.waitForTimeout(400)
  const realLanded = (await window.locator(q('slides-toolbar-tab-insert')).getAttribute('aria-selected')) === 'true'
  await window.locator(q('slides-toolbar-tab-insert')).click()
  const cdpLanded = (await window.locator(q('slides-toolbar-tab-insert')).getAttribute('aria-selected')) === 'true'
  await window.evaluate(() => document.getElementById('rr0-drag')?.remove())
  // Put the window back where the other cases expect it (a drag region click may have moved it).
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ x: 60, y: 60, width: 1400, height: 900 }))
  await window.waitForTimeout(400)
  console.log(`RR-0 real click landed: ${realLanded}; Playwright click landed: ${cdpLanded}`)
  expect(cdpLanded, 'Playwright clicks through a drag region').toBe(true)
  expect(realLanded, 'a real click under a drag region must NOT land: if it does, this method proves nothing').toBe(false)
})

for (const c of CASES)
  test(`RR ${c.name}: a real click on a rail tool and on a tab lands; screenshot of the rail and tabs`, async () => {
    await c.open()
    await expect(window.locator(q(c.rail))).toBeVisible({ timeout: 10_000 })
    await expect(window.locator(q(`${c.bar}-tab-home`))).toHaveAttribute('aria-selected', 'true')
    await window.waitForTimeout(500)
    await window.screenshot({ path: join(SHOTS, `${c.name}-home.png`) })

    await realClick(q(c.tool))
    await expect(window.locator(q(c.tool)), `${c.name}: the real click on ${c.tool} landed`).toHaveAttribute(c.toolProof[0], c.toolProof[1])
    await realClick(q(`${c.bar}-tab-${c.tab}`))
    await expect(window.locator(q(`${c.bar}-tab-${c.tab}`)), `${c.name}: the real click on the ${c.tab} tab landed`).toHaveAttribute('aria-selected', 'true')
    await window.waitForTimeout(300)
    await window.screenshot({ path: join(SHOTS, `${c.name}-${c.tab}.png`) })
    console.log(`RR ${c.name}: ${c.tool} and ${c.bar}-tab-${c.tab} landed under real clicks`)
    // Leave nothing armed or pressed for the next app.
    await window.keyboard.press('Escape')
  })

test('RR-D Deck: a real arm-and-drag places a rectangle and the rail returns to Select', async () => {
  await openNew('slides')
  const canvas = q('slide-canvas')
  await expect(window.locator(canvas)).toBeVisible({ timeout: 10_000 })
  const before = await window.locator(`${canvas} [data-testid="slide-element"]`).count()
  await realClick(q('slides-tool-rect'))
  await expect(window.locator(q('slides-tool-rect'))).toHaveAttribute('aria-pressed', 'true')
  const box = (await window.locator(canvas).boundingBox())!
  const a = await toScreen(box.x + box.width * 0.3, box.y + box.height * 0.3)
  const b = await toScreen(box.x + box.width * 0.5, box.y + box.height * 0.55)
  execFileSync(DRAG, [String(a.x), String(a.y), String(b.x), String(b.y)])
  await window.waitForTimeout(800)
  await expect(window.locator(`${canvas} [data-testid="slide-element"]`)).toHaveCount(before + 1)
  await expect(window.locator(q('slides-tool-select'))).toHaveAttribute('aria-pressed', 'true')
  console.log('RR-D Deck: real drag placed one rectangle, rail back on Select')
})
