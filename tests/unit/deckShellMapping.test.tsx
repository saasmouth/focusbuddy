// PlexiiDeck on the office shell: NO FEATURE DISAPPEARS (SPEC §5 rule 1).
// Every control the old SlidesToolbar, right ElementInspector and the property
// half of SlidesSidePanel carried must exist on the shell: on the rail, in a
// ContextBar tab (rendered for the selection that makes it apply), on the pinned
// Row 2, or in a menu. Each MAPPING row names the old control, where it went and
// the selection it needs; the test renders that tab and looks for the id.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({ default: ({ name }: { name: string }) => <i data-icon={name} /> }))
vi.mock('../../src/renderer/src/components/Tooltip', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

import { ContextBar, ToolRail } from '../../src/renderer/src/components/office/shell'
import { DECK_TABS, deckRailItems, type DeckCtx } from '../../src/renderer/src/components/documents/slides/ribbon'
import { buildDeckCommands, type DeckCommandDeps } from '../../src/renderer/src/components/documents/slides/deckCommands'
import { BUILTIN_THEMES, resolveTheme } from '../../src/shared/slideThemes'
import type { Slide, SlideElement } from '../../src/shared/types'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const base = { x: 100, y: 100, w: 300, h: 200, z: 1 }
const ELS: Record<string, SlideElement> = {
  text: { ...base, id: 'text', type: 'text', paragraphs: [{ runs: [{ text: 'Hi', fontSize: 24 }] }] },
  shape: { ...base, id: 'shape', type: 'shape', shape: 'rect', fill: { type: 'solid', color: '#ff0000' } },
  gradient: { ...base, id: 'gradient', type: 'shape', shape: 'rect', fill: { type: 'gradient', color: '#ff0000', color2: '#0000ff', angle: 90 } },
  line: { ...base, id: 'line', type: 'line', h: 0, x2: 400, y2: 100, stroke: '#000000', strokeWidth: 2 },
  image: { ...base, id: 'image', type: 'image', src: 'data:,', crop: { x: 0, y: 0, w: 1, h: 1 }, naturalW: 600, naturalH: 400 } as SlideElement,
  table: { ...base, id: 'table', type: 'table', headerRow: true, cells: [['a', 'b'], ['c', 'd']] },
  chart: { ...base, id: 'chart', type: 'chart', chart: { type: 'bar', title: 'T', data: { categories: ['A'], series: [{ name: 'S', values: [1] }] } }, source: { sheetDocId: 's', range: 'A1:B2' } } as SlideElement,
  animated: { ...base, id: 'animated', type: 'shape', shape: 'rect', anim: { type: 'fadeIn', order: 1 } } as SlideElement
}
type Sel = 'none' | keyof typeof ELS | 'many'

function ctxFor(sel: Sel, over: Partial<DeckCtx> = {}): DeckCtx {
  const elements = Object.values(ELS)
  const slide: Slide = { id: 's1', notes: '', layout: 'title-content', elements, transition: 'none', schemaVersion: 2 } as Slide
  const selected = sel === 'none' ? [] : sel === 'many' ? [ELS.shape!, ELS.text!, ELS.line!] : [ELS[sel]!]
  const noop = (): void => {}
  const ed = new Proxy({}, { get: () => noop }) as DeckCtx['ed']
  // The real command record (slides/deckCommands), on stub functions.
  const deps = new Proxy(
    { selected: selected.length, anyGrouped: false, canUndo: false, canRedo: false, canPaste: false, singleSlide: false, textMarks: selected[0]?.type === 'text' ? {} : null } as Record<string, unknown>,
    { get: (t, k) => (k in t ? t[k as string] : noop) }
  ) as unknown as DeckCommandDeps
  return {
    cmds: buildDeckCommands(deps),
    slide,
    theme: resolveTheme('plexi-default'),
    selected,
    el: selected.length === 1 ? selected[0]! : null,
    anyGrouped: false,
    readOnly: false,
    tool: 'select',
    setTool: noop,
    isPanelOpen: () => false,
    togglePanel: noop,
    openPanel: noop,
    sidePane: null,
    openSidePane: noop,
    toggleSidePane: noop,
    ed,
    ...over
  }
}

function renderTab(tab: string, sel: Sel): void {
  act(() => root.render(<ContextBar<DeckCtx> testid="slides-toolbar" tabs={DECK_TABS} ctx={ctxFor(sel)} activeTab={tab} onTabChange={() => {}} menuBar={null} />))
}
const has = (id: string): boolean => !!document.querySelector(`[data-testid="${id}"]`)
const q = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no ${id}`)
  return el
}

// old control → [new testid, tab, selection that makes it apply]
const MAPPING: [string, string, string, Sel][] = [
  // SlidesToolbar
  ['toolbar Text', 'slides-insert-text', 'insert', 'none'],
  ['toolbar Image', 'slides-insert-image', 'insert', 'none'],
  ['toolbar Shape menu (+ Line / arrow)', 'slides-insert-shape', 'insert', 'none'],
  ['toolbar Templates', 'slides-templates-btn', 'insert', 'none'],
  ['toolbar Layout menu', 'slides-prop-layout', 'design', 'none'],
  ['toolbar AI (deck generation, one click)', 'slides-insert-ai', 'insert', 'none'],
  // ElementInspector: nothing selected
  ['inspector Slide transition', 'slides-prop-transition', 'design', 'none'],
  ['inspector Background', 'slides-prop-background', 'design', 'none'],
  ['inspector Theme list', 'slides-prop-theme', 'design', 'none'],
  // ElementInspector: any element
  ['inspector Position x/y/w/h', 'slides-x', 'arrange', 'shape'],
  ['inspector y', 'slides-y', 'arrange', 'shape'],
  ['inspector w', 'slides-w', 'arrange', 'shape'],
  ['inspector h', 'slides-h', 'arrange', 'shape'],
  ['inspector Rotation', 'element-rotation', 'home', 'shape'],
  ['inspector Opacity', 'element-opacity', 'home', 'shape'],
  ['inspector Bring forward', 'slides-forward', 'arrange', 'shape'],
  ['inspector Send back', 'slides-backward', 'arrange', 'shape'],
  ['inspector Duplicate', 'slides-el-duplicate', 'arrange', 'shape'],
  ['inspector Delete', 'slides-el-delete', 'arrange', 'shape'],
  ['inspector Frame radius', 'slides-radius', 'arrange', 'shape'],
  ['inspector Frame shadow', 'inspector-shadow', 'arrange', 'image'],
  ['inspector Entrance animation', 'element-anim', 'animations', 'shape'],
  ['inspector Animation order', 'slides-anim-order', 'animations', 'animated'],
  // text
  ['inspector Bold', 'slides-bold', 'home', 'text'],
  ['inspector Italic', 'slides-italic', 'home', 'text'],
  ['inspector Underline', 'slides-underline', 'home', 'text'],
  ['inspector Text colour', 'slides-text-color', 'home', 'text'],
  ['inspector Align left', 'slides-align-text-left', 'home', 'text'],
  ['inspector Align centre', 'slides-align-text-center', 'home', 'text'],
  ['inspector Align right', 'slides-align-text-right', 'home', 'text'],
  ['inspector Font size', 'slides-font-size', 'home', 'text'],
  ['inspector Font', 'slides-font', 'home', 'text'],
  ['inspector Bulleted list', 'slides-list-bullet', 'home', 'text'],
  ['inspector Numbered list', 'slides-list-number', 'home', 'text'],
  // shape
  ['inspector Fill', 'slides-shape-fill', 'shape', 'shape'],
  ['inspector Border', 'slides-shape-border', 'shape', 'shape'],
  ['inspector Gradient toggle', 'shape-gradient-toggle', 'shape', 'shape'],
  ['inspector Gradient controls', 'shape-gradient', 'shape', 'gradient'],
  ['inspector Gradient → solid', 'shape-gradient-solid', 'shape', 'gradient'],
  // line
  ['inspector Line stroke', 'slides-line-stroke', 'line', 'line'],
  ['inspector Line arrow', 'slides-line-arrow', 'line', 'line'],
  // image
  ['inspector Alt text', 'element-alt', 'image', 'image'],
  ['inspector Fit mode', 'slides-image-fit', 'image', 'image'],
  ['inspector Lock aspect', 'slides-image-lock', 'image', 'image'],
  ['inspector Crop', 'inspector-crop', 'image', 'image'],
  ['inspector Remove crop', 'slides-image-uncrop', 'image', 'image'],
  ['inspector Reset proportions', 'slides-image-reset', 'image', 'image'],
  ['inspector Image border', 'slides-image-border', 'image', 'image'],
  // table (the cell grid lives in the "Table cells" panel, opened by Edit cells)
  ['inspector + Row', 'table-add-row', 'table', 'table'],
  ['inspector + Col', 'table-add-col', 'table', 'table'],
  ['inspector − Row', 'table-remove-row', 'table', 'table'],
  ['inspector − Col', 'table-remove-col', 'table', 'table'],
  ['inspector Header row', 'table-header-row', 'table', 'table'],
  ['inspector cell grid', 'table-edit-cells', 'table', 'table'],
  // chart
  ['inspector Chart title', 'slides-chart-title', 'chart', 'chart'],
  ['inspector Chart type', 'chart-type', 'chart', 'chart'],
  ['inspector Stacked', 'slides-chart-stacked', 'chart', 'chart'],
  ['inspector Link a sheet range', 'chart-link', 'chart', 'chart'],
  ['inspector Refresh from sheet', 'chart-refresh', 'chart', 'chart'],
  // SlidesSidePanel property half
  ['side panel Slide layout', 'slides-prop-layout', 'design', 'none'],
  ['side panel Background', 'slides-prop-background', 'design', 'none'],
  ['side panel Theme colours', 'slides-prop-theme', 'design', 'none'],
  ['side panel Font', 'slides-prop-font', 'design', 'none'],
  ['side panel Master slides → Layouts and themes', 'slides-prop-master', 'design', 'none'],
  // the multi-select align bar
  ['align bar Align', 'slides-align-menu', 'arrange', 'many'],
  ['align bar Distribute', 'slides-distribute-h', 'arrange', 'many'],
  ['align bar Group', 'slides-group', 'arrange', 'many'],
  ['align bar Ungroup', 'slides-ungroup', 'arrange', 'many'],
  // review
  ['menu Check accessibility', 'slides-a11y-btn', 'review', 'none'],
  ['speaker notes (stay under the canvas; Review focuses them)', 'slides-notes-focus', 'review', 'none']
]

describe('every old toolbar, inspector and side-panel control has a home on the shell', () => {
  it.each(MAPPING)('%s → %s on the %s tab (selection: %s)', (_old, id, tab, sel) => {
    renderTab(tab, sel)
    expect(has(`slides-toolbar-tab-${tab}`), `tab ${tab} visible for ${sel}`).toBe(true)
    expect(has(id), `${id} rendered`).toBe(true)
  })

  it('the layout and theme menus offer every layout and every built-in theme, keeping slides-layout-* and slides-theme-*', () => {
    renderTab('design', 'none')
    act(() => q('slides-prop-layout').click())
    for (const l of ['title', 'title-content', 'two-content', 'section', 'image-caption', 'blank']) expect(has(`slides-layout-${l}`), l).toBe(true)
    act(() => q('slides-prop-theme').click())
    for (const t of BUILTIN_THEMES) expect(has(`slides-theme-${t.id}`), t.id).toBe(true)
  })

  it('the rail holds Select, the armed tools (new -tool- ids, SPEC §4.1), the inserts and the two panels', () => {
    act(() => root.render(<ToolRail<DeckCtx> testid="slides-rail" items={deckRailItems()} ctx={ctxFor('none')} activeId="select" />))
    for (const id of ['slides-tool-select', 'slides-tool-text', 'slides-tool-rect', 'slides-rail-image', 'slides-rail-table', 'slides-rail-chart', 'slides-rail-widget', 'slides-rail-layouts', 'slides-rail-ai']) {
      expect(has(id), id).toBe(true)
    }
    const items = deckRailItems()
    expect(items.filter((i) => i.flyout === 'shapes').map((i) => i.testid)).toEqual(['slides-tool-rect', 'slides-tool-roundrect', 'slides-tool-ellipse', 'slides-tool-triangle', 'slides-tool-line'])
    expect(items.find((i) => i.id === 'ai')).toMatchObject({ kind: 'panel', sidePane: true, pinned: 'bottom' })
  })

  it('armed tools arm on click and lock on double-click; the keys are the suite letters', () => {
    const setTool = vi.fn()
    const items = deckRailItems()
    const rect = items.find((i) => i.testid === 'slides-tool-rect')!
    rect.onSelect(ctxFor('none', { setTool }))
    rect.onOptions!(ctxFor('none', { setTool }))
    expect(setTool.mock.calls).toEqual([['rect', false], ['rect', true]])
    expect(Object.fromEntries(items.filter((i) => i.shortcut).map((i) => [i.testid, i.shortcut]))).toEqual({
      'slides-tool-select': 'V',
      'slides-tool-text': 'T',
      'slides-tool-rect': 'M',
      'slides-tool-ellipse': 'L',
      'slides-tool-line': '\\'
    })
  })

  it('contextual tabs follow the selection and never switch on their own (D3)', () => {
    renderTab('home', 'none')
    expect(['shape', 'line', 'image', 'table', 'chart'].filter((t) => has(`slides-toolbar-tab-${t}`))).toEqual([])
    renderTab('home', 'chart')
    expect(has('slides-toolbar-tab-chart')).toBe(true)
    expect(q('slides-toolbar-tab-home').getAttribute('aria-selected')).toBe('true')
    renderTab('home', 'many')
    expect(['shape', 'line', 'image', 'table', 'chart'].filter((t) => has(`slides-toolbar-tab-${t}`))).toEqual([])
  })

  it('selection-only controls say why they are disabled', () => {
    renderTab('arrange', 'none')
    expect((q('slides-group') as HTMLButtonElement).disabled).toBe(true)
    expect(q('slides-group').getAttribute('aria-label')).toMatch(/two or more/i)
    expect((q('slides-el-delete') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a gradient fill keeps its nested shape when edited (color, color2, angle travel together)', () => {
    const updateEl = vi.fn()
    const ctx = ctxFor('gradient')
    ctx.ed = { ...ctx.ed, updateEl }
    act(() => root.render(<ContextBar<DeckCtx> testid="slides-toolbar" tabs={DECK_TABS} ctx={ctx} activeTab="shape" onTabChange={() => {}} menuBar={null} />))
    act(() => q('shape-gradient-solid').click())
    expect(updateEl).toHaveBeenCalledWith('gradient', { fill: { type: 'solid', color: '#ff0000' } })
  })
})
