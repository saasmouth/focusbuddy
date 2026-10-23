// REAL input proof for the menu contract (SPEC §9): in each office app a menu
// bar menu opens and a row runs, and a right-click on an object opens the
// kit's menu, by CGEvents through the macOS window server, not CDP. Rails and
// ContextBar tabs have their own real-input sweep (_realClickRailsTabs, 82).
// Not part of the suite (underscore = sweep): it moves the real mouse, and puts
// it back. Every action first checks that elementFromPoint at the target IS the
// control (a covered control fails here rather than "clicking" through).
//
// Run: npx playwright test _realClickMenus   Screenshots → MENUS_REAL_SHOTS.

import { test, expect, type Page, type ElectronApplication } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'
import { acquireRealInput, releaseRealInput } from './_realInputLock'
import { cursorLocation, moveMouse, postMouse, postRightClick, type ScreenPoint } from './_macMouse'

const SHOTS = process.env.MENUS_REAL_SHOTS ?? '/private/tmp/claude-501/menu-contract-real-shots'

let launched: LaunchedApp | null = null
let window: Page
let app: ElectronApplication
let restore: ScreenPoint

test.beforeAll(async () => {
  // Real input is one spec at a time across workers (_realInputLock.ts).
  test.setTimeout(240_000)
  await acquireRealInput('_realClickMenus')
  mkdirSync(SHOTS, { recursive: true })
  restore = cursorLocation()
  launched = await launchApp()
  window = launched.window
  app = launched.app
  await waitForReady(window)
  await suppressFeatureSpotlights(window)
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
  try {
    moveMouse(restore)
    if (launched) {
      await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setAlwaysOnTop(false)).catch(() => undefined)
      await launched.dispose()
    }
  } finally {
    releaseRealInput()
  }
})

async function toScreen(x: number, y: number): Promise<ScreenPoint> {
  const cb = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentBounds())
  const iw = await window.evaluate(() => window.innerWidth)
  const s = cb.width / iw
  return { x: Math.round(cb.x + x * s), y: Math.round(cb.y + y * s) }
}

/** The element's centre, and whether it is what a hand would hit there. */
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
  postMouse([{ kind: 'move', at: p }, { kind: 'down', at: p }, { kind: 'up', at: p }], 30)
  await window.waitForTimeout(400)
}

async function realRightClick(sel: string): Promise<void> {
  const t = await target(sel)
  expect(t.onTop, `${sel} is covered at its centre`).toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus())
  postRightClick(await toScreen(t.x, t.y))
  await window.waitForTimeout(500)
}

/** A menu row by its label, as a selector the real click can aim at. */
async function rowSelector(list: string, label: string): Promise<string> {
  const idx = await window.evaluate(
    ({ list, label }) => {
      const rows = Array.from(document.querySelectorAll(`${list} button`)) as HTMLElement[]
      const i = rows.findIndex((b) => ((b.querySelector('span.flex-1')?.firstChild?.textContent ?? '') as string).trim() === label)
      if (i >= 0) rows[i]!.setAttribute('data-real-row', label)
      return i
    },
    { list, label }
  )
  expect(idx, `${label} is in ${list}`).toBeGreaterThanOrEqual(0)
  return `[data-real-row="${label}"]`
}

async function open(docType: string, body?: unknown): Promise<void> {
  await window.evaluate(
    async ({ dt, b }) => {
      const w = window as unknown as { api: { documents: { create: (o: Record<string, unknown>) => Promise<{ id: string }> } }; __fbView?: { getState: () => { goDocument: (id: string) => void } } }
      const d = await w.api.documents.create({ docType: dt, title: 'Real menus', ...(b ? { body: b } : {}) })
      w.__fbView?.getState().goDocument(d.id)
    },
    { dt: docType, b: body }
  )
  await window.waitForTimeout(1500)
}

const CASES = [
  { name: 'Write', docType: 'doc', item: 'doc-menu', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Real words here' }] }] }, object: null, menu: null },
  { name: 'Cells', docType: 'sheet', item: 'sheet-menubar', body: undefined, object: '[data-testid="cell-1-1"]', menu: 'sheet-cell-menu' },
  {
    name: 'Deck',
    docType: 'slides',
    item: 'slides-menubar',
    body: { schemaVersion: 2, slides: [{ id: 's1', notes: '', schemaVersion: 2, elements: [{ id: 'e1', type: 'text', x: 300, y: 250, w: 400, h: 100, z: 1, paragraphs: [{ runs: [{ text: 'Real slide' }] }] }] }] },
    object: '.react-draggable:has([data-element-id="e1"])',
    menu: 'slides-context-menu'
  },
  {
    name: 'Diagrams',
    docType: 'map',
    item: 'draw-menubar',
    body: { version: 1, nodes: [{ id: 'a', x: 200, y: 160, label: 'Node A', shape: 'process', width: 160, height: 80 }], edges: [] },
    object: '.react-flow__node[data-id="a"]',
    menu: 'diagram-context-menu'
  },
  {
    name: 'Design',
    docType: 'design',
    item: 'design-menubar',
    body: { width: 794, height: 1123, elements: [{ id: 'f1', type: 'shape', shape: 'rect', x: 120, y: 160, w: 300, h: 200, z: 1 }] },
    object: '.react-draggable:has([data-element-id="f1"])',
    menu: 'design-context-menu'
  }
]

for (const c of CASES) {
  test(`${c.name}: real clicks open a menu and run a row; a real right-click opens the kit's menu`, async () => {
    test.setTimeout(120_000)
    await open(c.docType, c.body)
    // Menu bar: Edit opens…
    await realClick(`[data-testid="${c.item}-edit"]`)
    await expect(window.locator(`[data-testid="${c.item}-edit-list"]`), `${c.name}: Edit opened by a real click`).toBeVisible()
    await window.screenshot({ path: join(SHOTS, `${c.name}-edit.png`) })
    await window.keyboard.press('Escape')
    // …and a row runs: Help › Keyboard shortcuts opens the app's sheet.
    await realClick(`[data-testid="${c.item}-help"]`)
    await realClick(await rowSelector(`[data-testid="${c.item}-help-list"]`, 'Keyboard shortcuts'))
    const sheet = c.name === 'Diagrams' ? window.locator('[data-testid="diagram-shortcuts"]') : window.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(sheet, `${c.name}: the row ran`).toBeVisible()
    await window.keyboard.press('Escape')
    if (await sheet.isVisible()) await sheet.getByTitle('Close').first().click()
    // Right-click.
    if (c.object && c.menu) {
      await realRightClick(c.object)
      const menu = window.locator(`[data-testid="${c.menu}"]`)
      await expect(menu, `${c.name}: a real right-click opened the kit menu`).toBeVisible()
      await expect(menu).toHaveAttribute('role', 'menu')
      await window.screenshot({ path: join(SHOTS, `${c.name}-right-click.png`) })
      await window.keyboard.press('Escape')
    }
    // Write's text right-click is the macOS native menu (2e's wp3, with its own
    // e2e). A real right-click there opens a modal menu this sweep cannot close,
    // so Write's real-input proof here is its menu bar.
  })
}
