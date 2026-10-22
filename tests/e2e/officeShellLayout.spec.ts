// Office shell layout guard (SPEC §8): nothing of the shell sits under the
// floating menu or the header, every control is genuinely on top where it is
// drawn (elementFromPoint, the deskChromeNotUnderMenu technique), overlay panels
// never cover the rail or the bar, and the narrow behaviour folds instead of
// clipping. The shared right side pane docks right of the canvas, never over
// the rail or the bar, and its controls are on top. Run per app at three sizes: default, the floating menu at its widest
// (480px), and a narrow window that puts the editor under 520px, each in light
// and dark. Each converted app adds itself to APPS.
//
// The cross-app consistency pass rides on the same runs (checkConsistency):
// Undo pinned and on top on every tab, Row 2 one height everywhere, no
// shell control under a window drag region (Electron's last-region-wins rule,
// as titlebarDragRegions.spec applies it to the header), no right column but
// the shared side pane, no stray side pane in apps without content panes,
// readable contrast for rail icons and tab labels, and a style fingerprint per
// app/theme/size written to test-results/office-shell-fp for
// scripts/office-shell-crossapp.mjs to compare across apps.

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { test, expect, type Page } from '@playwright/test'
import { launchApp, suppressFeatureSpotlights, waitForReady, type LaunchedApp } from './_helpers'

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
  /** The page the app lays out (a slide, an A4 sheet). With the panel PINNED, none of it may sit under the panel (SPEC §2.4). Infinite canvases omit it (they inset Fit instead). */
  page?: string
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
  },
  {
    // PlexiiDraw has no bottom strip (no pages bar) and no content pane (no AI
    // or comments pane in the drawing editor), so it has no corner control and
    // no side pane to check: both are absent, not stand-ins.
    name: 'PlexiiDraw',
    docType: 'draw',
    shell: 'draw-shell',
    bar: 'draw-bar',
    rail: 'draw-toolbox',
    canvas: 'draw-canvas-scroll',
    panelOpener: 'draw-rail-layers',
    panel: 'draw-panel-layers',
    undo: 'draw-undo'
  },
  {
    name: 'PlexiiWrite',
    docType: 'doc',
    shell: 'doc-shell',
    bar: 'doc-toolbar',
    rail: 'doc-rail',
    canvas: 'doc-editor-surface',
    panelOpener: 'doc-toggle-styles',
    panel: 'doc-panel-styles',
    undo: 'doc-undo',
    // No `corner`: that assertion exists to prove a BOTTOM-RIGHT control is not
    // under the Plexii pill, and Write's bottom strip holds only the reading
    // meta, on the left. Naming it here would pass without testing anything.
    sidePane: { toggle: 'doc-sidepane-toggle', pane: 'doc-side-panel', content: 'doc-comments-tab' }
  },
  {
    // PlexiiDeck: the thumbnails are the navigator (leftAside); speaker notes
    // sit inside the canvas column, not in a bottom strip, so there is no
    // bottom-right corner control to check; PlexiiAssist is the side pane.
    name: 'PlexiiDeck',
    docType: 'slides',
    shell: 'slides-shell',
    bar: 'slides-toolbar',
    rail: 'slides-rail',
    canvas: 'slides-canvas',
    panelOpener: 'slides-rail-layouts',
    panel: 'slides-panel-layouts',
    undo: 'slides-undo',
    page: 'slide-canvas',
    sidePane: { toggle: 'slides-sidepane-toggle', pane: 'slides-side-panel', content: 'slides-ai-assistant' }
  },
  {
    name: 'PlexiiDesign',
    docType: 'design',
    shell: 'design-shell',
    bar: 'design-toolbar',
    rail: 'design-rail',
    canvas: 'slide-canvas',
    // Page layout, from the rail: it needs no selection and no key, and it is
    // PINNABLE, which is what makes the "page clears a pinned panel" check
    // below do any work. Driving the AI design panel instead would skip that
    // assertion silently, since the check is gated on a pin button existing —
    // and a pinned panel over the page is precisely the bug that cost DL-8.
    panelOpener: 'design-rail-layout',
    panel: 'design-panel-layout',
    // The page itself, so the pinned-panel check has something to measure.
    page: 'slide-canvas',
    undo: 'design-undo',
    // Design's bottom strip is the page rail; its add control is the furthest
    // right thing in it, so it is what the Plexii pill would cover.
    corner: 'design-page-add',
    sidePane: { toggle: 'design-sidepane-toggle', pane: 'design-sidepane', content: 'design-ai-panel' }
  },
  {
    name: 'PlexiiCells',
    docType: 'sheet',
    shell: 'sheet-shell',
    bar: 'sheet-toolbar',
    rail: 'sheet-rail',
    canvas: 'sheet-grid-wrap',
    // Import / export is Cells' one real ShellPanel: its rail item calls
    // togglePanel and CellsChrome supplies the body. The other rail tools open
    // SheetEditor's own modals, so naming one of those here would assert a
    // panel that never appears.
    panelOpener: 'sheet-rail-office',
    panel: 'sheet-panel-office',
    undo: 'sheet-undo',
    // The sheet tab strip IS a bottom-right control, so unlike Write this row
    // genuinely exercises the clear-of-the-Plexii-pill check.
    corner: 'sheet-tab-strip',
    sidePane: { toggle: 'sheet-ai-toggle', pane: 'sheet-side-panel', content: 'sheet-ai-panel' }
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
  if (await intro.isVisible().catch(() => false)) await intro.click({ timeout: 2_000 }).catch(() => undefined) // it can unmount between the check and the click

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
  // A PINNED panel stays while you work, so the page is laid out past it: nothing on the
  // page sits under it (a marquee started there would hit the panel). SPEC §2.4.
  if (app.page && (await window.locator(t(`${app.panel}-pin`)).count())) {
    const pin = window.locator(t(`${app.panel}-pin`))
    const wasPinned = (await pin.getAttribute('aria-pressed')) === 'true'
    if (!wasPinned) await pin.click()
    await expect
      .poll(async () => {
        const [pg, pn] = await boxes(window, [t(app.page!), t(app.panel)])
        return Math.round(pg.x - (pn.x + pn.width))
      }, { message: `${label}: the page clears a pinned panel`, timeout: 4_000 })
      .toBeGreaterThanOrEqual(0)
    if (!wasPinned) await pin.click()
  }
  await window.locator(t(`${app.panel}-close`)).click()
  await expect(window.locator(t(app.panel))).toHaveCount(0)

  // 4. The right side pane: collapsed it is a slim edge tab; opened from the top bar it docks right of the canvas.
  if (app.sidePane) {
    await checkSidePane(window, app, app.sidePane, label)
  }
}

