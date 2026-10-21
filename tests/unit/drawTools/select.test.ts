import { describe, it, expect } from 'vitest'
import { nodeBounds } from '../../../src/shared/draw/ops'
import { blank, harness, rect } from './harness'

const box = (h: ReturnType<typeof harness>, id: string) => nodeBounds(h.objects().find((o) => o.id === id)!)

describe('select tool (V)', () => {
  it('a click selects the topmost object; empty canvas clears', () => {
    const h = harness(blank([rect('under', 50, 50, 100, 100), rect('over', 100, 100, 100, 100)]))
    h.click(120, 120)
    expect(h.state().selection).toEqual(['over'])
    h.click(10, 10)
    expect(h.state().selection).toEqual([])
  })

  it('Shift-click adds and removes', () => {
    const h = harness(blank([rect('a', 10, 10, 40, 40), rect('b', 100, 10, 40, 40)]))
    h.click(20, 20)
    h.click(110, 20, { shift: true })
    expect(h.state().selection).toEqual(['a', 'b'])
    h.click(20, 20, { shift: true })
    expect(h.state().selection).toEqual(['b'])
  })

  it('locked and hidden objects, and objects on locked or hidden layers, are not hit', () => {
    const h = harness(
      blank([rect('locked', 10, 10, 40, 40, { locked: true }), rect('hidden', 100, 10, 40, 40, { hidden: true })], {
        layers: [
          { id: 'L1', kind: 'vector', name: 'L1', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [rect('locked', 10, 10, 40, 40, { locked: true }), rect('hidden', 100, 10, 40, 40, { hidden: true })] },
          { id: 'L2', kind: 'vector', name: 'L2', visible: true, locked: true, opacity: 1, blend: 'normal', objects: [rect('onLocked', 200, 10, 40, 40)] }
        ]
      })
    )
    for (const [x, y] of [[20, 20], [110, 20], [210, 20]]) {
      h.click(x, y)
      expect(h.state().selection).toEqual([])
    }
  })

  it('a marquee picks what it touches, Shift adds to the selection', () => {
    const h = harness(blank([rect('a', 10, 10, 20, 20), rect('b', 60, 10, 20, 20), rect('c', 200, 200, 20, 20)]))
    h.drag([0, 0], [70, 40])
    expect(h.state().selection).toEqual(['a', 'b'])
    h.drag([190, 190], [250, 250], { shift: true })
    expect(h.state().selection).toEqual(['a', 'b', 'c'])
  })

  it('a drag moves the object as ONE undo step, snapping to the artboard edge', () => {
    const h = harness(blank([rect('a', 50, 50, 40, 40)]))
    h.drag([60, 60], [13, 70], {}, 4)
    // 50 - 47 = 3 from the left edge: snapped to 0 (within 6px at zoom 1).
    expect(box(h, 'a').x).toBe(0)
    expect(h.state().past).toHaveLength(1)
    h.ed.history.undo()
    expect(box(h, 'a').x).toBe(50)
  })

  it('Shift constrains a move to the dominant axis', () => {
    const h = harness(blank([rect('a', 100, 100, 40, 40)]), { zoom: 1 })
    h.ed.store.setState({ snapOn: false })
    h.drag([110, 110], [180, 125], { shift: true })
    expect(box(h, 'a')).toMatchObject({ x: 170, y: 100 })
  })

  it('a click with no movement leaves no undo step and collapses a multi-selection', () => {
    const h = harness(blank([rect('a', 10, 10, 40, 40), rect('b', 100, 10, 40, 40)]))
    h.run('edit.selectAll')
    h.click(20, 20)
    expect(h.state().past).toHaveLength(0)
    expect(h.state().selection).toEqual(['a'])
  })

  it('a double-click on text starts typing into it', () => {
    const h = harness(blank([{ id: 't', type: 'text', x: 10, y: 10, w: 200, text: 'Hi', fontSize: 20, fill: { type: 'solid', color: '#000' } }]))
    h.click(20, 20)
    h.click(20, 20, { detail: 2 })
    expect(h.state().editingText).toBe('t')
  })

  it('dragging a corner handle scales; Shift keeps the aspect ratio', () => {
    const h = harness(blank([rect('a', 100, 100, 100, 50)]))
    h.ed.store.setState({ snapOn: false })
    h.click(150, 125)
    h.drag([200, 150], [300, 170])
    expect(box(h, 'a')).toMatchObject({ x: 100, y: 100, w: 200, h: 70 })
    h.ed.history.undo()
    h.drag([200, 150], [300, 170], { shift: true })
    expect(box(h, 'a').w / box(h, 'a').h).toBeCloseTo(2, 6)
  })

  it('dragging the rotate knob turns paths and adds rotation to frames', () => {
    const h = harness(blank([rect('a', 100, 100, 100, 100), { id: 'i', type: 'image', x: 300, y: 100, w: 50, h: 50, src: 'data:image/png;base64,AA' }]))
    h.run('edit.selectAll')
    // The selection spans x 100..350, y 100..200 (centre 225,150); the knob sits
    // 22px above its top centre. Dragging it round to due east turns 90°.
    h.drag([225, 100 - 22], [350, 150])
    const img = h.objects().find((o) => o.id === 'i')!
    expect(img.type === 'image' && Math.round(img.rotation ?? 0)).toBe(90)
    expect(h.state().past).toHaveLength(1)
  })

  it('on a read-only drawing it selects but never moves', () => {
    const h = harness({ ...blank([rect('a', 50, 50, 40, 40)]), schemaVersion: 3 })
    expect(h.state().readOnly).toBe(true)
    h.drag([60, 60], [200, 200])
    expect(h.state().selection).toEqual(['a'])
    expect(box(h, 'a').x).toBe(50)
    expect(h.emitted).toHaveLength(0)
  })
})
