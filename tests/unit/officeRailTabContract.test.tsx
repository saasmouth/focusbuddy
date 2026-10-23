// The rail and tab contract across all six office apps (SPEC §3.9): owner,
// 4.3.41-local.2 — "left side tool menus, and top settings, they should all
// work the same". Each app's rail and tabs are data with a role per item; the
// pure checks in office/shell/contract.ts read those roles (never labels) and
// list every way an app breaks the one order. The exceptions an app genuinely
// has are NAMED here with their reason (SPEC §3.9), never passed silently.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Editor } from '@tiptap/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ContextBar,
  controlViolations,
  escapeIntent,
  railSlots,
  railViolations,
  tabViolations,
  ToolRail,
  useShellChrome,
  type BarTab,
  type ControlException,
  type RailItem
} from '../../src/renderer/src/components/office/shell'
import { WRITE_TABS, writeRailItems, type WCtx } from '../../src/renderer/src/components/documents/editor/writeRibbon'
import { CELLS_TABS, cellsRailItems, type CCtx } from '../../src/renderer/src/components/documents/sheet/cellsRibbon'
import { DECK_TABS, deckRailItems, type DeckCtx } from '../../src/renderer/src/components/documents/slides/ribbon'
import { DESIGN_TABS, type DesignCtx } from '../../src/renderer/src/components/documents/design/ribbon'
import { buildDesignCommands, type DesignCommandDeps } from '../../src/renderer/src/components/documents/design/designCommands'
import { buildDeckCommands, type DeckCommandDeps } from '../../src/renderer/src/components/documents/slides/deckCommands'
import { designRailItems, type DesignRailCmds } from '../../src/renderer/src/components/documents/design/rail'
import { DIAGRAM_TABS, diagramCtx, diagramRailItems, type DCtx } from '../../src/renderer/src/components/documents/diagram/ribbon'
import { drawBarTabs } from '../../src/renderer/src/components/documents/draw/bar/registry'
import { drawRailItems, type RailCtx } from '../../src/renderer/src/components/documents/draw/render/rail'
import type { SheetMenuActions } from '../../src/renderer/src/components/documents/editor/SheetMenuBar'
import { normalizeDesignBody } from '../../src/shared/design'
import { resolveTheme } from '../../src/shared/slideThemes'
import type { MapNode, Slide, SlideElement } from '../../src/shared/types'
import { blank, harness, rect } from './drawTools/harness'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  localStorage.clear()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const noop = (): void => {}
const anyFn = <T,>(over: Record<string, unknown> = {}): T => new Proxy(over, { get: (t, k) => (k in t ? t[k as string] : noop) }) as T

// ── Fixtures: each app's context with one text-bearing selection ─────────────

const fakeEditor = { isActive: () => false, getAttributes: () => ({}), can: () => ({ undo: () => false, redo: () => false }) } as unknown as Editor
const writeCtx = anyFn<WCtx>({ editor: fakeEditor, readOnly: false, pageView: true, styleLabel: 'Normal', sidePane: null, isPanelOpen: () => false, hasTracked: false })
const cellsCtx = (filterActive = false): CCtx =>
  anyFn<CCtx>({ a: anyFn<SheetMenuActions>({ filterActive }), readOnly: false, fmt: undefined, activeFont: undefined, isMerged: false, isPanelOpen: () => false, sidePane: null })