/**
 * The side pane's collapse control, found by the shell's structural hook rather than a
 * test id: apps may keep a legacy collapse id via ShellSidePane's collapseTestid
 * (sheet-ai-collapse), so the app-agnostic guard must not assume `${pane}-collapse` (SPEC §2.5a).
 */
const collapseSel = (pane: string): string => `[data-testid="${pane}"] [data-shell-role="sidepane-collapse"]`

async function checkSidePane(window: Page, app: AppCase, sp: NonNullable<AppCase['sidePane']>, label: string): Promise<void> {
  const t = (id: string): string => `[data-testid="${id}"]`
  if (await window.locator(t(sp.pane)).count()) await window.locator(collapseSel(sp.pane)).click()
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
  expect(await onTop(window, collapseSel(sp.pane)), `${label}: side pane collapse on top`).toBe(true)
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
  await window.locator(collapseSel(sp.pane)).click()
  await expect(window.locator(t(`${sp.pane}-edge`))).toBeVisible()
}

type Theme = 'light' | 'dark'
type Size = 'default' | 'menu 480' | 'narrow'
const THEMES: Theme[] = ['light', 'dark']
const ROW2_HEIGHT = 36 // SPEC §2.3 (layout.ts ROW2_HEIGHT)
const RAIL_WIDTH = 40 // SPEC §1 (layout.ts RAIL_WIDTH)
const FP_DIR = process.env.OFFICE_SHELL_FP_DIR ?? join(process.cwd(), 'test-results', 'office-shell-fp')

