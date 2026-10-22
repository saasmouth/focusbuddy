// A fit centres in the same frame its zoom is laid out (4.3.41): with the
// studio's pendingCentre hook, an unchanged zoom centres at once and a new
// zoom leaves the centring for the studio's layout effect -- never for two
// animation frames later, when a click made right after opening or fitting
// would land where the view used to be (CO-2, CO-5, AB-3 and CT-1 under load).

import { describe, expect, it } from 'vitest'
import { createDomServices, type StudioRefs } from '../../../src/renderer/src/components/documents/draw/editor/domServices'
import type { EditorState } from '../../../src/renderer/src/components/documents/draw/editor/types'
import { harness, blank } from './harness'

function setup(zoom: number): { fit: () => void; sc: { scrollLeft: number; scrollTop: number }; pending: { current: (() => void) | null }; zoom: () => number } {
  const doc = harness(blank([], {}, 800, 600)).doc()
  let state = { zoom, doc } as unknown as EditorState
  const rect = (left: number, top: number, w: number, h: number) => ({ left, top, width: w, height: h, right: left + w, bottom: top + h })
  const sc = {
    clientWidth: 1000,
    clientHeight: 700,
    clientLeft: 0,
    clientTop: 0,
    scrollLeft: 0,
    scrollTop: 0,
    getBoundingClientRect: () => rect(0, 0, 1000, 700),
    // The stage sits 5000 px into the pasteboard, as on a 227-inch canvas.
    querySelector: () => ({ getBoundingClientRect: () => rect(5000 - sc.scrollLeft, 5000 - sc.scrollTop, 800 * state.zoom, 600 * state.zoom) })
  }
  const pending = { current: null as (() => void) | null }
  const refs = { canvases: new Map(), loaded: new Map(), scratch: { current: null }, scroll: { current: sc }, onChange: { current: () => {} }, title: { current: '' }, liveUndo: { current: undefined }, inset: { current: 0 }, pendingCentre: pending } as unknown as StudioRefs
  const store = { getState: () => state, setState: (p: Partial<EditorState>) => (state = { ...state, ...p }) }
  const svc = createDomServices(refs, () => store)
  return { fit: () => svc.viewport.fit(), sc, pending, zoom: () => state.zoom }
}

describe('fit centres in the frame its zoom lands', () => {
  it('a new zoom: the centring waits for the studio’s layout effect, and then puts the page in the middle', () => {
    const s = setup(1)
    s.fit()
    expect(s.zoom()).not.toBe(1)
    expect(typeof s.pending.current).toBe('function')
    expect(s.sc.scrollLeft).toBe(0)
    s.pending.current!()
    expect(s.pending.current).toBeNull()
    const z = s.zoom()
    // The page's centre is the window's centre.
    expect(5000 - s.sc.scrollLeft + (800 * z) / 2).toBeCloseTo(500, 0)
    expect(5000 - s.sc.scrollTop + (600 * z) / 2).toBeCloseTo(350, 0)
  })

  it('the same zoom again (⌘0 twice): centred at once, nothing left pending', () => {
    const s = setup(1)
    s.fit()
    s.pending.current!()
    s.sc.scrollLeft = 123
    s.fit()
    expect(s.pending.current).toBeNull()
    expect(5000 - s.sc.scrollLeft + (800 * s.zoom()) / 2).toBeCloseTo(500, 0)
  })
})
