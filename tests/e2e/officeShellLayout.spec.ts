// Office shell layout guard (SPEC §8): nothing of the shell sits under the
// floating menu or the header, every control is genuinely on top where it is
// drawn (elementFromPoint, the deskChromeNotUnderMenu technique), overlay panels
// never cover the rail or the bar, and the narrow behaviour folds instead of
// clipping. The shared right side pane docks right of the canvas, never over
// the rail or the bar, and its controls are on top. Run per app at three sizes: default, the floating menu at its widest
// (480px), and a narrow window that puts the editor under 520px. Each converted
// app adds itself to APPS.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

interface AppCase {
  name: string
  docType: string
  shell: string // OfficeShellLayout testid
  bar: string // ContextBar testid
  rail: string // ToolRail testid
  canvas: string
  panelOpener: string // a rail item that opens an overlay panel
  panel: string // that panel's testid
  undo: string
  corner?: string // a control at the bottom-right of the editor (pages bar), which must stay clear of the Plexii pill
  sidePane?: { toggle: string; pane: string; content: string } // the shared right content pane (ShellSidePane)
}

const APPS: AppCase[] = [
  {
    name: 'PlexiiDiagrams',
    docType: 'map',
    shell: 'diagram-shell',
    bar: 'diagram-toolbar',
    rail: 'diagram-rail',
    canvas: 'diagram-canvas',
    panelOpener: 'diagram-toggle-library',
    panel: 'diagram-panel-library',
    undo: 'diagram-undo',
    corner: 'diagram-layers-toggle',
    sidePane: { toggle: 'diagram-sidepane-toggle', pane: 'diagram-sidepane', content: 'diagram-ai-pane' }
  }
]

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openDoc(window: Page, docType: string): Promise<void> {
  await window.evaluate(() => (window as unknown as { api: { ai: { setMode: (m: string) => Promise<unknown> } } }).api.ai.setMode('auto'))
  await window.evaluate(async (t: string) => {
    const w = window as unknown as { api: { documents: { create: (o: Record<string, unknown>) => Promise<{ id: string }> } }; __fbView?: { getState: () => { goDocument: (id: string) => void } } }
    const d = await w.api.documents.create({ docType: t, title: 'Layout guard' })
    w.__fbView?.getState().goDocument(d.id)
  }, docType)
}

/** Is the element itself what the user would hit at 12px in, mid-height? */
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

const box = async (window: Page, sel: string): Promise<{ x: number; y: number; width: number; height: number }> => {
  const b = await window.locator(sel).first().boundingBox()
  if (!b) throw new Error(`no box for ${sel}`)
  return b
}

type Box = { x: number; y: number; width: number; height: number }
/** Several rects from ONE frame: a desk widget can still be settling, so separate reads disagree. */
async function boxes(window: Page, sels: string[]): Promise<Box[]> {
  return window.evaluate((list) => {
    return list.map((sel) => {
      const el = document.querySelector(sel)
      if (!el) throw new Error(`no box for ${sel}`)
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    })
  }, sels)
}

