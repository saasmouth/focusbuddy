import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createEdgePanArming, isInEdgeZone } from '../../src/renderer/src/lib/edgePanArming'

// Edge-pan used to start whenever the cursor's position RELATIVE to the canvas
// fell inside the 80 px zone, however it got there. A pointer resting just
// outside the zone near the dock was put "inside" it by the surface shifting
// under it (Chromium re-sends a mousemove at the old screen point after a
// scroll or layout shift), and the desk then drifted away at ~750 px/s for as
// long as the hand rested there. These pin the rule: only a pointer that MOVED
// into the zone pans.

describe('edge-pan arming (pure)', () => {
  const at = (x: number, y: number, movementX = 0, movementY = 0) => ({ clientX: x, clientY: y, movementX, movementY })

  it('a stationary pointer the zone slides under does not arm', () => {
    const a = createEdgePanArming()
    expect(a.observe(at(400, 300, 3, 0), 'interior')).toBe(false) // resting outside the zone
    // The surface shifts: Chromium's fake mousemove, same screen point, no delta.
    expect(a.observe(at(400, 300), 'zone')).toBe(false)
    expect(a.observe(at(400, 300), 'zone')).toBe(false)
    expect(a.armed).toBe(false)
  })

  it('a pointer that moves into the zone arms, and holding still there keeps it armed', () => {
    const a = createEdgePanArming()
    a.observe(at(400, 300, 2, 0), 'interior')
    expect(a.observe(at(330, 300, -70, 0), 'zone')).toBe(true)
    // Holding a dragged widget still at the edge: dragover repeats at the same point.
    expect(a.observe(at(330, 300), 'zone')).toBe(true)
    expect(a.observe(at(330, 300), 'zone')).toBe(true)
  })

  it('leaving the zone disarms, however it happened, and a shift back does not re-arm', () => {
    const a = createEdgePanArming()
    a.observe(at(400, 300, 1, 0), 'interior')
    a.observe(at(330, 300, -70, 0), 'zone')
    expect(a.observe(at(330, 300), 'interior')).toBe(false) // the zone moved away from a still pointer
    expect(a.observe(at(330, 300), 'zone')).toBe(false) // and back again: still a still pointer
  })

  it('a clientX change counts as movement even when the OS delta is missing (dragover)', () => {
    const a = createEdgePanArming()
    a.observe(at(400, 300), 'interior')
    expect(a.observe(at(395, 300), 'zone')).toBe(true)
  })

  it('the first event with no delta does not arm (a fake move when a desk mounts under the cursor)', () => {
    const a = createEdgePanArming()
    expect(a.observe(at(300, 300), 'zone')).toBe(false)
    const b = createEdgePanArming()
    expect(b.observe(at(300, 300, 4, 0), 'zone')).toBe(true)
  })

  it('moves noted off the canvas are the reference for the next canvas event', () => {
    const a = createEdgePanArming()
    a.note(at(250, 300)) // over the dock
    expect(a.observe(at(250, 300), 'zone')).toBe(false) // same point: no move
    a.note(at(240, 300))
    expect(a.observe(at(290, 300), 'zone')).toBe(true)
  })

  it('disarm() stops an armed pan', () => {
    const a = createEdgePanArming()
    a.observe(at(10, 10, 5, 5), 'zone')
    a.disarm()
    expect(a.armed).toBe(false)
  })

  it('a drag from off the desk crossing the edge zone does not arm, however it moves', () => {
    const a = createEdgePanArming()
    a.dragBegan(false) // the Files panel, the side menu
    a.note(at(250, 300)) // over the dock
    expect(a.observe(at(290, 300, 40, 0), 'zone')).toBe(false)
    expect(a.observe(at(330, 300, 40, 0), 'zone')).toBe(false)
    expect(a.observe(at(330, 300), 'zone')).toBe(false) // held still on the way in
    expect(a.enteringFromOutside).toBe(true)
  })

  it('once that drag reaches the interior it is an ordinary pointer: a real move back to an edge arms and holds', () => {
    const a = createEdgePanArming()
    a.dragBegan(false)
    a.observe(at(330, 300, 40, 0), 'zone')
    expect(a.observe(at(600, 300, 270, 0), 'interior')).toBe(false)
    expect(a.enteringFromOutside).toBe(false)
    expect(a.observe(at(330, 300, -270, 0), 'zone')).toBe(true)
    expect(a.observe(at(330, 300), 'zone')).toBe(true) // dragover repeating at a still point
  })

  it('passing off the canvas (dock, header) is not the interior: the entry is still pending', () => {
    const a = createEdgePanArming()
    a.dragBegan(false)
    a.observe(at(200, 300, 10, 0), 'off')
    expect(a.enteringFromOutside).toBe(true)
    expect(a.observe(at(300, 300, 100, 0), 'zone')).toBe(false)
  })

  it('a hover-armed pan stops when a drag from off the desk begins', () => {
    const a = createEdgePanArming()
    a.observe(at(400, 300, 2, 0), 'interior')
    expect(a.observe(at(330, 300, -70, 0), 'zone')).toBe(true)
    a.dragBegan(false)
    expect(a.armed).toBe(false)
  })

  it('a drag that starts on the desk arms on a real move into the zone, as hover does', () => {
    const a = createEdgePanArming()
    a.dragBegan(true) // a row out of a sheet on the desk
    expect(a.enteringFromOutside).toBe(false)
    a.observe(at(400, 300, 2, 0), 'interior')
    expect(a.observe(at(330, 300, -70, 0), 'zone')).toBe(true)
  })

  it('disarm() keeps a pending entry; dragEnded() clears it and disarms', () => {
    const a = createEdgePanArming()
    a.dragBegan(false)
    a.disarm() // the pointer left the canvas mid-drag
    expect(a.enteringFromOutside).toBe(true)
    a.dragEnded()
    expect(a.enteringFromOutside).toBe(false)
    expect(a.armed).toBe(false)
    // The next pointer (no drag) is judged by the movement rule alone.
    a.observe(at(400, 300, 2, 0), 'interior')
    expect(a.observe(at(330, 300, -70, 0), 'zone')).toBe(true)
  })

  it('zone test matches the pan loop (strictly inside the margin on any edge)', () => {
    const size = { width: 1000, height: 600 }
    expect(isInEdgeZone({ x: 79, y: 300 }, size, 80)).toBe(true)
    expect(isInEdgeZone({ x: 80, y: 300 }, size, 80)).toBe(false)
    expect(isInEdgeZone({ x: 500, y: 300 }, size, 80)).toBe(false)
    expect(isInEdgeZone({ x: 925, y: 300 }, size, 80)).toBe(true)
    expect(isInEdgeZone({ x: 500, y: 590 }, size, 80)).toBe(true)
    expect(isInEdgeZone({ x: 10, y: 10 }, size, 0)).toBe(false)
  })
})