/** Launch with a theme (the app's own fb.theme.mode path) and optionally the floating menu at 480px. */
async function boot(theme: Theme, opts: { menu480?: boolean; before?: (window: Page) => Promise<void> } = {}): Promise<Page> {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(() => (window as unknown as { api: { ai: { setMode: (m: string) => Promise<unknown> } } }).api.ai.setMode('auto'))
  await window.evaluate(
    ({ th, menu }) => {
      localStorage.setItem('fb.theme.mode', th)
      if (menu) localStorage.setItem('fb.sidebar.width', '480')
    },
    { th: theme, menu: !!opts.menu480 }
  )
  if (opts.before) await opts.before(window)
  await suppressFeatureSpotlights(window) // the new-feature card docks bottom-right ~750ms after a boot and races the corner checks
  await window.reload()
  await waitForReady(window)
  expect(await window.evaluate(() => document.documentElement.classList.contains('dark')), `theme ${theme} applied`).toBe(theme === 'dark')
  if (opts.menu480) expect((await box(window, '[data-testid="sidebar-dock"]')).width).toBeGreaterThan(470)
  return window
}

/** Idempotent tab select (same rule as 3e's selectBarTab): a second click on the active tab is a double-click, which collapses Row 2 (D5). */
async function selectTab(window: Page, bar: string, tabTestid: string): Promise<void> {
  const tab = window.locator(`[data-testid="${tabTestid}"]`)
  if ((await tab.getAttribute('aria-selected')) === 'true') return
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 3_000 })
  void bar
}