const textEl = { id: 't', type: 'text', x: 0, y: 0, w: 200, h: 60, z: 1, paragraphs: [{ runs: [{ text: 'Hi', fontSize: 24 }] }] } as unknown as SlideElement
const deckCtx: DeckCtx = anyFn<DeckCtx>({
  slide: { id: 's1', notes: '', layout: 'title-content', elements: [textEl], transition: 'none', schemaVersion: 2 } as Slide,
  theme: resolveTheme('plexi-default'),
  selected: [textEl],
  el: textEl,
  anyGrouped: false,
  readOnly: false,
  tool: 'select',
  isPanelOpen: () => false,
  sidePane: null,
  ed: anyFn({}),
  // The ribbon's shared buttons render Deck's command record (SPEC §9.9).
  cmds: buildDeckCommands(anyFn<DeckCommandDeps>({ selected: 1, anyGrouped: false, canUndo: false, canRedo: false, canPaste: false, singleSlide: false, textMarks: {} }))
})
const designCtx: DesignCtx = (() => {
  const design = normalizeDesignBody({ width: 794, height: 1123, elements: [textEl] })
  const cmds = buildDesignCommands(anyFn<DesignCommandDeps>({ selected: 1, grouped: false, canPaste: false, textMarks: {} }))
  return { cmds, design, selected: [textEl], first: textEl, fonts: ['Inter'], palette: ['#000000'], cmd: anyFn({}), startFrom: null, guidesVisible: true, facing: false, bleed: 0, layers: [] }
})()
const node = (id: string): MapNode => ({ id, x: 0, y: 0, label: id, shape: 'process', color: '#2563eb' })
const diagCtx: DCtx = diagramCtx(
  anyFn({
    cmd: anyFn({ hasStyleClipboard: () => false }),
    page: { nodes: [node('a')], edges: [] },
    sel: { nodes: new Set(['a']), edges: new Set() },
    settings: {},
    themeId: undefined,
    readOnly: false,
    zoom: 1,
    tool: 'select',
    isPanelOpen: () => false,
    sidePane: null
  })
)
const drawH = harness(blank([{ id: 'tx', type: 'text', x: 0, y: 0, w: 100, text: 'Hi', fontSize: 20, fill: { type: 'solid', color: '#000000' } }]))
drawH.ed.ctx.select(['tx'])
const drawCtx: RailCtx = { ctx: drawH.ed.ctx, s: drawH.state(), altHeld: () => false, sidePane: null, toggleAi: noop }
/** Draw's bar tabs as DrawStudio maps them onto the shell. */
const drawTabs: BarTab<RailCtx>[] = drawBarTabs().map((t) => {
  const C = t.component
  return { id: t.id, label: t.label, role: t.role, contextual: !!t.when, ...(t.when ? { when: (c: RailCtx) => t.when!(c.s) } : {}), render: (c: RailCtx) => <C ctx={c.ctx} /> }
})

interface App<C> {
  name: string
  rail: () => RailItem<C>[]
  railCtx: C
  tabs: BarTab<C>[]
  ctx: C
  /** The tab whose text controls are checked (a text selection is set up). */
  textTab: string
  /** Text controls the app genuinely cannot have, with the reason (SPEC §3.9). */
  exceptions: ControlException[]
  /** Whether ⌘B/⌘I/⌘U are bound while editing text (§9.4: a hint only for a bound key). */
  bound: Partial<Record<'bold' | 'italic' | 'underline', boolean>>
}

// The named allowlist. Nothing outside it may be missing.
const CONTROL_EXCEPTIONS: Record<string, ControlException[]> = {
  Cells: [{ semantic: 'font-size', reason: 'SheetCellFormat has no font size: cells use the sheet default; adding one is a model, renderer and .xlsx change, not chrome' }],
  Draw: [{ semantic: 'underline', reason: 'DrawTextNode has no text decoration (the model, the SVG and PDF export would all need it)' }]
}

const APPS: App<never>[] = [
  { name: 'Write', rail: writeRailItems, railCtx: writeCtx, tabs: WRITE_TABS, ctx: writeCtx, textTab: 'home', exceptions: [], bound: { bold: true, italic: true, underline: true } },
  { name: 'Cells', rail: cellsRailItems, railCtx: cellsCtx(), tabs: CELLS_TABS, ctx: cellsCtx(), textTab: 'home', exceptions: CONTROL_EXCEPTIONS.Cells!, bound: { bold: true, italic: true, underline: true } },
  { name: 'Deck', rail: deckRailItems, railCtx: deckCtx, tabs: DECK_TABS, ctx: deckCtx, textTab: 'home', exceptions: [], bound: { bold: true, italic: true, underline: true } },
  // Design binds ⌘B/⌘I/⌘U on the selected text frame (039a5e41), so its hints show.
  { name: 'Design', rail: designRailItems, railCtx: anyFn<DesignRailCmds>(), tabs: DESIGN_TABS, ctx: designCtx, textTab: 'home', exceptions: [], bound: { bold: true, italic: true, underline: true } },
  { name: 'Diagrams', rail: diagramRailItems, railCtx: diagCtx, tabs: DIAGRAM_TABS, ctx: diagCtx, textTab: 'home', exceptions: [], bound: { bold: true, italic: true, underline: true } },
  { name: 'Draw', rail: drawRailItems, railCtx: drawCtx, tabs: drawTabs, ctx: drawCtx, textTab: 'type', exceptions: CONTROL_EXCEPTIONS.Draw!, bound: {} }
] as unknown as App<never>[]

