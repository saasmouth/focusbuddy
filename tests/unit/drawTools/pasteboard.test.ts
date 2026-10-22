// The unlimited pasteboard (4.3.41): Illustrator's 227-inch canvas around the
// artboards, grown to take in everything in the drawing, and the window of it
// the canvas actually draws (never the whole pasteboard).

import { describe, expect, it } from 'vitest'
import { PASTEBOARD_SIDE, contentBounds, pasteboardBounds } from '../../../src/shared/draw/ops'
import { RENDER_OVERSCAN, renderWindow } from '../../../src/renderer/src/components/documents/draw/viewport'
import { blank, harness, rect } from './harness'

const inside = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
  a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h

describe('pasteboardBounds', () => {
  it('is Illustrator’s 16383-unit (about 227 in) square, centred on the artboards, holding them', () => {
    const d = harness(blank([], {}, 800, 600)).doc()
    const p = pasteboardBounds(d)
    expect(p.w).toBeGreaterThanOrEqual(PASTEBOARD_SIDE)
    expect(p.w).toBeLessThanOrEqual(PASTEBOARD_SIDE + 1)
    expect(p.h).toBe(p.w)
    expect(inside(d.artboards[0], p)).toBe(true)
    expect(Math.abs(p.x + p.w / 2 - 400)).toBeLessThanOrEqual(512)
    // Whole units.
    for (const v of [p.x, p.y, p.w, p.h]) expect(Number.isInteger(v)).toBe(true)
  })

  it('grows to take in art far out on the pasteboard, and far-off artboards, so nothing is ever unreachable', () => {
    const far = harness(blank([rect('far', 40000, -30000, 100, 100)])).doc()
    const p = pasteboardBounds(far)
    expect(inside({ x: 40000, y: -30000, w: 100, h: 100 }, p)).toBe(true)
    expect(inside(far.artboards[0], p)).toBe(true)
    const doc = {
      ...harness(blank()).doc(),
      artboards: [
        { id: 'artboard-1', name: 'A', x: 0, y: 0, w: 100, h: 100, background: { type: 'none' as const } },
        { id: 'b', name: 'B', x: 30000, y: 0, w: 100, h: 100, background: { type: 'none' as const } }
      ]
    }
    const q = pasteboardBounds(doc)
    for (const a of doc.artboards) expect(inside(a, q)).toBe(true)
  })

  it('counts hidden and locked art and paint, but not empty paint layers', () => {
    const d = harness(blank([rect('h', -20000, 0, 10, 10, { hidden: true }), rect('l', 0, 25000, 10, 10, { locked: true })])).doc()
    const c = contentBounds(d)!
    expect(c.x).toBe(-20000)
    expect(c.y + c.h).toBe(25010)
    expect(contentBounds(harness(blank()).doc())).toBeNull()
  })

  it('does not move for small artboard moves (the centre snaps to a 512 grid)', () => {
    const d = harness(blank([], {}, 800, 600)).doc()
    const moved = { ...d, artboards: [{ ...d.artboards[0], x: 30, y: 20 }] }
    expect(pasteboardBounds(moved)).toEqual(pasteboardBounds(d))
  })
})

describe('renderWindow: the canvas draws the visible part plus a margin, never the whole pasteboard', () => {
  const extent = { x: -8000, y: -8000, w: 16384, h: 16384 }
  const fallback = { x: 0, y: 0, w: 800, h: 600 }

  it('before layout it is the artboards', () => {
    expect(renderWindow({ visible: null, current: null, extent, fallback, zoomChanged: false })).toEqual(fallback)
  })

  it('is the visible part grown by the overscan on each side, inside the pasteboard', () => {
    const v = { x: 100, y: 100, w: 400, h: 300 }
    const w = renderWindow({ visible: v, current: null, extent, fallback, zoomChanged: false })
    expect(w).toEqual({ x: 100 - 400 * RENDER_OVERSCAN, y: 100 - 300 * RENDER_OVERSCAN, w: 400 * (1 + 2 * RENDER_OVERSCAN), h: 300 * (1 + 2 * RENDER_OVERSCAN) })
    // At the pasteboard's edge it stops there.
    const edge = renderWindow({ visible: { x: -8000, y: -8000, w: 400, h: 300 }, current: null, extent, fallback, zoomChanged: false })
    expect(edge.x).toBe(-8000)
    expect(edge.y).toBe(-8000)
  })

  it('stays put while scrolling within it (no re-render), moves once the view leaves it, and is remade on zoom', () => {
    const first = renderWindow({ visible: { x: 0, y: 0, w: 400, h: 300 }, current: null, extent, fallback, zoomChanged: false })
    expect(renderWindow({ visible: { x: 50, y: 40, w: 400, h: 300 }, current: first, extent, fallback, zoomChanged: false })).toBe(first)
    const moved = renderWindow({ visible: { x: 500, y: 0, w: 400, h: 300 }, current: first, extent, fallback, zoomChanged: false })
    expect(moved).not.toBe(first)
    expect(inside({ x: 500, y: 0, w: 400, h: 300 }, moved)).toBe(true)
    const zoomed = renderWindow({ visible: { x: 50, y: 40, w: 100, h: 75 }, current: first, extent, fallback, zoomChanged: true })
    expect(zoomed.w).toBe(200)
  })

  it('its size on screen is bounded by the window, whatever the zoom: about (1 + 2 × overscan) × the window', () => {
    for (const zoom of [0.05, 1, 4, 16]) {
      const view = { w: 1200 / zoom, h: 800 / zoom }
      const w = renderWindow({ visible: { x: 0, y: 0, ...view }, current: null, extent, fallback, zoomChanged: true })
      expect(w.w * zoom).toBeLessThanOrEqual(1200 * (1 + 2 * RENDER_OVERSCAN) + zoom * 2)
      expect(w.h * zoom).toBeLessThanOrEqual(800 * (1 + 2 * RENDER_OVERSCAN) + zoom * 2)
    }
  })
})