async function checkConsistency(window: Page, app: AppCase, theme: Theme, size: Size): Promise<void> {
  const label = `${theme} ${size}`
  const t = (id: string): string => `[data-testid="${id}"]`

  // A. No shell control under a window drag region. Electron folds -webkit-app-region rects in
  // DOCUMENT ORDER and the last one covering a point wins; Playwright clicks bypass that OS hit-test,
  // so this applies the rule to the live DOM (titlebarDragRegions.spec does the same for the header).
  const dragCovered = await window.evaluate((shellSel) => {
    const regionOf = (el: Element): string => {
      const cs = getComputedStyle(el)
      return (cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region') || 'none').trim()
    }
    const shell = document.querySelector(shellSel)
    if (!shell) return [`no ${shellSel}`]
    const regions = Array.from(document.querySelectorAll('*')).filter((el) => {
      const r = regionOf(el)
      return r === 'drag' || r === 'no-drag'
    })
    const bad: string[] = []
    for (const c of Array.from(shell.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="menuitem"]'))) {
      // The VISIBLE part: clipped by every scrolling/clipping ancestor (a long rail scrolls inside a
      // narrow widget, and a button scrolled out of view is not a click target at all).
      const r0 = (c as HTMLElement).getBoundingClientRect()
      let [l, tp, rt, bt] = [r0.left, r0.top, r0.right, r0.bottom]
      for (let a = c.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a)
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
        const b = a.getBoundingClientRect()
        ;[l, tp, rt, bt] = [Math.max(l, b.left), Math.max(tp, b.top), Math.min(rt, b.right), Math.min(bt, b.bottom)]
      }
      if (rt - l < 1 || bt - tp < 1) continue
      const x = (l + rt) / 2
      const y = (tp + bt) / 2
      let last: Element | null = null
      for (const el of regions) {
        const b = (el as HTMLElement).getBoundingClientRect()
        if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) last = el
      }
      if (last && regionOf(last) === 'drag') bad.push(`${c.getAttribute('data-testid') || c.getAttribute('aria-label') || c.tagName} <- ${last.tagName.toLowerCase()}.${String((last as HTMLElement).className).slice(0, 50)}`)
    }
    return bad
  }, t(app.shell))
  expect(dragCovered, `${label}: shell controls under a window drag region:\n${dragCovered.join('\n')}`).toEqual([])

  // B. Undo (and Redo, where the app names it <app>-redo) pinned and on top on EVERY visible tab; Row 2 one height everywhere.
  const redo = app.undo.replace(/undo$/, 'redo')
  const tabIds = (await window.locator(`${t(app.bar)} [role="tab"]`).evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.getAttribute('data-testid')!))).filter(
    (id) => !id.endsWith('-tab-more')
  )
  const startTab = await window.locator(`${t(app.bar)} [role="tab"][aria-selected="true"]`).first().getAttribute('data-testid')
  const row2Heights: Record<string, number> = {}
  for (const id of tabIds) {
    await selectTab(window, app.bar, id)
    expect(await onTop(window, t(app.undo)), `${label}: Undo on top on ${id}`).toBe(true)
    if (await window.locator(t(redo)).count()) expect(await onTop(window, t(redo)), `${label}: Redo on top on ${id}`).toBe(true)
    row2Heights[id] = Math.round((await box(window, t(`${app.bar}-panel`))).height)
  }
  for (const [id, h] of Object.entries(row2Heights)) expect(Math.abs(h - ROW2_HEIGHT), `${label}: Row 2 is ${ROW2_HEIGHT}px on ${id} (got ${h})`).toBeLessThanOrEqual(1)
  if (startTab) await selectTab(window, app.bar, startTab)

  // C. The right edge: nothing but the shared side pane sits right of the canvas (no inspector column survived), and
  // an app without content panes renders no side pane, toggle or edge tab at all.
  const right = await window.evaluate(
    ({ shellSel, mainSel }) => {
      const r = (sel: string): DOMRect | null => document.querySelector(sel)?.getBoundingClientRect() ?? null
      const shell = r(shellSel)!
      const main = r(mainSel)!
      const pane = r('#shell-sidepane')
      return { shellRight: shell.right, mainRight: main.right, paneWidth: pane ? pane.width : 0, paneSheet: !!document.querySelector('#shell-sidepane[data-sheet]') }
    },
    { shellSel: t(app.shell), mainSel: t(`${app.shell}-main`) }
  )
  if (!right.paneSheet) {
    expect(Math.abs(right.shellRight - right.paneWidth - right.mainRight), `${label}: only the side pane sits right of the canvas (shell ${right.shellRight}, main ${right.mainRight}, pane ${right.paneWidth})`).toBeLessThanOrEqual(1)
  }
  if (app.sidePane) {
    expect(await window.locator(`${t(app.bar)} ${t(app.sidePane.toggle)}`).count(), `${label}: the side-pane toggle is in the top bar`).toBe(1)
    expect(await window.locator(t(app.sidePane.toggle)).getAttribute('aria-controls'), `${label}: the toggle controls the side pane`).toBe('shell-sidepane')
  } else {
    expect(await window.locator('#shell-sidepane').count(), `${label}: no side pane in an app without content panes`).toBe(0)
  }
  expect(await window.locator(`${t(app.shell)} [data-testid*="inspector"]:visible`).count(), `${label}: no right inspector left in the shell`).toBe(0)

  // No test id twice in the chrome (bar, rail, navigator, panels, side pane, and any portalled
  // bar popover). A bespoke control left beside its ribbon twin makes every strict locator time
  // out. Canvas content repeats ids by design (one slide-element per element) and is not scanned.
  const dupes = await window.evaluate(
    ({ shellSel, barSel, railSel }) => {
      const shell = document.querySelector(shellSel)
      if (!shell) return [`no ${shellSel}`]
      const roots: Element[] = [document.querySelector(barSel), document.querySelector(railSel), shell.querySelector('#shell-sidepane'), shell.querySelector('[data-testid$="-panels"]')].filter(
        (e): e is Element => !!e
      )
      // The navigator column (leftAside) is the shell row's child before the main column.
      const main = shell.querySelector('[data-testid$="-main"]')
      for (let sib = main?.previousElementSibling; sib; sib = sib.previousElementSibling) if (!sib.matches(railSel)) roots.push(sib)
      const seen = new Map<string, number>()
      for (const r of roots) for (const el of [r, ...Array.from(r.querySelectorAll('[data-testid]'))]) {
        const id = el.getAttribute('data-testid')
        if (id) seen.set(id, (seen.get(id) ?? 0) + 1)
      }
      return [...seen].filter(([, n]) => n > 1).map(([id, n]) => `${id} ×${n}`)
    },
    { shellSel: t(app.shell), barSel: t(app.bar), railSel: t(app.rail) }
  )
  expect(dupes, `${label}: test ids that appear twice in the chrome:\n${dupes.join('\n')}`).toEqual([])

  // Let colour transitions finish first: the tabs have transition-colors, and the checks above
  // just switched tabs, so an unsettled tab reads as a different colour per app (the first
  // final cross-app report showed "active tab colour" varying even within one app).
  await window.evaluate(() =>
    Promise.race([Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 1_500))])
  )

  // D. Contrast and the style fingerprint, read from one frame. Colours are resolved through a canvas so
  // oklch/color-mix tokens compare like rgb; translucent backgrounds are composited up the ancestor chain.
  const fp = await window.evaluate(
    ({ railSel, barSel, panelSel, undoSel }) => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
      const rgba = (c: string): [number, number, number, number] => {
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = '#000'
        ctx.fillStyle = c
        ctx.fillRect(0, 0, 1, 1)
        const d = ctx.getImageData(0, 0, 1, 1).data
        return [d[0]!, d[1]!, d[2]!, d[3]! / 255]
      }
      const over = (top: [number, number, number, number], under: [number, number, number]): [number, number, number] => [0, 1, 2].map((i) => top[i]! * top[3] + under[i]! * (1 - top[3])) as [number, number, number]
      const bgOf = (el: Element | null): [number, number, number] => {
        const chain: [number, number, number, number][] = []
        for (let e = el; e; e = e.parentElement) {
          const c = rgba(getComputedStyle(e).backgroundColor)
          if (c[3] > 0) chain.push(c)
          if (c[3] >= 0.999) break
        }
        let acc: [number, number, number] = document.documentElement.classList.contains('dark') ? [0, 0, 0] : [255, 255, 255]
        for (let i = chain.length - 1; i >= 0; i--) acc = over(chain[i]!, acc)
        return acc
      }
      const lum = (c: [number, number, number]): number => {
        const [r, g, b] = c.map((v) => {
          const s = v / 255
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
      }
      const contrast = (el: Element | null): number => {
        if (!el) return 0
        const bg = bgOf(el)
        const fg = over(rgba(getComputedStyle(el).color), bg)
        const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x)
        return Math.round(((a! + 0.05) / (b! + 0.05)) * 100) / 100
      }
      const hex = (c: [number, number, number]): string => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
      const rect = (el: Element | null): { w: number; h: number } | null => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height) }
      }
      const rail = document.querySelector(railSel)!
      const bar = document.querySelector(barSel)!
      const railTool = rail.querySelector('button[data-rail-kind="tool"]:not([aria-pressed="true"]):not(:disabled)') ?? rail.querySelector('button[data-rail-kind]:not(:disabled)')
      const pressed = rail.querySelector('button[data-rail-kind][aria-pressed="true"]')
      const tabs = Array.from(bar.querySelectorAll('[role="tab"]')).filter((e) => (e as HTMLElement).offsetParent !== null)
      const active = tabs.find((e) => e.getAttribute('aria-selected') === 'true') ?? null
      const inactive = tabs.find((e) => e.getAttribute('aria-selected') !== 'true') ?? null
      const panel = document.querySelector(panelSel)
      const edge = document.querySelector('#shell-sidepane')
      const font = (el: Element | null): string | null => (el ? `${getComputedStyle(el).fontSize}/${getComputedStyle(el).fontWeight}` : null)
      return {
        rail: { ...rect(rail), bg: hex(bgOf(rail)), border: getComputedStyle(rail).borderRightColor },
        railButton: rect(railTool),
        railPressedBg: pressed ? hex(bgOf(pressed)) : null,
        railToolIds: Array.from(rail.querySelectorAll('button[data-rail-kind="tool"]')).map((b) => b.getAttribute('data-testid')),
        row1: Math.round(bar.getBoundingClientRect().height - (panel?.getBoundingClientRect().height ?? 0)),
        row2: rect(panel)?.h ?? null,
        barBg: hex(bgOf(bar)),
        tabActive: active ? { font: font(active), color: hex(over(rgba(getComputedStyle(active).color), bgOf(active))), bg: hex(bgOf(active)) } : null,
        tabInactive: inactive ? { font: font(inactive), color: hex(over(rgba(getComputedStyle(inactive).color), bgOf(inactive))) } : null,
        undo: rect(document.querySelector(undoSel)),
        sidePane: edge ? { w: Math.round(edge.getBoundingClientRect().width), collapsed: edge.getAttribute('role') === 'tablist' } : null,
        contrast: { railIcon: contrast(railTool), tabActive: contrast(active), tabInactive: contrast(inactive) }
      }
    },
    { railSel: t(app.rail), barSel: t(app.bar), panelSel: t(`${app.bar}-panel`), undoSel: t(app.undo) }
  )
  mkdirSync(FP_DIR, { recursive: true })
  writeFileSync(join(FP_DIR, `${app.name}__${theme}__${size.replace(/\s+/g, '-')}.json`), JSON.stringify({ app: app.name, theme, size, ...fp }, null, 2))

  expect(fp.rail.w, `${label}: rail is ${RAIL_WIDTH}px`).toBe(RAIL_WIDTH)
  expect(fp.contrast.railIcon, `${label}: rail icon contrast >= 3:1 (non-text UI)`).toBeGreaterThanOrEqual(3)
  expect(fp.contrast.tabActive, `${label}: active tab label contrast >= 4.5:1`).toBeGreaterThanOrEqual(4.5)
  if (fp.tabInactive) expect(fp.contrast.tabInactive, `${label}: inactive tab label contrast >= 4.5:1`).toBeGreaterThanOrEqual(4.5)
}

