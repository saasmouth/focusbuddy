import { describe, it, expect } from 'vitest'
import type { Pane, PaneSource, SplitState } from '@shared/types'
import {
  shapeForCount,
  capacityFor,
  cellsFor,
  addPaneTransition,
  removePaneTransition,
  reindexBySpatialOrder,
  defaultRatiosFor,
  gridTemplate,
  findPaneForSource,
  makeRoomFrom,
  interpolateGridTemplate,
  parseTrackFractions,
  previewLayout,
  MAX_PANES,
  MIN_RATIO
} from '@renderer/lib/splitGeometry'

// Helpers ---------------------------------------------------------------------
const wsrc = (id: string): PaneSource => ({ kind: 'widget', widgetId: id })
const single = (paneId = 'p0', widgetId = 'w0'): SplitState => ({
  shape: 'single',
  panes: [{ id: paneId, cell: 'C0', source: wsrc(widgetId) }],
  ratios: {},
  activePaneId: paneId
})

/** Add n widget panes onto a single state; returns the final state + pane ids. */
function build(n: number): { state: SplitState; ids: string[] } {
  let state = single('p0', 'w0')
  const ids = ['p0']
  for (let i = 1; i < n; i++) {
    const pid = `p${i}`
    state = addPaneTransition(state, wsrc(`w${i}`), pid)
    ids.push(pid)
  }
  return { state, ids }
}

// shapeForCount / capacity / cells --------------------------------------------
describe('shape ↔ count', () => {
  it('maps counts to shapes', () => {
    expect(shapeForCount(1)).toBe('single')
    expect(shapeForCount(2)).toBe('halves')
    expect(shapeForCount(3)).toBe('left-2stack')
    expect(shapeForCount(4)).toBe('quad')
  })
  it('caps out-of-range counts', () => {
    expect(shapeForCount(0)).toBe('single')
    expect(shapeForCount(5)).toBe('quad')
    expect(shapeForCount(99)).toBe('quad')
  })
  it('capacity matches cell count for every shape', () => {
    for (const s of ['single', 'halves', 'left-2stack', 'quad'] as const) {
      expect(capacityFor(s)).toBe(cellsFor(s).length)
    }
  })
  it('cells are the locked slots', () => {
    expect(cellsFor('single')).toEqual(['C0'])
    expect(cellsFor('halves')).toEqual(['L', 'R'])
    expect(cellsFor('left-2stack')).toEqual(['L', 'R1', 'R2'])
    expect(cellsFor('quad')).toEqual(['Q1', 'Q2', 'Q3', 'Q4'])
  })
})