// The hook itself, driven through real DOM events and a hand-cranked rAF.
const panBy = vi.fn()
vi.mock('../../src/renderer/src/stores/widgets', () => ({
  useWidgetStore: (sel: (s: { panBy: typeof panBy }) => unknown) => sel({ panBy })
}))

describe('useEdgePan pans only for a pointer that moved into the zone', () => {
  let frames: FrameRequestCallback[] = []
  let now = 0
  let el: HTMLDivElement
  let rectLeft = 0

  function step(n: number): void {
    for (let i = 0; i < n; i++) {
      const due = frames
      frames = []
      now += 16
      act(() => due.forEach((f) => f(now)))
    }
  }
  function move(x: number, y: number, movementX = 0, movementY = 0, target: Element = el): void {
    act(() => {
      target.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, movementX, movementY, bubbles: true }))
    })
  }

  beforeEach(() => {
    panBy.mockClear()
    frames = []
    now = 0
    rectLeft = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => (frames.push(cb), frames.length))
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    document.documentElement.style.setProperty('--fb-dock-inset', '272px')
    el = document.createElement('div')
    document.body.appendChild(el)
    // A 1400 x 900 canvas whose left edge is `rectLeft` (a shift moves it).
    el.getBoundingClientRect = () =>
      ({ left: rectLeft, top: 0, right: rectLeft + 1400, bottom: 900, width: 1400, height: 900, x: rectLeft, y: 0, toJSON: () => ({}) }) as DOMRect
  })
  afterEach(() => {
    el.remove()
    document.documentElement.classList.remove('fb-canvas-dragging')
    document.documentElement.style.removeProperty('--fb-dock-inset')
    vi.unstubAllGlobals()
  })

  // A minimal renderHook: mount a component that calls the hook and keeps
  // its latest return value.
  async function mount() {
    const { useEdgePan } = await import('../../src/renderer/src/lib/useEdgePan')
    const result: { current: ReturnType<typeof useEdgePan> } = { current: { top: 0, right: 0, bottom: 0, left: 0 } }
    function Probe(): null {
      result.current = useEdgePan({ container: el, disabled: false })
      return null
    }
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(createElement(Probe)))
    return { result, unmount: () => act(() => root.unmount()) }
  }

  it('stationary pointer + content shift into the zone: no pan', async () => {
    const h = await mount()
    // Rest the pointer 100 px right of the dock edge (272): outside the 80 px zone.
    move(380, 450, -2, 0)
    move(372, 450, -8, 0)
    step(10)
    expect(panBy).not.toHaveBeenCalled()
    // The surface shifts 40 px right under the still pointer: it is now 60 px
    // from the visible edge, inside the zone. Chromium re-sends the old point.
    rectLeft = 40
    move(372, 450)
    step(90) // ~1.5 s of frames
    expect(panBy).not.toHaveBeenCalled()
    expect(h.result.current.left).toBe(0)
    h.unmount()
  })

  it('a pointer moved into the zone while dragging a widget pans, and keeps panning while held still', async () => {
    const h = await mount()
    move(500, 450, 3, 0)
    act(() => document.documentElement.classList.add('fb-canvas-dragging'))
    await Promise.resolve() // MutationObserver delivery
    move(400, 450, -100, 0)
    move(300, 450, -100, 0) // 28 px from the dock edge
    step(5)
    expect(panBy).toHaveBeenCalled()
    const [dx] = panBy.mock.calls.at(-1)!
    expect(dx).toBeGreaterThan(0) // left edge → world moves right
    expect(h.result.current.left).toBeGreaterThan(0)
    panBy.mockClear()
    step(20) // held still at the edge
    expect(panBy.mock.calls.length).toBeGreaterThanOrEqual(19)
    h.unmount()
  })

  it('the dock widening under a pointer resting near the right edge: no pan (no event at all)', async () => {
    document.documentElement.style.setProperty('--fb-dock-inset', '58px')
    const h = await mount()
    move(1250, 450, 4, 0)
    move(1280, 450, 30, 0) // 120 px from the right edge: outside the zone
    step(10)
    expect(panBy).not.toHaveBeenCalled()
    // The menu expands (58 → 272 px). The pointer has not moved and is still
    // 120 px from the right edge. The old hook kept the canvas-relative x from
    // the last event and shrank the width, putting the pointer 94 px PAST the
    // edge, and panned at over three times full speed.
    act(() => document.documentElement.style.setProperty('--fb-dock-inset', '272px'))
    await Promise.resolve() // MutationObserver delivery
    step(90)
    expect(panBy).not.toHaveBeenCalled()
    expect(h.result.current.right).toBe(0)
    h.unmount()
  })

  it('the dock widening so a resting pointer sits in the left zone: no pan', async () => {
    document.documentElement.style.setProperty('--fb-dock-inset', '58px')
    const h = await mount()
    move(330, 450, 4, 0)
    move(302, 450, -28, 0) // 244 px from the dock edge
    step(5)
    act(() => document.documentElement.style.setProperty('--fb-dock-inset', '272px')) // now 30 px from it
    await Promise.resolve()
    step(90)
    expect(panBy).not.toHaveBeenCalled()
    h.unmount()
  })

  it('a real move into the zone over an overlay above the canvas arms; the pan starts once the canvas sees the point', async () => {
    const h = await mount()
    const overlay = document.createElement('div') // a portalled context-menu scrim: not inside the canvas
    document.body.appendChild(overlay)
    move(700, 450, 3, 0)
    act(() => el.dispatchEvent(new MouseEvent('mouseleave')))
    move(700, 700, 0, 250, overlay)
    move(700, 880, 0, 180, overlay) // 20 px from the bottom edge
    step(5)
    expect(panBy).not.toHaveBeenCalled() // the canvas has no point yet
    overlay.remove()
    move(700, 880) // Chromium re-sends the resting point when the overlay goes
    step(5)
    expect(panBy).toHaveBeenCalled()
    h.unmount()
  })

  it('a move over the dock (off the visible canvas) disarms', async () => {
    const h = await mount()
    const dock = document.createElement('div')
    document.body.appendChild(dock)
    move(700, 450, 3, 0)
    move(300, 450, -400, 0) // in the left zone: armed
    step(2)
    expect(panBy).toHaveBeenCalled()
    act(() => el.dispatchEvent(new MouseEvent('mouseleave')))
    move(200, 450, -100, 0, dock) // over the dock
    panBy.mockClear()
    move(200, 450) // back on the canvas element at a point under the dock: outside
    step(10)
    expect(panBy).not.toHaveBeenCalled()
    dock.remove()
    h.unmount()
  })

  it('an armed pan stops when the zone shifts away from the still pointer, and does not restart when it shifts back', async () => {
    const h = await mount()
    move(500, 450, 3, 0)
    move(300, 450, -200, 0)
    step(3)
    expect(panBy).toHaveBeenCalled()
    rectLeft = -60 // the surface shifts left: the pointer is 88 px in, outside the zone
    move(300, 450)
    panBy.mockClear()
    step(10)
    expect(panBy).not.toHaveBeenCalled()
    rectLeft = 0
    move(300, 450)
    step(10)
    expect(panBy).not.toHaveBeenCalled()
    h.unmount()
  })

  // HTML5 drags: the hook reads dragover (mousemove does not fire during one).
  function dragEvent(type: 'dragstart' | 'dragover' | 'dragend', target: Element, x = 0, y = 0): void {
    act(() => {
      target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }))
    })
  }

  it('a drag from beside the desk crossing the left zone does not pan until it has reached the interior', async () => {
    const h = await mount()
    const panel = document.createElement('div') // the Files panel: not inside the canvas
    document.body.appendChild(panel)
    dragEvent('dragstart', panel, 200, 450)
    dragEvent('dragover', panel, 230, 450) // over the dock, off the visible canvas
    dragEvent('dragover', el, 290, 450) // 18 px into the desk: in the zone, really moving
    dragEvent('dragover', el, 320, 450)
    step(20)
    expect(panBy).not.toHaveBeenCalled()
    expect(h.result.current.left).toBe(0)
    dragEvent('dragover', el, 700, 450) // the interior
    step(5)
    expect(panBy).not.toHaveBeenCalled()
    dragEvent('dragover', el, 300, 450) // carried back to the edge on purpose
    step(5)
    expect(panBy).toHaveBeenCalled()
    panBy.mockClear()
    dragEvent('dragover', el, 300, 450) // held still there: dragover repeats
    step(10)
    expect(panBy.mock.calls.length).toBeGreaterThanOrEqual(9)
    dragEvent('dragend', panel)
    panBy.mockClear()
    step(10)
    expect(panBy).not.toHaveBeenCalled()
    panel.remove()
    h.unmount()
  })

  it('a drag that starts on the desk pans on a real move into the zone, with no interior step', async () => {
    const h = await mount()
    const row = document.createElement('div') // a row in a sheet widget on the desk
    el.appendChild(row)
    dragEvent('dragstart', row, 500, 450)
    dragEvent('dragover', el, 500, 450)
    dragEvent('dragover', el, 300, 450)
    step(5)
    expect(panBy).toHaveBeenCalled()
    dragEvent('dragend', row)
    h.unmount()
  })

  it('after a drag from beside the desk ends, plain hover into the zone pans again', async () => {
    const h = await mount()
    const panel = document.createElement('div')
    document.body.appendChild(panel)
    dragEvent('dragstart', panel, 200, 450)
    dragEvent('dragover', el, 300, 450)
    dragEvent('dragend', panel) // dropped in the zone, never reached the interior
    move(500, 450, 3, 0)
    move(300, 450, -200, 0)
    step(5)
    expect(panBy).toHaveBeenCalled()
    panel.remove()
    h.unmount()
  })
})
