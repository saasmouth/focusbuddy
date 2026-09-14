// The tidy grid.
//
// Snapping only. Reflowing a desk into rows is lib/autoArrange.ts's job and has
// been for a while; a second version of it was written here before anyone
// checked, and removed once they did.
import { describe, it, expect } from 'vitest'
import { GRID, snap, snapPosition, snapSize, type GridBox } from '../../src/renderer/src/lib/canvasGrid'

const box = (id: string, x: number, y: number, width = 300, height = 200): GridBox =>
  ({ id, x, y, width, height })

describe('snapping', () => {
  it('rounds to the nearest cell, in both directions', () => {
    expect(snap(0)).toBe(0)
    expect(snap(9)).toBe(0)
    expect(snap(11)).toBe(20)
    expect(snap(-9)).toBe(-0)
    expect(snap(-11)).toBe(-20)
  })

  it('never collapses a widget to nothing', () => {
    // A size that rounds to zero would make a widget unclickable and therefore
    // unrecoverable.
    expect(snapSize(box('a', 0, 0, 4, 4)).width).toBe(GRID)
    expect(snapSize(box('a', 0, 0, 4, 4)).height).toBe(GRID)
  })

  it('snaps position and size independently', () => {
    // Resizing from a top-left handle moves x AND width; rounding them together
    // makes the opposite edge creep on every drag.
    const b = box('a', 13, 27, 313, 227)
    expect(snapPosition(b)).toEqual({ x: 20, y: 20 })
    expect(snapSize(b)).toEqual({ width: 320, height: 220 })
  })
})

// Snapping is wired through Rnd's own dragGrid/resizeGrid rather than by
// correcting a position after the drop. Correcting afterwards is what makes a
// widget appear to jump out from under the cursor on release, and it is the
// obvious-looking change somebody would make if this were only a unit-tested
// helper with no stated home.
describe('where the snap is applied', () => {
  const frame = (): string => {
    const { readFileSync } = require('fs') as typeof import('fs')
    const { resolve } = require('path') as typeof import('path')
    return readFileSync(resolve(__dirname, '../../src/renderer/src/components/widgets/WidgetFrame.tsx'), 'utf8')
  }

  it('hands the grid to Rnd for both dragging and resizing', () => {
    const s = frame()
    expect(s).toMatch(/dragGrid=\{snapOn \? \[GRID, GRID\] : undefined\}/)
    expect(s).toMatch(/resizeGrid=\{snapOn \? \[GRID, GRID\] : undefined\}/)
  })

  it('reads the preference live, so the toggle reaches a desk already open', () => {
    expect(frame()).toContain("window.addEventListener('fb:snap-changed'")
  })
})