// Add progression 1→2→3→4 (the LOCKED transitions) ----------------------------
describe('addPaneTransition — locked progression', () => {
  it('single → halves: old pane to L, new to R', () => {
    const s = addPaneTransition(single('p0', 'w0'), wsrc('w1'), 'p1')
    expect(s.shape).toBe('halves')
    const byId = Object.fromEntries(s.panes.map((p) => [p.id, p.cell]))
    expect(byId).toEqual({ p0: 'L', p1: 'R' })
    expect(s.activePaneId).toBe('p1') // new pane becomes active
  })

  it('halves → left-2stack: L stays, old R→R1, new→R2', () => {
    let s = addPaneTransition(single('p0', 'w0'), wsrc('w1'), 'p1') // halves
    s = addPaneTransition(s, wsrc('w2'), 'p2') // left-2stack
    expect(s.shape).toBe('left-2stack')
    const byId = Object.fromEntries(s.panes.map((p) => [p.id, p.cell]))
    expect(byId).toEqual({ p0: 'L', p1: 'R1', p2: 'R2' })
  })

  it('left-2stack → quad: L→Q1, R1→Q2, R2→Q4, new→Q3', () => {
    const { state: s, ids } = build(4)
    expect(s.shape).toBe('quad')
    const byId = Object.fromEntries(s.panes.map((p) => [p.id, p.cell]))
    expect(byId).toEqual({ p0: 'Q1', p1: 'Q2', p2: 'Q4', p3: 'Q3' })
    expect(ids).toEqual(['p0', 'p1', 'p2', 'p3'])
  })

  it('never exceeds MAX_PANES — a 5th add is a no-op', () => {
    const { state: quad } = build(4)
    const s = addPaneTransition(quad, wsrc('w4'), 'p4')
    expect(s).toBe(quad) // unchanged reference
    expect(s.panes.length).toBe(MAX_PANES)
  })

  it('directional: dropping on L (left drag) puts NEW pane at L, existing slides to R', () => {
    const s = addPaneTransition(single('p0', 'w0'), wsrc('w1'), 'p1', 'L')
    expect(s.shape).toBe('halves')
    const byId = Object.fromEntries(s.panes.map((p) => [p.id, p.cell]))
    expect(byId).toEqual({ p1: 'L', p0: 'R' }) // new on left, existing on right
    expect(s.activePaneId).toBe('p1')
  })

  it('honors a valid targetCell when dropping', () => {
    // From halves, drop the 3rd pane explicitly into R2 (its canonical slot too).
    let s = addPaneTransition(single('p0', 'w0'), wsrc('w1'), 'p1') // halves
    s = addPaneTransition(s, wsrc('w2'), 'p2', 'R2')
    expect(s.panes.find((p) => p.id === 'p2')!.cell).toBe('R2')
  })

  it('falls back to canonical incoming when targetCell is occupied', () => {
    let s = addPaneTransition(single('p0', 'w0'), wsrc('w1'), 'p1') // halves: p0=L
    // Try to drop new pane onto L (occupied) → should land on canonical R1.
    s = addPaneTransition(s, wsrc('w2'), 'p2', 'L')
    const p2 = s.panes.find((p) => p.id === 'p2')!
    expect(p2.cell).toBe('R2') // canonical incoming for halves→left-2stack
  })

  it('all panes always sit on valid, unique cells of the shape', () => {
    for (let n = 1; n <= 4; n++) {
      const { state } = build(n)
      const cells = state.panes.map((p) => p.cell)
      const valid = cellsFor(state.shape)
      expect(new Set(cells).size).toBe(cells.length) // unique
      cells.forEach((c) => expect(valid).toContain(c)) // valid for shape
      expect(cells.length).toBe(n)
    }
  })
})

// Remove transitions ----------------------------------------------------------
describe('removePaneTransition', () => {
  it('quad → left-2stack when removing one of four', () => {
    const { state: quad } = build(4)
    const s = removePaneTransition(quad, 'p3') // remove the Q3 pane
    expect(s.shape).toBe('left-2stack')
    expect(s.panes.length).toBe(3)
    expect(new Set(s.panes.map((p) => p.cell))).toEqual(new Set(['L', 'R1', 'R2']))
  })

  it('removing the active pane reassigns active to a survivor', () => {
    const { state: quad } = build(4)
    const active = quad.activePaneId // p3
    const s = removePaneTransition(quad, active)
    expect(s.panes.some((p) => p.id === s.activePaneId)).toBe(true)
    expect(s.activePaneId).not.toBe(active)
  })

  it('removing a non-active pane keeps active unchanged', () => {
    const { state: quad } = build(4) // active = p3
    const s = removePaneTransition(quad, 'p0')
    expect(s.activePaneId).toBe('p3')
  })

  it('halves → single collapses the survivor to C0', () => {
    const s2 = addPaneTransition(single('p0', 'w0'), wsrc('w1'), 'p1') // halves
    const s = removePaneTransition(s2, 'p0')
    expect(s.shape).toBe('single')
    expect(s.panes).toHaveLength(1)
    expect(s.panes[0].cell).toBe('C0')
    expect(s.panes[0].id).toBe('p1')
  })

  it('removing an absent pane id is a no-op', () => {
    const s2 = addPaneTransition(single('p0', 'w0'), wsrc('w1'), 'p1')
    expect(removePaneTransition(s2, 'nope')).toBe(s2)
  })

  it('add-then-remove round-trips pane membership (not necessarily cells)', () => {
    const { state: three } = build(3)
    const grown = addPaneTransition(three, wsrc('w3'), 'p3') // quad
    const shrunk = removePaneTransition(grown, 'p3') // back to 3
    expect(shrunk.shape).toBe('left-2stack')
    expect(new Set(shrunk.panes.map((p) => p.id))).toEqual(new Set(['p0', 'p1', 'p2']))
  })
})

