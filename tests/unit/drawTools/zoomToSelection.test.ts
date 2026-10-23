// View › Zoom to Selection (4.3.41): the command, its reason when nothing is
// selected, the View menu item and the zoom menu in the bar's right slot, the
// fit maths (padding, the pinned panel's inset, the zoom cap) and its key --
// none by default, because Illustrator's table has none, and remappable.

import { describe, expect, it } from 'vitest'
import { buildMenu } from '../../../src/renderer/src/components/documents/editor/DrawStudioMenuBar'
import { ILLUSTRATOR_SHORTCUTS } from '../../../src/renderer/src/components/documents/draw/commands/illustratorKeys'
import { KEYMAP, RESERVED_KEYS } from '../../../src/renderer/src/components/documents/draw/commands/keymap'
import { shortcutRows } from '../../../src/renderer/src/components/documents/draw/commands/keyCatalog'
import { commandById } from '../../../src/renderer/src/components/documents/draw/commands/registry'
import { ZOOM_TO_SELECTION_PAD, selectionZoomBox } from '../../../src/renderer/src/components/documents/draw/commands/view.commands'
import { createDomServices, type StudioRefs } from '../../../src/renderer/src/components/documents/draw/editor/domServices'
import { ZOOM_MENU_COMMANDS } from '../../../src/renderer/src/components/documents/draw/render/RightSlot'
import { MAX_ZOOM } from '../../../src/renderer/src/components/documents/draw/viewport'
import type { EditorState } from '../../../src/renderer/src/components/documents/draw/editor/types'
import { blank, harness, rect } from './harness'

type Fit = { box: { x: number; y: number; w: number; h: number }; o?: { pad?: number; maxZoom?: number } }

function withFits(content: unknown): { h: ReturnType<typeof harness>; fits: Fit[] } {
  const fits: Fit[] = []
  const h = harness(content, { fitBox: (box, o) => fits.push({ box, o }) })
  return { h, fits }
}

describe('Zoom to Selection: the command', () => {
  it('is disabled, with a reason, while nothing is selected, and running it anyway says so and changes nothing', () => {
    const { h, fits } = withFits(blank([rect('a', 10, 20, 40, 30)]))
    const c = commandById('view.zoomToSelection')!
    expect(c.enabled!(h.ed.ctx)).toBe(false)
    expect(c.disabledReason!(h.ed.ctx)).toBe('Select something to zoom to.')
    h.run('view.zoomToSelection')
    expect(fits).toHaveLength(0)
    expect(h.state().status).toBe('Select something to zoom to.')
    expect(h.state().past).toHaveLength(0)
  })

  it('fits the selection bounds with padding, up to the full zoom range, and is not an edit', () => {
    const { h, fits } = withFits(blank([rect('a', 10, 20, 40, 30), rect('b', 200, 100, 20, 20)]))
    h.ed.ctx.select(['a', 'b'])
    const c = commandById('view.zoomToSelection')!
    expect(c.enabled!(h.ed.ctx)).toBe(true)
    expect(c.disabledReason!(h.ed.ctx)).toBeNull()
    h.run('view.zoomToSelection')
    expect(fits).toEqual([{ box: { x: 10, y: 20, w: 210, h: 100 }, o: { pad: ZOOM_TO_SELECTION_PAD, maxZoom: MAX_ZOOM } }])
    expect(h.state().past).toHaveLength(0)
    expect(h.emitted).toHaveLength(0)
  })

  it('frames a member of a moved group where it is drawn (world bounds)', () => {
    const group = { id: 'g', type: 'group', transform: [1, 0, 0, 1, 100, 50], children: [rect('m', 0, 0, 10, 10), rect('n', 20, 0, 10, 10)] }
    const doc = {
      schemaVersion: 2,
      minWriterVersion: 2,
      artboards: [{ id: 'artboard-1', name: 'Artboard 1', x: 0, y: 0, w: 400, h: 300, background: { type: 'solid', color: '#ffffff' } }],
      layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [group] }],
      assets: {},
      swatches: [],
      guides: [],
      settings: {}
    }
    const { h } = withFits(doc)
    h.ed.ctx.select(['m'])
    expect(selectionZoomBox(h.ed.ctx)).toEqual({ x: 100, y: 50, w: 10, h: 10 })
  })

  it('a straight line (no height) is still framed: the flat side takes the other side’s length, centred', () => {
    const line = { id: 'l', type: 'path', path: { subpaths: [{ closed: false, nodes: [{ x: 0, y: 50 }, { x: 100, y: 50 }] }] }, fill: { type: 'none' }, stroke: { paint: { type: 'solid', color: '#000000' }, width: 0 } }
    const { h } = withFits(blank([line]))
    h.ed.ctx.select(['l'])
    const b = selectionZoomBox(h.ed.ctx)!
    expect(b.w).toBeGreaterThan(0)
    expect(b.h).toBeGreaterThan(0)
    expect(b.y + b.h / 2).toBeCloseTo(50, 5)
  })

  it('works on a read-only drawing (it only looks)', () => {
    const { h, fits } = withFits(blank([rect('a', 10, 20, 40, 30)]))
    h.ed.ctx.select(['a'])
    h.ed.store.setState({ readOnly: true })
    expect(commandById('view.zoomToSelection')!.enabled!(h.ed.ctx)).toBe(true)
    h.run('view.zoomToSelection')
    expect(fits).toHaveLength(1)
  })
})