async function checkShell(window: Page, app: AppCase, label: string): Promise<void> {
  const t = (id: string): string => `[data-testid="${id}"]`
  await expect(window.locator(t(app.rail))).toBeVisible({ timeout: 12_000 })
  // The one-time Local AI card sits bottom-centre on a fresh profile; dismiss it as a person would.
  const intro = window.locator('[data-testid="local-ai-intro-dismiss"]')
  if (await intro.isVisible().catch(() => false)) await intro.click()

  // 1. Not under the floating menu, and below the bar.
  const dock = await box(window, '[data-testid="sidebar-dock"]').catch(() => null)
  const rail = await box(window, t(app.rail))
  const bar = await box(window, t(app.bar))
  if (dock) expect(rail.x, `${label}: rail clear of the floating menu`).toBeGreaterThanOrEqual(dock.x + dock.width - 1)
  expect(rail.y, `${label}: rail below the bar`).toBeGreaterThanOrEqual(bar.y + bar.height - 1)

  // 2. Everything that matters is genuinely on top where it is drawn.
  const railButtons = window.locator(`${t(app.rail)} > div > span > button, ${t(app.rail)} button[data-rail-kind]`)
  const n = await railButtons.count()
  expect(n, `${label}: rail has items`).toBeGreaterThan(2)
  const firstId = await railButtons.first().getAttribute('data-testid')
  const lastId = await railButtons.last().getAttribute('data-testid')
  expect(await onTop(window, `[data-testid="${firstId}"]`), `${label}: first rail item on top`).toBe(true)
  // The last (bottom-pinned) item may need the rail to scroll at narrow heights.
  await window.locator(`[data-testid="${lastId}"]`).scrollIntoViewIfNeeded()
  expect(await onTop(window, `[data-testid="${lastId}"]`), `${label}: last rail item on top`).toBe(true)
  expect(await onTop(window, t(app.undo)), `${label}: pinned Undo on top`).toBe(true)
  const tabs = await window.locator(`${t(app.bar)} [role="tab"]`).all()
  expect(tabs.length, `${label}: tabs`).toBeGreaterThan(0)
  for (const tab of tabs) {
    const id = await tab.getAttribute('data-testid')
    expect(await onTop(window, `[data-testid="${id}"]`), `${label}: tab ${id} on top`).toBe(true)
  }
  const firstControl = window.locator(`${t(`${app.bar}-panel`)} [role="toolbar"] button, ${t(`${app.bar}-panel`)} [role="toolbar"] select`).first()
  const fcId = await firstControl.evaluate((el) => {
    if (!el.getAttribute('data-testid')) el.setAttribute('data-testid', '__first-row2-control')
    return el.getAttribute('data-testid')
  })
  expect(await onTop(window, `[data-testid="${fcId}"]`), `${label}: first Row 2 control on top`).toBe(true)

  if (app.corner) expect(await onTop(window, t(app.corner)), `${label}: bottom-right control clear of the Plexii pill`).toBe(true)

  // 3. An open overlay panel never covers the rail or the bar, and its close button is on top.
  await window.locator(t(app.panelOpener)).click()
  await expect(window.locator(t(app.panel))).toBeVisible()
  const [panel, railNow, barNow] = await boxes(window, [t(app.panel), t(app.rail), t(app.bar)])
  expect(panel.x, `${label}: panel clear of the rail`).toBeGreaterThanOrEqual(railNow.x + railNow.width - 1)
  expect(panel.y, `${label}: panel below the bar`).toBeGreaterThanOrEqual(barNow.y + barNow.height - 1)
  expect(await onTop(window, t(`${app.panel}-close`)), `${label}: panel close on top`).toBe(true)
  await window.locator(t(`${app.panel}-close`)).click()
  await expect(window.locator(t(app.panel))).toHaveCount(0)

  // 4. The right side pane: collapsed it is a slim edge tab; opened from the top bar it docks right of the canvas.
  if (app.sidePane) {
    await checkSidePane(window, app, app.sidePane, label)
  }
}

async function checkSidePane(window: Page, app: AppCase, sp: NonNullable<AppCase['sidePane']>, label: string): Promise<void> {
  const t = (id: string): string => `[data-testid="${id}"]`
  if (await window.locator(t(sp.pane)).count()) await window.locator(t(`${sp.pane}-collapse`)).click()
  await expect(window.locator(t(`${sp.pane}-edge`))).toBeVisible()
  expect(await onTop(window, `${t(`${sp.pane}-edge`)} button`), `${label}: edge tab on top`).toBe(true)
  expect(await onTop(window, t(sp.toggle)), `${label}: side pane toggle on top`).toBe(true)
  await window.locator(t(sp.toggle)).click()
  await expect(window.locator(t(sp.content))).toBeVisible()
  const [pane, rail, bar, main] = await boxes(window, [t(sp.pane), t(app.rail), t(app.bar), t(`${app.shell}-main`)])
  expect(pane.x, `${label}: side pane clear of the rail`).toBeGreaterThanOrEqual(rail.x + rail.width - 1)
  expect(pane.y, `${label}: side pane below the bar`).toBeGreaterThanOrEqual(bar.y + bar.height - 1)
  if (!(await window.locator(t(sp.pane)).getAttribute('data-sheet'))) {
    expect(pane.x, `${label}: docked side pane sits right of the canvas`).toBeGreaterThanOrEqual(main.x + main.width - 1)
  }
  expect(await onTop(window, t(`${sp.pane}-collapse`)), `${label}: side pane collapse on top`).toBe(true)
  // The pane's bottom-right content area is not under the Plexii pill (it reserves the corner in a full editor).
  const inner = await window.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const x = r.right - 20
    const y = r.bottom - parseFloat(cs.paddingBottom) - 8
    const hit = document.elementFromPoint(x, y)
    return !!hit && el.contains(hit) || hit === el
  }, t(sp.content))
  expect(inner, `${label}: side pane content corner clear of the Plexii pill`).toBe(true)
  // The rail stays usable while the pane is open.
  await window.locator(`${t(app.rail)} button[data-rail-kind]`).first().scrollIntoViewIfNeeded() // the rail scrolls at small heights
  expect(await onTop(window, `${t(app.rail)} button[data-rail-kind]`), `${label}: rail on top with the pane open`).toBe(true)
  await window.locator(t(`${sp.pane}-collapse`)).click()
  await expect(window.locator(t(`${sp.pane}-edge`))).toBeVisible()
}