// reindexBySpatialOrder -------------------------------------------------------
describe('reindexBySpatialOrder', () => {
  it('assigns gap-free cells in spatial order regardless of input cells', () => {
    const panes: Pane[] = [
      { id: 'a', cell: 'Q4', source: wsrc('wa') },
      { id: 'b', cell: 'Q1', source: wsrc('wb') },
      { id: 'c', cell: 'Q3', source: wsrc('wc') }
    ]
    const out = reindexBySpatialOrder(panes, 'left-2stack')
    // Sorted by canonical rank: Q1(b) < Q3(c) < Q4(a) → L, R1, R2
    expect(out.map((p) => [p.id, p.cell])).toEqual([
      ['b', 'L'],
      ['c', 'R1'],
      ['a', 'R2']
    ])
  })
  it('truncates to shape capacity', () => {
    const panes: Pane[] = ['Q1', 'Q2', 'Q3', 'Q4'].map((c, i) => ({
      id: `p${i}`,
      cell: c as Pane['cell'],
      source: wsrc(`w${i}`)
    }))
    expect(reindexBySpatialOrder(panes, 'halves')).toHaveLength(2)
  })
})

// Ratios ----------------------------------------------------------------------
describe('defaultRatiosFor', () => {
  it('single has no dividers', () => {
    expect(defaultRatiosFor('single')).toEqual({})
  })
  it('provides x for halves, x+yRight for left-2stack, x+yQuad for quad', () => {
    expect(defaultRatiosFor('halves').x).toBeCloseTo(0.5)
    const l = defaultRatiosFor('left-2stack')
    expect(l.x).toBeCloseTo(0.6)
    expect(l.yRight).toBeCloseTo(0.5)
    const q = defaultRatiosFor('quad')
    expect(q.x).toBeCloseTo(0.5)
    expect(q.yQuad).toBeCloseTo(0.5)
  })
  it('clamps carried-over ratios to [MIN_RATIO, 1-MIN_RATIO]', () => {
    expect(defaultRatiosFor('halves', { x: 0.01 }).x).toBeCloseTo(MIN_RATIO)
    expect(defaultRatiosFor('halves', { x: 0.99 }).x).toBeCloseTo(1 - MIN_RATIO)
    expect(defaultRatiosFor('halves', { x: 0.42 }).x).toBeCloseTo(0.42)
  })
})

// gridTemplate ----------------------------------------------------------------
describe('gridTemplate', () => {
  it('single is one cell', () => {
    const g = gridTemplate('single', {})
    expect(g.areas).toBe('"C0"')
    expect(g.columns).toBe('100%')
  })
  it('halves splits columns by x', () => {
    const g = gridTemplate('halves', { x: 0.5 })
    expect(g.columns).toBe('50.0000% 50.0000%')
    expect(g.areas).toBe('"L R"')
  })
  it('left-2stack: big left column spans two rows', () => {
    const g = gridTemplate('left-2stack', { x: 0.6, yRight: 0.5 })
    expect(g.areas).toBe('"L R1" "L R2"')
    expect(g.columns).toBe('60.0000% 40.0000%')
  })
  it('quad is an even 2×2 area map', () => {
    const g = gridTemplate('quad', { x: 0.5, yQuad: 0.5 })
    expect(g.areas).toBe('"Q1 Q2" "Q3 Q4"')
    expect(g.cellArea).toEqual({ Q1: 'Q1', Q2: 'Q2', Q3: 'Q3', Q4: 'Q4' })
  })
  it('uses default ratios when fields are missing', () => {
    const g = gridTemplate('halves', {})
    expect(g.columns).toBe('50.0000% 50.0000%')
  })
})

