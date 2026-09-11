// The desk paper's geometry.
//
// Reported as "the canvas background changes when scrolling past certain
// points". The points were 5% zoom boundaries: the pattern's cell size was
// quantised to them while the content scaled continuously, and on a Mac
// trackpad a pinch arrives as ctrl+wheel during ordinary two-finger scrolling,
// so the camera crossed them without the user meaning to zoom at all.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  DOT_CELL, GRID_CELL, SUPER_TILE, PATTERN_INSET_PX, patternOffset, superTilePx, dotCellPx
} from '../../src/renderer/src/lib/deskPattern'

// The camera's limits, which are what make the constant inset below correct.
const store = readFileSync(resolve(__dirname, '../../src/renderer/src/stores/widgets.ts'), 'utf8')
const Z_MIN = Number(/const Z_MIN = ([\d.]+)/.exec(store)![1])
const Z_MAX = Number(/const Z_MAX = ([\d.]+)/.exec(store)![1])

describe('desk pattern', () => {
  it('wraps by a whole number of cells, so the wrap is invisible', () => {
    expect(SUPER_TILE % DOT_CELL).toBe(0)
    expect(SUPER_TILE % GRID_CELL).toBe(0)
  })

  it('never travels further than the layer inset that covers it', () => {
    // The inset is a constant in globals.css; if the offset could exceed it the
    // paper would uncover the surface at the top-left edge mid-pan.
    for (let z = Z_MIN; z <= Z_MAX + 1e-9; z += 0.01) {
      expect(superTilePx(z)).toBeLessThanOrEqual(PATTERN_INSET_PX + 1e-9)
      for (const pan of [-1e6, -3333.3, -1, 0, 1, 3333.3, 1e6]) {
        const o = patternOffset(pan, z)
        expect(o).toBeGreaterThanOrEqual(0)
        expect(o).toBeLessThan(superTilePx(z) + 1e-9)
        expect(o).toBeLessThanOrEqual(PATTERN_INSET_PX)
      }
    }
  })

  it('pins the inset to the zoom ceiling it was derived from', () => {
    // Raising Z_MAX without raising the inset would uncover the surface. This
    // is the line that says so.
    expect(PATTERN_INSET_PX).toBe(SUPER_TILE * Z_MAX)
  })

  it('keeps the stylesheet literal in step with the constant', () => {
    const css = readFileSync(
      resolve(__dirname, '../../src/renderer/src/styles/globals.css'), 'utf8'
    )
    const block = css.slice(css.indexOf('.desk-pattern-layer {'))
    const top = /top:\s*(-?\d+)px/.exec(block)![1]
    const left = /left:\s*(-?\d+)px/.exec(block)![1]
    expect(Number(top)).toBe(-PATTERN_INSET_PX)
    expect(Number(left)).toBe(-PATTERN_INSET_PX)
  })

  it('scales the paper continuously, with no step the camera can cross', () => {
    // The defect: the cell size was quantised to 5% zoom steps while content
    // scaled continuously. A 2.5% error is invisible on one cell and compounds
    // with distance, so a dot 1400px out jumped ~70px whenever the camera
    // crossed a step. Asserted against the real cell size the stylesheet uses.
    const FAR_CELLS = 1400 / DOT_CELL
    const STEP = 0.001
    let worst = 0
    for (let z = Z_MIN; z < Z_MAX; z += STEP) {
      const moved = Math.abs(dotCellPx(z + STEP) - dotCellPx(z)) * FAR_CELLS
      worst = Math.max(worst, moved)
    }
    // A 0.001 zoom change may move that dot 1.4px. Quantising made it ~70.
    expect(worst).toBeLessThan(2)
  })
})