async function openNarrowWidget(window: Page, app: AppCase): Promise<void> {
  await window.evaluate((id: string) => (window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }).__fbView?.getState().goTask(id), narrowTaskId)
  // Kept clear of the desk's 80px hover edge-pan zone: a cursor resting on the rail there would pan the camera.
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 15_000 })
  await expect(window.locator(`[data-testid="${app.rail}"]`)).toBeVisible({ timeout: 15_000 })
}
let narrowTaskId = ''

for (const app of APPS) {
  for (const theme of THEMES) {
    test(`${app.name} — ${theme} — shell layout at the default size`, async () => {
      const window = await boot(theme)
      await openDoc(window, app.docType)
      await checkShell(window, app, `${theme} default`)
      await checkConsistency(window, app, theme, 'default')
    })

    test(`${app.name} — ${theme} — shell layout with the floating menu at its widest (480px)`, async () => {
      const window = await boot(theme, { menu480: true })
      await openDoc(window, app.docType)
      await checkShell(window, app, `${theme} menu 480`)
      await checkConsistency(window, app, theme, 'menu 480')
    })

    test(`${app.name} — ${theme} — narrow, embedded in a desk widget: Row 1 folds and everything stays reachable`, async () => {
      // The app window never goes below 1100px, so a narrow editor only happens
      // EMBEDDED: a document widget on a desk (3e's case: widgets resize small).
      const window = await boot(theme, {
        before: async (w) => {
          narrowTaskId = await w.evaluate(async (docType: string) => {
            const api = (window as unknown as { api: typeof window.api }).api
            const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Narrow shell' })
            const doc = await api.documents.create({ docType, title: 'Narrow' } as never)
            await api.widgets.create({ taskId: task.id, kind: docType, content: (doc as { id: string }).id, x: 240, y: 160, width: 480, height: 380 } as never)
            return task.id
          }, app.docType)
        }
      })
      await openNarrowWidget(window, app)
      const intro = window.locator('[data-testid="local-ai-intro-dismiss"]')
      if (await intro.isVisible().catch(() => false)) await intro.click({ timeout: 2_000 }).catch(() => undefined) // it can unmount between the check and the click
      const bar = await box(window, `[data-testid="${app.bar}"]`)
      // Host rule (SPEC §6): nothing between the widget and the shell may be wider than the widget.
      // A flex item left at min-width:auto grows to its content (the widest toolbar) and overflows;
      // name each offender with its classes so the fix is one look away.
      const overflow = await window.evaluate((shellSel: string) => {
        const shell = document.querySelector(shellSel) as HTMLElement | null
        if (!shell) return [`no ${shellSel}`]
        const widget = shell.closest('[data-widget-id]') as HTMLElement | null
        if (!widget) return ['shell is not inside a [data-widget-id] widget']
        const w = widget.getBoundingClientRect()
        const describe = (el: HTMLElement): string => {
          const cs = getComputedStyle(el)
          const parent = el.parentElement ? getComputedStyle(el.parentElement) : null
          const flexItem = !!parent && (parent.display === 'flex' || parent.display === 'inline-flex')
          const tid = el.dataset.testid ? `[data-testid="${el.dataset.testid}"] ` : ''
          const hint = flexItem && cs.minWidth === 'auto' ? ' — flex item at min-width:auto: add min-w-0' : ''
          return `${tid}<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 120)}"> width ${Math.round(el.getBoundingClientRect().width)} > widget ${Math.round(w.width)}${hint}`
        }
        const bad: string[] = []
        // The shell and every ancestor up to the widget, outermost first: the outermost offender is usually the one to fix.
        const chain: HTMLElement[] = []
        for (let a: HTMLElement | null = shell; a && a !== widget; a = a.parentElement) chain.unshift(a)
        for (const el of chain) {
          const r = el.getBoundingClientRect()
          if (r.width > w.width + 1 || r.right > w.right + 1) bad.push(describe(el))
        }
        // The shell's own frame: bar, content row and its columns stay inside the shell.
        const s = shell.getBoundingClientRect()
        for (const el of Array.from(shell.querySelectorAll<HTMLElement>(':scope > *, :scope > * > *'))) {
          const r = el.getBoundingClientRect()
          if (r.width && r.right > s.right + 1) bad.push(`inside the shell: ${describe(el)}`)
        }
        // Vertically too (min-h-0, the same rule): nothing makes a scroll container between the
        // shell and the widget scroll. If one does, focus scrolls it and the bar slides under the
        // widget's header (Draw's keys notice did this). Name the deepest elements past its bottom.
        for (let a: HTMLElement | null = shell.parentElement; a && a !== widget.parentElement; a = a.parentElement) {
          const oy = getComputedStyle(a).overflowY
          if ((oy === 'auto' || oy === 'scroll') && a.scrollHeight > a.clientHeight + 1) {
            const ab = a.getBoundingClientRect()
            const past = Array.from(shell.querySelectorAll<HTMLElement>('*'))
              .filter((el) => {
                const r = el.getBoundingClientRect()
                return r.height > 0 && r.bottom - ab.top + a!.scrollTop > a!.clientHeight + 1 && getComputedStyle(el).position !== 'absolute'
              })
              .slice(0, 3)
              .map((el) => `${el.dataset.testid ? `[data-testid="${el.dataset.testid}"] ` : ''}<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 90)}"> ${Math.round(el.getBoundingClientRect().height)}px tall`)
            bad.push(`the editor is ${a.scrollHeight - a.clientHeight}px taller than its widget, so <${a.tagName.toLowerCase()} class="${String(a.className).slice(0, 60)}"> scrolls (focus can slide the bar under the header); first elements past the bottom: ${past.join(' · ')}`)
          }
        }
        return bad
      }, `[data-testid="${app.shell}"]`)
      expect(overflow, `the editor overflows its desk widget (SPEC §6 host rule):\n${overflow.join('\n')}`).toEqual([])
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
      if (app.sidePane) await checkSidePane(window, app, app.sidePane, `${theme} narrow`)
      // As sheets, whichever opened LAST is on top: a panel opened over the open side pane has a
      // reachable close, and reopening the side pane puts its collapse back on top (SPEC §2.6).
      if (app.sidePane) {
        await window.locator(`[data-testid="${app.sidePane.toggle}"]`).click()
        await expect(window.locator(`[data-testid="${app.sidePane.content}"]`)).toBeVisible()
        await window.locator(`[data-testid="${app.panelOpener}"]`).click()
        await expect(window.locator(`[data-testid="${app.panel}"]`)).toBeVisible()
        // Checked at once, not polled: the raise happens in the commit that shows the panel (a layout
        // effect), so the first frame already has it on top. A polled check would pass the old
        // passive-effect code, which drew the panel under the pane for a frame (longer under load).
        // This row only rarely catches that defect, so green here proves nothing about it:
        // tests/unit/officeShellStackingGuard.test.ts is the protection.
        expect(await onTop(window, `[data-testid="${app.panel}-close"]`), 'a panel opened over the side pane: its close is on top').toBe(true)
        await window.locator(`[data-testid="${app.panel}-close"]`).click()
        await expect(window.locator(`[data-testid="${app.panel}"]`)).toHaveCount(0)
        expect(await onTop(window, collapseSel(app.sidePane.pane)), 'with the panel closed, the side pane is usable again').toBe(true)
        await window.locator(collapseSel(app.sidePane.pane)).click()
      }
      await checkConsistency(window, app, theme, 'narrow')
    })
  }
}