// findPaneForSource (dup guard) -----------------------------------------------
describe('findPaneForSource', () => {
  it('finds an existing widget pane by widgetId', () => {
    const { state } = build(3) // w0,w1,w2
    expect(findPaneForSource(state, wsrc('w1'))).toBe('p1')
    expect(findPaneForSource(state, wsrc('w9'))).toBeNull()
  })
  it('matches chrome tabs by tab name', () => {
    let s = single('p0', 'w0')
    s = addPaneTransition(s, { kind: 'chrome', tab: 'chat' }, 'p1')
    expect(findPaneForSource(s, { kind: 'chrome', tab: 'chat' })).toBe('p1')
    expect(findPaneForSource(s, { kind: 'chrome', tab: 'add' })).toBeNull()
  })
})

// ── Make-room reflow helpers (redesign) ──────────────────────────────────────
const approxTracks = (s: string): number[] =>
  parseTrackFractions(s).map((f) => Math.round(f * 10000) / 10000)

describe('parseTrackFractions', () => {
  it('parses "%"-tracks to fractions', () => {
    expect(parseTrackFractions('60.0000% 40.0000%')).toEqual([0.6, 0.4])
    expect(parseTrackFractions('100%')).toEqual([1])
  })
})

describe('makeRoomFrom — incoming cell collapsed to a seam', () => {
  it('single→halves: right column collapsed (existing content fills left)', () => {
    const from = makeRoomFrom('halves', {})
    const [c0, c1] = approxTracks(from.columns)
    expect(c0).toBeGreaterThan(0.999) // left ≈ full
    expect(c1).toBeLessThan(0.001) // right ≈ seam
    expect(from.areas).toBe('"L R"') // target areas already in place
  })
  it('single→halves dragged to the LEFT: the left column (where the well opens) is the seam', () => {
    // previewLayout(…, 'left') puts the well in L and slides the pane to R, so the
    // pane must start full-width in R and the well grow out of a seam on the left.
    const from = makeRoomFrom('halves', {}, 'L')
    const [c0, c1] = approxTracks(from.columns)
    expect(c0).toBeLessThan(0.001)
    expect(c1).toBeGreaterThan(0.999)
    expect(makeRoomFrom('halves', {}, 'R').columns).toBe(makeRoomFrom('halves', {}).columns)
  })
  it('halves→left-2stack: right column bottom row collapsed', () => {
    const from = makeRoomFrom('left-2stack', {})
    const [r0, r1] = approxTracks(from.rows)
    expect(r0).toBeGreaterThan(0.999)
    expect(r1).toBeLessThan(0.001)
    // Columns keep the target's L width (not collapsed).
    expect(from.columns).toBe(gridTemplate('left-2stack', {}).columns)
    expect(from.areas).toBe('"L R1" "L R2"')
  })
  it('left-2stack→quad: bottom row collapsed (top row holds existing panes)', () => {
    const from = makeRoomFrom('quad', {})
    const [r0, r1] = approxTracks(from.rows)
    expect(r0).toBeGreaterThan(0.999)
    expect(r1).toBeLessThan(0.001)
    expect(from.areas).toBe('"Q1 Q2" "Q3 Q4"')
  })
  it('single shape has no reflow (returns target unchanged)', () => {
    const from = makeRoomFrom('single', {})
    expect(from.columns).toBe('100%')
  })
})

