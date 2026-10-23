// PlexiiDiagrams on the office shell: NO FEATURE DISAPPEARS (SPEC §5 rule 1).
// Every testid the old toolbar and right Inspector carried must exist in the
// new shell: on the rail, in a ContextBar tab (rendered for the selection that
// makes it apply), or on the pinned Row 2. Each row of MAPPING says where it
// went; the test renders that tab and looks for the id.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({ default: ({ name }: { name: string }) => <i data-icon={name} /> }))
vi.mock('../../src/renderer/src/components/Tooltip', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

import { ContextBar, ToolRail } from '../../src/renderer/src/components/office/shell'
import { DIAGRAM_TABS, diagramCtx, diagramRailItems, type DCtx } from '../../src/renderer/src/components/documents/diagram/ribbon'
import { expectNotReadOnly } from './_notReadOnly'
import type { MapEdge, MapNode } from '../../src/shared/types'

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

const node = (id: string, extra: Partial<MapNode> = {}): MapNode => ({ id, x: 0, y: 0, label: id, shape: 'process', color: '#2563eb', ...extra })
const edge: MapEdge = { id: 'e1', source: 'a', target: 'b' }
const cmd = new Proxy({ hasStyleClipboard: () => false }, { get: (t, k) => (k in t ? (t as Record<string, unknown>)[k as string] : () => undefined) }) as unknown as DCtx['cmd']

type Sel = 'none' | 'node' | 'nodes' | 'edge' | 'table'
function ctxFor(sel: Sel): DCtx {
  const nodes = [node('a'), node('b'), node('c'), node('t', { shape: 'table-3x3', cells: [['a', 'b']] })]
  const ids = sel === 'node' ? ['a'] : sel === 'nodes' ? ['a', 'b', 'c'] : sel === 'table' ? ['t'] : []
  const ctx = diagramCtx({
    cmd,
    page: { nodes, edges: [edge] },
    sel: { nodes: new Set(ids), edges: new Set(sel === 'edge' ? ['e1'] : []) },
    settings: {},
    themeId: undefined,
    readOnly: false,
    zoom: 1,
    tool: 'select',
    setTool: () => {},
    openDialog: () => {},
    togglePanel: () => {},
    openPanel: () => {},
    isPanelOpen: () => false,
    sidePane: null,
    toggleSidePane: () => {},
    setStatus: () => {},
    pickImage: () => {}
  })
  expectNotReadOnly('diagramShellMapping', ctx.cmds)
  return ctx
}

function renderTab(tab: string, sel: Sel): void {
  act(() =>
    root.render(<ContextBar<DCtx> testid="diagram-toolbar" tabs={DIAGRAM_TABS} ctx={ctxFor(sel)} activeTab={tab} onTabChange={() => {}} menuBar={null} />)
  )
}
const has = (id: string): boolean => !!document.querySelector(`[data-testid="${id}"]`)

// old testid → [tab, selection that makes it apply]
const MAPPING: [string, string, Sel][] = [
  // old toolbar
  ['diagram-toolbar-fill', 'home', 'node'],
  ['diagram-toolbar-color', 'home', 'node'],
  ['diagram-align-menu', 'home', 'none'],
  ['diagram-tidy', 'home', 'none'],
  ['map-arrange', 'home', 'none'],
  ['diagram-templates', 'insert', 'none'],
  ['diagram-data', 'insert', 'none'],
  // old Inspector: Style
  ['diagram-color', 'shape', 'node'],
  ['diagram-fill', 'shape', 'node'],
  ['diagram-stroke', 'shape', 'node'],
  ['diagram-stroke-width', 'shape', 'node'],
  ['diagram-stroke-dash', 'shape', 'node'],
  ['diagram-shadow', 'shape', 'node'],
  ['diagram-change-shape', 'shape', 'node'],
  ['diagram-shape-icon', 'shape', 'node'], // opens the Icon panel (diagram-icon-input lives there)
  ['diagram-table-rows', 'shape', 'table'],
  // old Inspector: Text
  ['diagram-font', 'text', 'node'],
  ['diagram-font-size', 'text', 'node'],
  ['diagram-bold', 'text', 'node'],
  ['diagram-text-color', 'text', 'node'],
  ['diagram-edit-label', 'text', 'node'], // opens the Label panel (diagram-label-field)
  // old Inspector: Arrange
  ['diagram-x', 'arrange', 'node'],
  ['diagram-y', 'arrange', 'node'],
  ['diagram-w', 'arrange', 'node'],
  ['diagram-h', 'arrange', 'node'],
  ['diagram-rotation', 'arrange', 'node'],
  ['diagram-front', 'arrange', 'node'],
  ['diagram-back', 'arrange', 'node'],
  ['diagram-lock', 'arrange', 'node'],
  ['diagram-group', 'arrange', 'nodes'],
  ['map-align-tools', 'arrange', 'nodes'],
  ['map-align-left', 'arrange', 'nodes'],
  ['map-distribute-h', 'arrange', 'nodes'],
  ['map-distribute-v', 'arrange', 'nodes'],
  // old Inspector: Data (each opens its panel: diagram-link, diagram-data-*, diagram-bind-*, diagram-add-rule)
  ['diagram-open-link', 'data', 'node'],
  ['diagram-open-data', 'data', 'node'],
  ['diagram-open-binding', 'data', 'node'],
  // old Inspector: Line
  ['diagram-routing-orthogonal', 'line', 'edge'],
  ['diagram-routing-curved', 'line', 'edge'],
  ['diagram-routing-straight', 'line', 'edge'],
  ['diagram-line-color', 'line', 'edge'],
  ['diagram-line-width', 'line', 'edge'],
  ['diagram-line-dash', 'line', 'edge'],
  ['diagram-start-arrow', 'line', 'edge'],
  ['diagram-end-arrow', 'line', 'edge'],
  ['diagram-edge-label-field', 'line', 'edge'],
  ['diagram-reset-line', 'line', 'edge'],
  // old Inspector: Page
  ['diagram-theme-section', 'design', 'none'],
  ['diagram-bg', 'design', 'none'],
  ['diagram-grid', 'design', 'none'],
  ['diagram-snap', 'design', 'none'],
  ['diagram-guides', 'design', 'none'],
  ['diagram-default-routing', 'design', 'none'],
  ['diagram-line-jumps', 'design', 'none']
]

describe('every old toolbar and Inspector control has a home on the shell', () => {
  it.each(MAPPING)('%s is on the %s tab (selection: %s)', (id, tab, sel) => {
    renderTab(tab, sel)
    expect(has(`diagram-toolbar-tab-${tab}`), `tab ${tab} visible for ${sel}`).toBe(true)
    expect(has(id), `${id} rendered`).toBe(true)
  })

  it('the old toolbar tools and AI live on the rail; undo/redo/find/zoom stay pinned (rendered by the chrome)', () => {
    act(() => root.render(<ToolRail<DCtx> testid="diagram-rail" items={diagramRailItems()} ctx={ctxFor('none')} activeId="select" />))
    for (const id of ['diagram-tool-select', 'diagram-tool-pan', 'diagram-tool-text', 'diagram-tool-process', 'diagram-toggle-library', 'map-ai']) {
      expect(has(id), id).toBe(true)
    }
  })

  it('contextual tabs follow the selection', () => {
    renderTab('home', 'none')
    expect(['shape', 'text', 'line', 'data'].filter((t) => has(`diagram-toolbar-tab-${t}`))).toEqual([])
    renderTab('home', 'edge')
    expect(has('diagram-toolbar-tab-line')).toBe(true)
    expect(has('diagram-toolbar-tab-shape')).toBe(false)
    renderTab('home', 'nodes')
    expect(has('diagram-toolbar-tab-shape')).toBe(true)
    expect(has('diagram-toolbar-tab-data')).toBe(false) // data forms are for ONE shape
  })

  it('armed shapes use new -tool- ids (SPEC §4.1) and lock on double-click', () => {
    const items = diagramRailItems().filter((i) => i.id.startsWith('shape:'))
    expect(items.map((i) => i.testid)).toEqual(['diagram-tool-process', 'diagram-tool-decision', 'diagram-tool-terminator', 'diagram-tool-data', 'diagram-tool-database', 'diagram-tool-circle'])
    expect(items.every((i) => i.kind === 'tool' && i.flyout === 'shapes' && i.optionsHint === 'double-click to keep it selected')).toBe(true)
    const setTool = vi.fn()
    items[0]!.onOptions!({ ...ctxFor('none'), setTool })
    expect(setTool).toHaveBeenCalledWith('shape:process', true)
  })
})