for (const app of APPS) {
  test(`${app.name} — shell layout at the default size`, async () => {
    launched = await launchApp()
    await waitForReady(launched.window)
    await openDoc(launched.window, app.docType)
    await checkShell(launched.window, app, 'default')
  })

  test(`${app.name} — shell layout with the floating menu at its widest (480px)`, async () => {
    launched = await launchApp()
    const { window } = launched
    await waitForReady(window)
    await window.evaluate(() => localStorage.setItem('fb.sidebar.width', '480'))
    await window.reload()
    await waitForReady(window)
    const dock = await box(window, '[data-testid="sidebar-dock"]')
    expect(dock.width).toBeGreaterThan(470)
    await openDoc(window, app.docType)
    await checkShell(window, app, 'menu 480')
  })

  test(`${app.name} — narrow, embedded in a desk widget: Row 1 folds and everything stays reachable`, async () => {
    // The app window never goes below 1100px, so a narrow editor only happens
    // EMBEDDED: a document widget on a desk (3e's case: widgets resize small).
    launched = await launchApp()
    const { window } = launched
    await waitForReady(window)
    await window.evaluate(() => (window as unknown as { api: { ai: { setMode: (m: string) => Promise<unknown> } } }).api.ai.setMode('auto'))
    const taskId = await window.evaluate(async (docType: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Narrow shell' })
      const doc = await api.documents.create({ docType, title: 'Narrow' } as never)
      await api.widgets.create({ taskId: task.id, kind: docType, content: (doc as { id: string }).id, x: 240, y: 160, width: 480, height: 380 } as never)
      return task.id
    }, app.docType)
    await window.reload()
    await waitForReady(window)
    await window.evaluate((id: string) => (window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }).__fbView?.getState().goTask(id), taskId)
    // Kept clear of the desk's 80px hover edge-pan zone: a cursor resting on the rail there would pan the camera.
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 15_000 })
    await expect(window.locator(`[data-testid="${app.rail}"]`)).toBeVisible({ timeout: 15_000 })
    const intro = window.locator('[data-testid="local-ai-intro-dismiss"]')
    if (await intro.isVisible().catch(() => false)) await intro.click()
    const bar = await box(window, `[data-testid="${app.bar}"]`)
    expect(bar.width, 'the embedded editor is narrow').toBeLessThan(520)
    // Menus fold into "≡" (and tabs into More if needed); nothing in Row 1 is clipped.
    await expect(window.locator(`[data-testid="${app.bar}-menus"]`)).toBeVisible()
    const right = bar.x + bar.width
    for (const tab of await window.locator(`[data-testid="${app.bar}"] [role="tab"]`).all()) {
      const b = (await tab.boundingBox())!
      expect(b.x + b.width, 'tab not clipped').toBeLessThanOrEqual(right + 1)
    }
    expect(await onTop(window, `[data-testid="${app.bar}-menus"]`), 'the ≡ menu button is on top').toBe(true)
    // The rail scrolls rather than overflowing the widget.
    expect(await window.locator(`[data-testid="${app.rail}"]`).evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto')
    expect(await window.locator(`[data-testid="${app.rail}"]`).evaluate((el) => el.scrollWidth - el.clientWidth), 'the rail never scrolls sideways').toBeLessThanOrEqual(0)
    // A panel opens as a sheet over the narrow canvas, never over the rail or the bar.
    await window.locator(`[data-testid="${app.panelOpener}"]`).click()
    await expect(window.locator(`[data-testid="${app.panel}"]`)).toBeVisible()
    const [panel, rail, barNow] = await boxes(window, [`[data-testid="${app.panel}"]`, `[data-testid="${app.rail}"]`, `[data-testid="${app.bar}"]`])
    expect(panel.x).toBeGreaterThanOrEqual(rail.x + rail.width - 1)
    expect(panel.y).toBeGreaterThanOrEqual(barNow.y + barNow.height - 1)
    expect(await onTop(window, `[data-testid="${app.panel}-close"]`), 'panel close on top').toBe(true)
    await window.locator(`[data-testid="${app.panel}-close"]`).click()
    // The side pane opens as a sheet over the narrow canvas, never over the rail or the bar.
    if (app.sidePane) await checkSidePane(window, app, app.sidePane, 'narrow')
  })
}