describe('interpolateGridTemplate', () => {
  it('t=0 returns the from tracks, t=1 returns the to tracks', () => {
    const from = makeRoomFrom('halves', {})
    const to = gridTemplate('halves', {})
    const at0 = interpolateGridTemplate(from, to, 0)
    const at1 = interpolateGridTemplate(from, to, 1)
    expect(approxTracks(at0.columns)).toEqual(approxTracks(from.columns))
    expect(approxTracks(at1.columns)).toEqual(approxTracks(to.columns))
  })
  it('t=0.5 is the midpoint of each track', () => {
    const from = makeRoomFrom('halves', {}) // ≈ [1, 0]
    const to = gridTemplate('halves', {}) // [0.5, 0.5]
    const mid = interpolateGridTemplate(from, to, 0.5)
    const [c0, c1] = approxTracks(mid.columns)
    expect(c0).toBeCloseTo(0.75, 3) // (1 + 0.5)/2
    expect(c1).toBeCloseTo(0.25, 3) // (0 + 0.5)/2
  })
  it('clamps t outside [0,1]', () => {
    const from = makeRoomFrom('halves', {})
    const to = gridTemplate('halves', {})
    expect(interpolateGridTemplate(from, to, -1).columns).toBe(
      interpolateGridTemplate(from, to, 0).columns
    )
    expect(interpolateGridTemplate(from, to, 2).columns).toBe(
      interpolateGridTemplate(from, to, 1).columns
    )
  })
  it('the reflow grows the well monotonically (incoming track increases with t)', () => {
    const from = makeRoomFrom('halves', {})
    const to = gridTemplate('halves', {})
    const incoming = (t: number): number => approxTracks(interpolateGridTemplate(from, to, t).columns)[1]
    expect(incoming(0)).toBeLessThan(incoming(0.5))
    expect(incoming(0.5)).toBeLessThan(incoming(1))
  })
})

describe('previewLayout — make-room preview (remapped panes + wells)', () => {
  it('1 pane → previews halves: pane0 remapped to L, R is the well (default/right)', () => {
    const p = previewLayout(single('p0', 'w0'))
    expect(p.shape).toBe('halves')
    expect(p.panes.map((x) => [x.id, x.cell])).toEqual([['p0', 'L']])
    expect(p.wells).toEqual(['R'])
  })
  it('directional: dragging LEFT slides pane0 to R and opens the well on L', () => {
    const p = previewLayout(single('p0', 'w0'), 'left')
    expect(p.shape).toBe('halves')
    expect(p.panes.map((x) => [x.id, x.cell])).toEqual([['p0', 'R']])
    expect(p.wells).toEqual(['L'])
  })
  it('directional side only affects the 1→2 halves split (2→3 unchanged)', () => {
    const { state } = build(2)
    expect(previewLayout(state, 'left').wells).toEqual(['R2'])
    expect(previewLayout(state, 'right').wells).toEqual(['R2'])
  })
  it('2 panes → previews left-2stack: existing to L+R1, well at R2', () => {
    const { state } = build(2)
    const p = previewLayout(state)
    expect(p.shape).toBe('left-2stack')
    expect(new Set(p.panes.map((x) => x.cell))).toEqual(new Set(['L', 'R1']))
    expect(p.wells).toEqual(['R2'])
  })
  it('3 panes → previews quad: well at Q3', () => {
    const { state } = build(3)
    const p = previewLayout(state)
    expect(p.shape).toBe('quad')
    expect(p.wells).toEqual(['Q3'])
    expect(p.panes).toHaveLength(3)
  })
  it('4 panes (full) → no well, shape unchanged', () => {
    const { state } = build(4)
    const p = previewLayout(state)
    expect(p.shape).toBe('quad')
    expect(p.wells).toEqual([])
  })
})

describe('fitsPaneFor — sticky-pane fix classification', () => {
  it("centers short/atmospheric widgets", async () => {
    const { fitsPaneFor } = await import('@renderer/lib/widgetCatalog')
    // card/shape are widget kinds from Caleb's branch not yet on this line; they
    // arrive in a later integration slice with their catalog entries.
    for (const k of ['sticky', 'note', 'field', 'timer', 'color', 'calculator', 'task-link'] as const) {
      expect(fitsPaneFor(k)).toBe('center')
    }
  })
  it('fills scroll/editor widgets', async () => {
    const { fitsPaneFor } = await import('@renderer/lib/widgetCatalog')
    for (const k of ['webview', 'table', 'page', 'doc', 'markdown', 'diagram', 'scratchpad'] as const) {
      expect(fitsPaneFor(k)).toBe('fill')
    }
  })
})