describe('Zoom to Selection: menus and keys', () => {
  it('is in the View menu, greyed with its reason under it until something is selected', () => {
    const h = harness(blank([rect('a', 10, 20, 40, 30)]))
    const find = () => buildMenu(h.ed.ctx, 'view').find((i) => i.kind === 'item' && i.label === 'Zoom to Selection') as { disabled?: boolean; hint?: string } | undefined
    expect(find()).toMatchObject({ disabled: true, hint: 'Select something to zoom to.' })
    h.ed.ctx.select(['a'])
    const on = find()!
    expect(on.disabled).toBe(false)
    expect(on.hint).toBeUndefined()
  })

  it('sits in the right slot’s zoom menu with Fit Artboard and Fit All', () => {
    expect(ZOOM_MENU_COMMANDS).toContain('view.zoomToSelection')
    expect(ZOOM_MENU_COMMANDS).toContain('view.fit')
    expect(ZOOM_MENU_COMMANDS).toContain('view.fitAll')
    for (const id of ZOOM_MENU_COMMANDS) if (id !== 'sep') expect(commandById(id), id).toBeDefined()
  })

  it('has no default key, as in Illustrator, and steals none; it can be given one', () => {
    expect(ILLUSTRATOR_SHORTCUTS.some((r) => /zoom to selection|fit selection/i.test(r.action))).toBe(false)
    expect(Object.values(KEYMAP).some(([id]) => id === 'view.zoomToSelection')).toBe(false)
    expect(Object.values(RESERVED_KEYS).some(([id]) => id === 'view.zoomToSelection')).toBe(false)
    const row = shortcutRows().find((r) => r.id === 'view.zoomToSelection')!
    expect(row).toMatchObject({ remappable: true, defaultKeys: [], keys: [] })
  })
})

describe('fitBox: padding, the pinned panel and the zoom cap', () => {
  function services(clientWidth: number, clientHeight: number, inset: number): { fit: (b: { x: number; y: number; w: number; h: number }, o?: { pad?: number; maxZoom?: number }) => void; zoom: () => number } {
    let state = { zoom: 1 } as unknown as EditorState
    const el = { clientWidth, clientHeight, querySelector: () => null } as unknown as HTMLDivElement
    const refs = {
      canvases: new Map(),
      loaded: new Map(),
      scratch: { current: null },
      scroll: { current: el },
      onChange: { current: () => {} },
      title: { current: '' },
      liveUndo: { current: undefined },
      inset: { current: inset }
    } as unknown as StudioRefs
    const store = {
      getState: () => state,
      setState: (p: Partial<EditorState>) => {
        state = { ...state, ...p }
      }
    }
    const svc = createDomServices(refs, () => store)
    return { fit: (b, o) => svc.viewport.fitBox!(b, o), zoom: () => state.zoom }
  }

  it('keeps the padding on every side, in the part a pinned panel leaves', () => {
    const s = services(1000, 800, 200)
    s.fit({ x: 0, y: 0, w: 100, h: 100 }, { pad: 40, maxZoom: MAX_ZOOM })
    // Width left: 1000 - 200 inset - 2 × 40 = 720; height 800 - 80 = 720.
    expect(s.zoom()).toBeCloseTo(7.2, 6)
    const wide = services(1000, 800, 0)
    wide.fit({ x: 0, y: 0, w: 100, h: 100 }, { pad: 40, maxZoom: MAX_ZOOM })
    expect(wide.zoom()).toBeCloseTo(7.2, 6) // height-bound
    const narrow = services(600, 800, 200)
    narrow.fit({ x: 0, y: 0, w: 100, h: 100 }, { pad: 40, maxZoom: MAX_ZOOM })
    expect(narrow.zoom()).toBeCloseTo(3.2, 6) // 600 - 200 - 80
  })

  it('caps the zoom: at MAX_ZOOM for a tiny selection, at 400% for Fit by default', () => {
    const s = services(1000, 800, 0)
    s.fit({ x: 0, y: 0, w: 1, h: 1 }, { pad: 40, maxZoom: MAX_ZOOM })
    expect(s.zoom()).toBe(MAX_ZOOM)
    s.fit({ x: 0, y: 0, w: 1, h: 1 })
    expect(s.zoom()).toBe(4)
    // The old Fit, unchanged: a 24 px margin.
    s.fit({ x: 0, y: 0, w: 1904, h: 1504 })
    expect(s.zoom()).toBeCloseTo(0.5, 6)
  })
})