describe('the rail contract (SPEC §3.9): Navigate · Create · Insert (Image first) · App · panels · AI last', () => {
  for (const app of APPS)
    it(`${app.name} keeps the one rail order`, () => {
      expect(railViolations(app.rail(), app.railCtx)).toEqual([])
    })

  it('Select leads every canvas app; Hand follows the selection tools; Text leads Create', () => {
    for (const app of APPS.filter((a) => ['Deck', 'Design', 'Diagrams', 'Draw'].includes(a.name))) {
      const roles = railSlots(app.rail(), app.railCtx).map((s) => s.shown.role)
      expect(roles[0], app.name).toBe('select')
      expect(roles.indexOf('text'), app.name).toBeGreaterThan(0)
      expect(roles[roles.length - 1], app.name).toBe('ai')
    }
    const draw = railSlots(drawRailItems(), drawCtx).map((s) => s.shown.id)
    expect(draw.slice(0, 4)).toEqual(['select', 'direct', 'lasso', 'hand'])
    expect(draw.indexOf('text')).toBeLessThan(draw.findIndex((id) => id === 'rect'))
  })

  it('Cells: the modal openers are dialog actions (no dangling aria-controls) and Filter shows the host state', () => {
    // Named here, per the SPEC §5a.14 ruling: Conditional formatting, Validation,
    // Macros and Query are SheetEditor's modals, so they are dialog items in the
    // App section, not panels at the bottom (SPEC §6.6 listed Macros and Query
    // as panels; they are not).
    const items = cellsRailItems()
    for (const id of ['condformat', 'validation', 'macros', 'query']) {
      const it = items.find((i) => i.id === id)!
      expect([it.kind, it.dialog, it.role], id).toEqual(['action', true, 'app'])
    }
    for (const on of [false, true]) {
      act(() => root.render(<ToolRail<CCtx> testid="sheet-rail" items={items} ctx={cellsCtx(on)} />))
      expect(document.querySelector('[data-testid="sheet-rail-filter"]')!.getAttribute('aria-pressed')).toBe(String(on))
      // §3.7: the Data tab's Filter reads the same state.
      act(() => root.render(<ContextBar<CCtx> testid="sheet-toolbar" tabs={CELLS_TABS} ctx={cellsCtx(on)} activeTab="data" onTabChange={noop} menuBar={null} />))
      expect(document.querySelector('[data-testid="sheet-filter-btn"]')!.getAttribute('aria-pressed')).toBe(String(on))
    }
    act(() => root.render(<ToolRail<CCtx> testid="sheet-rail" items={items} ctx={cellsCtx()} />))
    const cf = document.querySelector('[data-testid="sheet-rail-condformat"]')!
    expect(cf.getAttribute('aria-haspopup')).toBe('dialog')
    expect(cf.hasAttribute('aria-controls')).toBe(false)
  })

  it('every lockable tool advertises the double-click lock, and a double-click locks it', () => {
    const arm: [string, boolean][] = []
    const items = designRailItems()
    act(() => root.render(<ToolRail<DesignRailCmds> testid="design-rail" items={items} ctx={anyFn<DesignRailCmds>({ armTool: (t: string, l?: boolean) => arm.push([t, !!l]) })} />))
    const rect = document.querySelector<HTMLButtonElement>('[data-testid="design-tool-rect"]')!
    expect(rect.getAttribute('aria-label')).toContain('double-click to keep it selected')
    act(() => rect.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(arm).toContainEqual(['rect', true])
    // Select carries no fake "double-click for options" hint.
    expect(document.querySelector('[data-testid="design-tool-select"]')!.getAttribute('aria-label')).toBe('Select (V)')
  })
})

describe('the tab contract (SPEC §3.9): Home · Insert · Arrange|Layout · app tabs · Review; contextual last', () => {
  for (const app of APPS)
    it(`${app.name} keeps the one tab order`, () => {
      expect(tabViolations(app.tabs)).toEqual([])
    })

  it('every app has Home first and Insert second', () => {
    for (const app of APPS) expect(app.tabs.slice(0, 2).map((t) => t.role), app.name).toEqual(['home', 'insert'])
  })

  it('useShellChrome opens on Home even with a remembered tab, and remembers collapse and the flyouts', () => {
    localStorage.setItem('plexii.slides.ribbonTab', JSON.stringify('design'))
    localStorage.setItem('plexii.slides.ribbonCollapsed', 'true')
    let api: ReturnType<typeof useShellChrome> | null = null
    function Probe(): null {
      api = useShellChrome('slides', { shapes: 'tool-rect' })
      return null
    }
    act(() => root.render(<Probe />))
    expect(api!.tab).toBe('home')
    expect(api!.collapsed).toBe(true)
    expect(api!.lastUsed).toEqual({ shapes: 'tool-rect' })
    act(() => {
      api!.setCollapsed(false)
      api!.onFlyoutPick('shapes', 'tool-ellipse')
    })
    expect(localStorage.getItem('plexii.slides.ribbonCollapsed')).toBe('false')
    act(() => root.unmount())
    root = createRoot(host)
    act(() => root.render(<Probe />))
    expect(api!.collapsed).toBe(false)
    expect(api!.lastUsed.shapes).toBe('tool-ellipse')
  })

  it('Esc means one thing: an armed tool goes back to Select, otherwise the selection clears', () => {
    expect(escapeIntent('rect', true)).toBe('disarm')
    expect(escapeIntent('select', true)).toBe('deselect')
    expect(escapeIntent('select', false)).toBe(null)
    const drawArmed = (t: string): boolean => !['select', 'direct', 'groupSelect', 'lasso'].includes(t)
    expect(escapeIntent('direct', true, drawArmed)).toBe('deselect')
    expect(escapeIntent('hand', false, drawArmed)).toBe('disarm')
  })
})

describe('the control contract (SPEC §3.9): FontPicker · BarNumber size · B/I/U toggles · BarColor · three align toggles', () => {
  for (const app of APPS)
    it(`${app.name}'s text controls use the shared primitives, in order${app.exceptions.length ? ` (exceptions: ${app.exceptions.map((e) => e.semantic).join(', ')})` : ''}`, () => {
      act(() => root.render(<ContextBar testid="bar" tabs={app.tabs} ctx={app.ctx} activeTab={app.textTab} onTabChange={noop} menuBar={null} />))
      const panel = document.querySelector('[data-testid="bar-panel"]')!
      expect(controlViolations(panel, { exceptions: app.exceptions, bound: app.bound })).toEqual([])
    })

  it('every exception carries a reason', () => {
    for (const list of Object.values(CONTROL_EXCEPTIONS)) for (const e of list) expect(e.reason.length).toBeGreaterThan(20)
  })
})

describe('Draw: placing returns to Select, a double-click locks, Esc disarms (SPEC §3.2)', () => {
  const lockFromRail = (h: ReturnType<typeof harness>, id: string): void => {
    const item = drawRailItems().find((i) => i.id === id)!
    item.onOptions!({ ctx: h.ed.ctx, s: h.state(), altHeld: () => false })
  }

  it('a shape returns to Select after one placement; locked, it places again; Esc unlocks back to Select', () => {
    const h = harness(blank())
    h.tool('rect')
    h.drag([20, 20], [80, 80])
    expect(h.state().tool).toBe('select')
    lockFromRail(h, 'rect')
    expect([h.state().tool, h.state().toolLocked]).toEqual(['rect', 'rect'])
    h.drag([100, 20], [150, 80])
    h.drag([200, 20], [250, 80])
    expect(h.state().tool).toBe('rect')
    expect(h.objects().length).toBe(3)
    h.key('Escape')
    expect([h.state().tool, h.state().toolLocked]).toEqual(['select', null])
    // Esc with Select and a selection clears it.
    expect(h.state().selection.length).toBe(1)
    h.key('Escape')
    expect(h.state().selection).toEqual([])
  })

  it('Type locks the same way; choosing another tool ends the lock', () => {
    const h = harness(blank())
    lockFromRail(h, 'text')
    h.click(40, 40)
    expect(h.state().tool).toBe('text')
    h.tool('ellipse')
    expect(h.state().toolLocked).toBe(null)
    h.drag([100, 100], [160, 160])
    expect(h.state().tool).toBe('select')
  })

  it('Esc returns the Hand and the path tools to Select, but deselects with the selection tools', () => {
    const h = harness(blank([rect('r', 0, 0, 10, 10)]))
    h.tool('hand')
    h.key('Escape')
    expect(h.state().tool).toBe('select')
    h.tool('direct')
    h.ed.ctx.select(['r'])
    h.key('Escape')
    expect(h.state().tool).toBe('direct')
    expect(h.state().selection).toEqual([])
  })

  it('the rail tooltips say how to lock, and the Hand is called Hand', () => {
    const items = drawRailItems()
    expect(items.find((i) => i.id === 'rect')!.optionsHint).toBe('double-click to keep it selected')
    expect(items.find((i) => i.id === 'text')!.optionsHint).toBe('double-click to keep it selected')
    expect(items.find((i) => i.id === 'hand')!.label).toBe('Hand')
  })
})
