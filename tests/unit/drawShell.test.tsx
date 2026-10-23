// PlexiiDraw on the office shell (SPEC §6.2, §5.1): the rail is the tool
// registry (same order, keys from the live keymap, flyouts), every control the
// right-hand inspector and its panels had has a home in a top-bar tab or an
// overlay panel (the mapping table, checked control by control), the panels
// are one state whichever way they are toggled, and the keys the shell needs
// (F7, ⌥F6) are Draw's own.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))

import { drawTools } from '../../src/renderer/src/components/documents/draw/tools/registry'
import { cycleFlyout, flyoutMembers, nextInFlyout, shownInFlyout } from '../../src/renderer/src/components/documents/draw/tools/flyouts'
import { drawBarTabs, barTabById } from '../../src/renderer/src/components/documents/draw/bar/registry'
import { drawPanels } from '../../src/renderer/src/components/documents/draw/panels/registry'
import { activeRailId, drawRailItems, sectionRanks, toolBadge, withBadges } from '../../src/renderer/src/components/documents/draw/render/rail'
import { resetShellPrefs, shellPrefs } from '../../src/renderer/src/components/documents/draw/editor/shellPrefs'
import { fieldKeepsKey, setKeyOverrides, setKeyPlatform } from '../../src/renderer/src/components/documents/draw/commands/keys'
import { commandById } from '../../src/renderer/src/components/documents/draw/commands/registry'
import { buildMenu } from '../../src/renderer/src/components/documents/editor/DrawStudioMenuBar'
import type { DrawBarTab } from '../../src/renderer/src/components/documents/draw/editor/types'
import { blank, harness, rect, type Harness } from './drawTools/harness'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  setKeyPlatform('mac')
  resetShellPrefs()
  setKeyOverrides({ commands: {}, tools: {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const ids = (): string[] => [...host.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')!)
function mount(h: Harness, tab: DrawBarTab | undefined): void {
  const C = tab!.component
  act(() => root.render(<C ctx={h.ed.ctx} />))
}
function star(id: string): Record<string, unknown> {
  return { ...rect(id, 100, 100, 80, 80), shapeKind: 'star', sides: 5, innerRatio: 0.5 }
}

describe('the rail is the tool registry', () => {
  it('keeps the shared rail order (SPEC §3.9): Select, the selection tools and Hand; Type, Shapes, the path tools; then Draw\'s own sections in toolbox order', () => {
    const items = drawRailItems().filter((i) => i.kind === 'tool')
    const tools = drawTools().filter((t) => !t.hidden)
    expect(new Set(items.map((i) => i.id))).toEqual(new Set(tools.map((t) => t.id)))
    const sorted = [...items].sort((a, b) => a.group - b.group || a.order - b.order).map((i) => i.id)
    expect(sorted).toEqual([
      'select', 'direct', 'groupSelect', 'lasso', 'hand',
      'text', 'rect', 'roundRect', 'ellipse', 'polygon', 'star', 'line',
      'pen', 'curvature', 'addAnchor', 'deleteAnchor', 'anchorConvert', 'scissors', 'knife', 'pencil', 'smooth', 'pathEraser', 'join',
      'rotate', 'reflect', 'scale', 'shear', 'reshape', 'freeTransform', 'brush', 'eraser', 'bucket', 'eyedropper', 'artboard'
    ])
    const rank = sectionRanks(tools)
    expect(rank.get(1)).toBe(rank.get(2))
    expect(rank.get(2)).toBe(rank.get(3))
    // Navigate is one section and Create is one section: no dividers inside either.
    expect(new Set(items.filter((i) => ['select', 'direct', 'groupSelect', 'lasso', 'hand'].includes(i.id)).map((i) => i.group)).size).toBe(1)
    expect(new Set(items.filter((i) => ['text', 'rect', 'pen', 'pencil', 'scissors'].includes(i.id)).map((i) => i.group)).size).toBe(1)
    // No tool is hidden from the rail except the Place cursor (a mode, not a button).
    expect(drawTools().filter((t) => t.hidden).map((t) => t.id)).toEqual(['place'])
  })

  it('carries each tool\'s key from the LIVE keymap (a remap shows), read-only safety, options and testid', () => {
    const byId = new Map(drawRailItems().map((i) => [i.id, i]))
    expect(byId.get('rect')!.shortcut).toBe('M')
    expect(byId.get('eraser')!.shortcut).toBe('⇧E')
    expect(byId.get('roundRect')!.shortcut).toBeUndefined()
    expect(byId.get('select')!.readOnlySafe).toBe(true)
    expect(byId.get('hand')!.readOnlySafe).toBe(true)
    expect(byId.get('pen')!.readOnlySafe).toBeFalsy()
    for (const id of ['select', 'rotate', 'reflect', 'scale', 'shear', 'smooth', 'pathEraser']) expect(byId.get(id)!.onOptions, id).toBeTypeOf('function')
    expect(byId.get('rect')!.testid).toBe('draw-tool-rect')
    setKeyOverrides({ commands: {}, tools: { rect: 'g' } })
    expect(new Map(drawRailItems().map((i) => [i.id, i])).get('rect')!.shortcut).toBe('G')
  })

  it('puts the overlay panels at the bottom with their command\'s key (Layers is F7)', () => {
    const panels = drawRailItems().filter((i) => i.kind === 'panel')
    expect(panels.map((p) => [p.id, p.pinned, p.shortcut, p.testid])).toEqual([
      ['layers', 'bottom', 'F7', 'draw-rail-layers'],
      ['artboards', 'bottom', undefined, 'draw-rail-artboards'],
      // PlexiiAssist (the right side pane), last, as in every app.
      ['ai', 'bottom', undefined, 'draw-rail-ai']
    ])
  })

  it('groups tools into Illustrator\'s flyouts', () => {
    const fly = (f: string): string[] => flyoutMembers(f).map((t) => t.id)
    expect(fly('pen')).toEqual(['pen', 'curvature', 'addAnchor', 'deleteAnchor', 'anchorConvert'])
    expect(fly('shapes')).toEqual(['rect', 'roundRect', 'ellipse', 'polygon', 'star', 'line'])
    expect(fly('scissors')).toEqual(['scissors', 'knife'])
    expect(fly('rotate')).toEqual(['rotate', 'reflect'])
    expect(fly('scale')).toEqual(['scale', 'shear', 'reshape'])
    expect(fly('direct')).toEqual(['direct', 'groupSelect'])
    expect(fly('pencil')).toEqual(['pencil', 'smooth', 'pathEraser', 'join'])
    expect(nextInFlyout('line')?.id).toBe('rect')
    expect(nextInFlyout('hand')).toBeNull()
    // Direct Selection fronts its group by default, as in Illustrator.
    expect(shownInFlyout('direct', 'select')?.id).toBe('direct')
    expect(shownInFlyout('shapes', 'select')?.id).toBe('rect')
  })

  it('Alt-click / Next tool in group steps through a group and remembers the tool for the rail', () => {
    const h = harness(blank())
    h.tool('rect')
    expect(cycleFlyout(h.ed.ctx, 'shapes')?.id).toBe('roundRect')
    expect(h.state().tool).toBe('roundRect')
    expect(shellPrefs.getState().lastUsed.shapes).toBe('roundRect')
    h.run('tool.nextInGroup')
    expect(h.state().tool).toBe('ellipse')
    h.tool('hand')
    expect(commandById('tool.nextInGroup')!.enabled!(h.ed.ctx)).toBe(false)
  })

  it('shows borrowed tools as active (Space: Hand; ⌘ with the Pen: Direct Selection) and the Pen mid-path', () => {
    expect(activeRailId({ tool: 'pen', spaceDown: true, gesture: null }, false)).toBe('hand')
    expect(activeRailId({ tool: 'pen', spaceDown: false, gesture: null }, true)).toBe('direct')
    expect(activeRailId({ tool: 'pen', spaceDown: false, gesture: { toolId: 'direct', data: null } }, false)).toBe('direct')
    expect(activeRailId({ tool: 'rect', spaceDown: false, gesture: null }, true)).toBe('rect')
    const h = harness(blank())
    h.tool('pen')
    h.click(50, 50)
    h.click(150, 50)
    const pen = drawTools().find((t) => t.id === 'pen')!
    expect(toolBadge(pen, h.state())).toBe('dot')
    expect(withBadges(drawRailItems(), h.state()).find((i) => i.id === 'pen')!.label).toBe('Pen — continuing a path')
    h.key('Enter')
    expect(toolBadge(pen, h.state())).toBeUndefined()
  })
})

describe('panels: one state whichever way it is toggled', () => {
  it('F7, Window › Layers and the rail button all toggle the same open state, which the menu checks', () => {
    const h = harness(blank())
    expect(drawPanels().map((p) => [p.id, p.command])).toEqual([
      ['layers', 'window.layers'],
      ['artboards', 'window.artboards']
    ])
    h.key('F7')
    expect(h.state().openPanels).toEqual(['layers'])
    const menu = buildMenu(h.ed.ctx, 'window')
    expect(menu.find((m) => m.kind === 'item' && m.label === 'Layers')).toMatchObject({ active: true, shortcut: 'F7' })
    drawRailItems().find((i) => i.id === 'layers')!.onSelect({ ctx: h.ed.ctx, s: h.state(), altHeld: () => false })
    expect(h.state().openPanels).toEqual([])
    h.run('window.artboards', true)
    h.run('window.artboards', true)
    expect(h.state().openPanels).toEqual(['artboards'])
  })

  it('F7 works on a read-only drawing (looking is allowed) and from a field (function keys never type)', () => {
    const h = harness({ ...blank([rect('a', 0, 0, 10, 10)]), schemaVersion: 3, minWriterVersion: 3 })
    expect(h.state().readOnly).toBe(true)
    h.key('F7')
    expect(h.state().openPanels).toEqual(['layers'])
    expect(fieldKeepsKey({ key: 'F7', code: 'F7', metaKey: false, ctrlKey: false, shiftKey: false })).toBe(false)
    expect(fieldKeepsKey({ key: 'a', code: 'KeyA', metaKey: false, ctrlKey: false, shiftKey: false })).toBe(true)
  })

  it('⌥F6 cycles focus through the studio chrome, and is off where there is no chrome (headless)', () => {
    const h = harness(blank())
    expect(commandById('window.focusNext')!.enabled!(h.ed.ctx)).toBe(false)
    const cycleFocus = vi.fn()
    h.ed.ctx.ui = { cycleFocus }
    h.key('F6', { alt: true })
    expect(cycleFocus).toHaveBeenCalledTimes(1)
  })
})

describe('the top bar\'s tabs', () => {
  it('Home, Object and Align always; contextual tabs only while their context holds', () => {
    const always = drawBarTabs().filter((t) => !t.when).map((t) => t.id)
    expect(always).toEqual(['home', 'insert', 'object', 'align'])
    const h = harness(blank([rect('r', 0, 0, 50, 50), star('s'), { id: 't', type: 'text', x: 0, y: 200, w: 100, text: 'Hi', fontSize: 20, fill: { type: 'solid', color: '#000000' } }]))
    const showing = (): string[] => drawBarTabs().filter((t) => t.when && t.when(h.state())).map((t) => t.id)
    expect(showing()).toEqual([])
    h.ed.ctx.select(['r'])
    expect(showing()).toEqual(['path'])
    h.ed.ctx.select(['s'])
    expect(showing()).toEqual(['shape', 'path'])
    h.ed.ctx.select(['t'])
    expect(showing()).toEqual(['type'])
    h.ed.ctx.select(['r', 's'])
    expect(showing()).toEqual(['path', 'group'])
    h.ed.ctx.select([])
    h.tool('brush')
    expect(showing()).toEqual(['brush'])
    h.tool('artboard')
    expect(showing()).toEqual(['artboard'])
  })
})

// The mapping table (SPEC §5.1): every control of the retired right-hand
// column -- the inspector, the Transform, Align and Anchor points panels --
// and of the retired OptionsBar row, and where it lives now. Each id is
// checked present in its new home.
const MAPPING: Array<{ from: string; to: string; ids: string[]; setup: (h: Harness) => void }> = [
  { from: 'Inspector › Fill, Stroke, width, dash, ends, corners, opacity, blend', to: 'home', ids: ['draw-fill', 'draw-stroke', 'draw-stroke-width', 'draw-stroke-dash', 'draw-stroke-cap', 'draw-stroke-join', 'draw-object-opacity', 'draw-object-blend'], setup: (h) => h.ed.ctx.select(['r']) },
  { from: 'Inspector › Type (font, size, weight, align, italic, leading, tracking)', to: 'type', ids: ['draw-text-family', 'draw-text-size', 'draw-text-weight', 'draw-text-align-left', 'draw-text-align-center', 'draw-text-align-right', 'draw-text-italic', 'draw-text-leading', 'draw-text-tracking'], setup: (h) => h.ed.ctx.select(['t']) },
  { from: 'Inspector › Shape (points, inset)', to: 'shape', ids: ['draw-shape-sides', 'draw-shape-inner'], setup: (h) => h.ed.ctx.select(['s']) },
  { from: 'Inspector › Shape (corner radius)', to: 'shape', ids: ['draw-shape-radius'], setup: (h) => h.ed.ctx.select(['rr']) },
  { from: 'Inspector › Brush and Brush settings', to: 'brush', ids: ['draw-brush-presets', 'draw-brush-round-soft', 'draw-brush-size', 'draw-brush-opacity', 'draw-brush-flow', 'draw-brush-hardness', 'draw-brush-color', 'draw-brush-grain', 'draw-brush-jitter', 'draw-brush-spacing', 'draw-brush-angle', 'draw-brush-pressure'], setup: (h) => h.tool('brush') },
  { from: 'Inspector › Pathfinder, Join into one path (now Compound Path › Make); Path › Close, Open, Reverse', to: 'path', ids: ['draw-bool-union', 'draw-bool-subtract', 'draw-bool-intersect', 'draw-bool-exclude', 'draw-path-close', 'draw-path-open', 'draw-path-reverse', 'draw-path-join', 'draw-path-average', 'draw-path-simplify', 'draw-path-cut', 'draw-compound-make', 'draw-compound-release'], setup: (h) => h.ed.ctx.select(['r', 's']) },
  { from: 'Inspector › Arrange (4); Transform panel (ref point, X, Y, W, H, constrain, rotate, shear, flips, Scale Corners, Scale Strokes)', to: 'object', ids: ['draw-arrange-front', 'draw-arrange-forward', 'draw-arrange-backward', 'draw-arrange-back', 'draw-transform-ref', 'draw-transform-x', 'draw-transform-y', 'draw-transform-w', 'draw-transform-h', 'draw-transform-constrain', 'draw-transform-rotate', 'draw-transform-shear', 'draw-transform-flip-h', 'draw-transform-flip-v', 'draw-transform-scale-corners', 'draw-transform-scale-strokes', 'draw-transform-again', 'draw-transform-menu'], setup: (h) => h.ed.ctx.select(['r']) },
  { from: 'Inspector › Align (6) and Distribute H/V; Align panel (align 6, distribute 6, spacing 2, spacing value, Auto, Align To)', to: 'align', ids: ['draw-alignpanel-left', 'draw-alignpanel-center', 'draw-alignpanel-right', 'draw-alignpanel-top', 'draw-alignpanel-middle', 'draw-alignpanel-bottom', 'draw-distribute-top', 'draw-distribute-vcenter', 'draw-distribute-bottom', 'draw-distribute-left', 'draw-distribute-hcenter', 'draw-distribute-right', 'draw-distribute-space-h', 'draw-distribute-space-v', 'draw-align-spacing', 'draw-align-spacing-auto', 'draw-align-to'], setup: (h) => h.ed.ctx.select(['r', 's']) },
  { from: 'Anchor points panel (count, convert, handles, remove, cut, align 6, corner, Join/Average/Simplify)', to: 'anchors', ids: ['draw-anchors-count', 'draw-anchor-corner', 'draw-anchor-smooth', 'draw-anchor-handles', 'draw-anchor-remove', 'draw-anchor-cut', 'draw-anchor-align-left', 'draw-anchor-align-hcenter', 'draw-anchor-align-right', 'draw-anchor-align-top', 'draw-anchor-align-vcenter', 'draw-anchor-align-bottom', 'draw-anchor-radius', 'draw-anchor-round', 'draw-path-join', 'draw-path-average', 'draw-path-simplify'], setup: (h) => { h.tool('direct'); h.click(50, 0) } },
  { from: 'Anchor points panel › Smooth / Path Eraser options', to: 'anchors', ids: ['draw-trail-options', 'draw-smooth-fidelity', 'draw-trail-size'], setup: (h) => h.tool('smooth') },
  { from: 'Artboards (contextual, new): name, W/H, preset, orientation, Artboards…', to: 'artboard', ids: ['draw-artboard-name', 'draw-artboard-w', 'draw-artboard-h', 'draw-artboard-preset', 'draw-artboard-portrait', 'draw-artboard-landscape', 'draw-artboard-with-art', 'draw-artboard-new', 'draw-artboard-duplicate', 'draw-artboard-delete', 'draw-artboard-options', 'draw-artboard-panel-open'], setup: (h) => h.tool('artboard') },
  { from: 'Group / isolation / clipping (new contextual home of menu commands)', to: 'group', ids: ['draw-group', 'draw-ungroup', 'draw-isolate', 'draw-exit-isolation', 'draw-clip-make', 'draw-clip-release', 'draw-clip-edit-mask', 'draw-clip-edit-contents'], setup: (h) => h.ed.ctx.select(['r', 's']) },
  { from: 'Image (new contextual home of Replace image…, Place as template…)', to: 'image', ids: ['draw-image-replace', 'draw-image-template', 'draw-image-info'], setup: (h) => h.ed.ctx.select(['im']) }
]

describe('no control is lost (the mapping table, SPEC §5.1)', () => {
  const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const doc = (): Record<string, unknown> =>
    blank([
      rect('r', 0, 0, 50, 50, { stroke: { paint: { type: 'solid', color: '#000000' }, width: 2 } }),
      star('s'),
      { ...rect('rr', 200, 0, 50, 50), shapeKind: 'roundRect', cornerRadius: 8 },
      { id: 't', type: 'text', x: 0, y: 200, w: 100, text: 'Hi', fontSize: 20, fill: { type: 'solid', color: '#000000' } },
      { id: 'im', type: 'image', x: 300, y: 200, w: 40, h: 30, src: PX }
    ])
  for (const m of MAPPING) {
    it(`${m.from} → ${m.to}`, () => {
      const h = harness(doc())
      m.setup(h)
      const tab = barTabById(m.to)!
      expect(tab, m.to).toBeTruthy()
      if (tab.when) expect(tab.when(h.state()), `${m.to} shows in this context`).toBe(true)
      mount(h, tab)
      const have = new Set(ids())
      for (const id of m.ids) expect(have.has(id), `${id} on ${m.to}`).toBe(true)
    })
  }

  it('the Layers and Artboards panels keep every control (overlay panels now)', () => {
    const h = harness(blank())
    for (const [pid, want] of [
      ['layers', ['draw-layers-panel', 'draw-add-vector-layer', 'draw-add-raster-layer', 'draw-layer-blend', 'draw-layer-opacity']],
      ['artboards', ['draw-artboards-panel', 'draw-artboards-new', 'draw-artboards-duplicate', 'draw-artboards-rearrange', 'draw-artboards-delete', 'draw-artboards-list', 'draw-artboards-w', 'draw-artboards-h', 'draw-artboards-x', 'draw-artboards-y', 'draw-artboards-preset', 'draw-artboards-with-art']]
    ] as const) {
      const P = drawPanels().find((p) => p.id === pid)!.component
      act(() => root.render(<P ctx={h.ed.ctx} />))
      const have = new Set(ids())
      for (const id of want) expect(have.has(id), `${id} in ${pid}`).toBe(true)
    }
  })
})

describe('bar fields record one undo step per real change', () => {
  it('a BarNumber left with its value unchanged does not report a change (no empty undo step)', async () => {
    const { BarNumber } = await import('../../src/renderer/src/components/office/shell')
    const onChange = vi.fn()
    act(() => root.render(<BarNumber label="Opacity" value={50} onChange={onChange} testid="n" />))
    const input = host.querySelector('[data-testid="n"]') as HTMLInputElement
    act(() => {
      input.focus()
      input.blur()
    })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onChange).not.toHaveBeenCalled()
    // A real change is reported once.
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, '60')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(60)
  })
})
