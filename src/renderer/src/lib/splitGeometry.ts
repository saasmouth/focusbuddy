// Focus Mode split/fill view — deterministic geometry core.
//
// Spec: docs/FOCUS-SPLIT-VIEW-SPEC.md §4. Pure, framework-free functions that own
// EVERYTHING about how panes tile: which shape a pane count maps to, which cells
// a shape has, how adding/removing a pane remaps cells, and how ratios become a
// CSS grid template. Kept side-effect-free so it's exhaustively unit-tested
// (tests/unit/splitGeometry.test.ts) — the tiling must be deterministic, not
// emergent from component code.

import type { Pane, PaneCell, PaneSource, SplitRatios, SplitShape, SplitState } from '@shared/types'

// The min fraction a pane may shrink to when a divider is dragged. Keeps any
// pane from collapsing to nothing (P3 uses this to clamp; exported so the
// divider and geometry agree on the floor).
export const MIN_RATIO = 0.15

// ── Shape ↔ count ────────────────────────────────────────────────────────────

/** The shape a given pane count renders as. 1→single … 4→quad. */
export function shapeForCount(n: number): SplitShape {
  switch (n) {
    case 1:
      return 'single'
    case 2:
      return 'halves'
    case 3:
      return 'left-2stack'
    case 4:
      return 'quad'
    default:
      // Below 1 is meaningless; above 4 is capped (quad is the max in v1).
      return n <= 1 ? 'single' : 'quad'
  }
}

/** How many panes a shape holds. */
export function capacityFor(shape: SplitShape): number {
  switch (shape) {
    case 'single':
      return 1
    case 'halves':
      return 2
    case 'left-2stack':
      return 3
    case 'quad':
      return 4
  }
}

/** The ordered cell slots for a shape (spatial reading order). */
export function cellsFor(shape: SplitShape): PaneCell[] {
  switch (shape) {
    case 'single':
      return ['C0']
    case 'halves':
      return ['L', 'R']
    case 'left-2stack':
      return ['L', 'R1', 'R2']
    case 'quad':
      return ['Q1', 'Q2', 'Q3', 'Q4']
  }
}

export const MAX_PANES = 4

// ── Add / remove transitions ─────────────────────────────────────────────────
//
// The cell REMAP tables. When pane count changes, existing panes must move to the
// slots of the NEW shape deterministically. These maps encode the LOCKED
// progression from the spec (§4) and are pinned by unit tests so a refactor can't
// silently reshuffle a user's panes.
//
// Add direction (n → n+1): map each old cell to its new cell; the NEW pane takes
// the remaining ("incoming") cell.
const ADD_REMAP: Record<string, { remap: Partial<Record<PaneCell, PaneCell>>; incoming: PaneCell }> = {
  // single → halves: the lone pane becomes Left; new pane is Right.
  'single->halves': { remap: { C0: 'L' }, incoming: 'R' },
  // halves → left-2stack: Left stays Left; the old Right becomes top-right (R1);
  // new pane is bottom-right (R2).
  'halves->left-2stack': { remap: { L: 'L', R: 'R1' }, incoming: 'R2' },
  // left-2stack → quad: L→Q1 (top-left), R1→Q2 (top-right), R2→Q4 (bottom-right);
  // new pane fills Q3 (bottom-left).
  'left-2stack->quad': { remap: { L: 'Q1', R1: 'Q2', R2: 'Q4' }, incoming: 'Q3' }
}

// Remove direction (n → n-1): map each surviving old cell to a new cell. The
// removed pane is dropped first; the rest collapse into the smaller shape. This
// is the inverse of ADD_REMAP for the common path, but expressed explicitly per
// surviving-cell so removing ANY cell (not just the last-added) is well-defined.
const REMOVE_REMAP: Record<string, Partial<Record<PaneCell, PaneCell>>> = {
  // halves → single: whichever pane survives becomes the single C0.
  'halves->single': { L: 'C0', R: 'C0' },
  // left-2stack → halves: L stays Left; whichever right pane survives becomes Right.
  'left-2stack->halves': { L: 'L', R1: 'R', R2: 'R' },
  // quad → left-2stack: Q1→L (promote top-left to the big left); Q2→R1, Q3→R1,
  // Q4→R2. If the survivor set leaves both right slots, order by cell (Q2<Q3<Q4)
  // fills R1 then R2 — handled by reindexBySpatialOrder below, so this map is a
  // hint; the reindex guarantees a valid, gap-free assignment.
  'quad->left-2stack': { Q1: 'L', Q2: 'R1', Q3: 'R1', Q4: 'R2' }
}

/**
 * Add a pane carrying `source` into `targetCell` of the NEXT shape. Returns a new
 * SplitState with existing panes remapped and the new pane placed. If already at
 * MAX_PANES, returns the state unchanged (caller should treat as "full").
 *
 * `targetCell` is the cell the user dropped on in the target shape's ghost grid.
 * When omitted, the new pane takes the shape's canonical `incoming` slot.
 */
export function addPaneTransition(
  state: SplitState,
  source: PaneSource,
  newPaneId: string,
  targetCell?: PaneCell
): SplitState {
  const from = state.shape
  const count = state.panes.length
  if (count >= MAX_PANES) return state
  const to = shapeForCount(count + 1)
  const key = `${from}->${to}`
  const table = ADD_REMAP[key]
  if (!table) return state // no defined transition (shouldn't happen for 1→4)

  // Directional 1→2 (scale-to-side): dropping on the LEFT cell means the new pane
  // takes L and the existing pane slides to R — matching the make-room preview.
  if (from === 'single' && to === 'halves' && targetCell === 'L') {
    const existing = state.panes.map((p) => ({ ...p, cell: 'R' as PaneCell }))
    const newPane: Pane = { id: newPaneId, cell: 'L', source }
    return {
      shape: 'halves',
      panes: reindexBySpatialOrder([newPane, ...existing], 'halves'),
      ratios: defaultRatiosFor('halves', state.ratios),
      activePaneId: newPaneId
    }
  }

  // Remap existing panes to the new shape's slots.
  const remapped: Pane[] = state.panes.map((p) => ({
    ...p,
    cell: table.remap[p.cell] ?? p.cell
  }))

  // The incoming slot is either the caller's choice or the canonical one. If the
  // caller's targetCell is already occupied post-remap, fall back to canonical.
  const occupied = new Set(remapped.map((p) => p.cell))
  const incoming = targetCell && !occupied.has(targetCell) ? targetCell : table.incoming

  const newPane: Pane = { id: newPaneId, cell: incoming, source }
  const panes = reindexBySpatialOrder([...remapped, newPane], to)
  return {
    shape: to,
    panes,
    ratios: defaultRatiosFor(to, state.ratios),
    activePaneId: newPaneId // newly added pane becomes active
  }
}

/**
 * Remove the pane with `paneId`. Returns a new SplitState collapsed into the
 * smaller shape, with the active pane reassigned if the removed one was active.
 * Removing the last remaining pane returns an empty single-shape state (caller —
 * WidgetFocusMode — treats 0 panes as "exit split / back to plain single view").
 */
export function removePaneTransition(state: SplitState, paneId: string): SplitState {
  const survivors = state.panes.filter((p) => p.id !== paneId)
  if (survivors.length === state.panes.length) return state // paneId not present
  const to = shapeForCount(Math.max(1, survivors.length))
  const key = `${state.shape}->${to}`
  const table = REMOVE_REMAP[key]

  const remapped: Pane[] = survivors.map((p) => ({
    ...p,
    cell: (table?.[p.cell] as PaneCell | undefined) ?? p.cell
  }))
  const panes = reindexBySpatialOrder(remapped, to)

  const activeStillHere = panes.some((p) => p.id === state.activePaneId)
  return {
    shape: to,
    panes,
    ratios: defaultRatiosFor(to, state.ratios),
    activePaneId: activeStillHere ? state.activePaneId : (panes[0]?.id ?? '')
  }
}

/**
 * Force every pane onto a valid, gap-free set of cells for `shape`, preserving
 * spatial reading order. This makes add/remove robust even when a remap hint is
 * ambiguous (e.g. removing an interior quad pane): we sort panes by their current
 * cell's canonical order, then assign the shape's cells in sequence.
 */
export function reindexBySpatialOrder(panes: Pane[], shape: SplitShape): Pane[] {
  const order = cellsFor(shape)
  const rank = (c: PaneCell): number => {
    const i = order.indexOf(c)
    if (i >= 0) return i
    // A cell not in the target shape (came from a bigger shape) — rank it by its
    // position in the SUPERSET ordering so relative order is stable.
    return CANONICAL_CELL_RANK[c] ?? 99
  }
  const sorted = [...panes].sort((a, b) => rank(a.cell) - rank(b.cell))
  return sorted.slice(0, order.length).map((p, i) => ({ ...p, cell: order[i] }))
}

// A stable global ordering across ALL cells, used only to keep relative order
// deterministic when cells from a larger shape are collapsed into a smaller one.
const CANONICAL_CELL_RANK: Record<PaneCell, number> = {
  C0: 0,
  L: 1,
  R: 2,
  R1: 3,
  R2: 4,
  Q1: 5,
  Q2: 6,
  Q3: 7,
  Q4: 8
}

// ── Ratios & CSS grid ────────────────────────────────────────────────────────

/** Sensible default divider positions for a shape, preserving any compatible
 *  existing ratios (so resizing then adding a pane doesn't jump). */
export function defaultRatiosFor(shape: SplitShape, prev?: SplitRatios): SplitRatios {
  const clamp = (v: number | undefined, d: number): number =>
    v == null ? d : Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, v))
  switch (shape) {
    case 'single':
      return {}
    case 'halves':
      return { x: clamp(prev?.x, 0.5) }
    case 'left-2stack':
      return { x: clamp(prev?.x, 0.6), yRight: clamp(prev?.yRight, 0.5) }
    case 'quad':
      return { x: clamp(prev?.x, 0.5), yQuad: clamp(prev?.yQuad, 0.5) }
  }
}

/** CSS grid definition for a shape+ratios. Returns the template strings and a
 *  per-cell `gridArea` map so SplitGrid can place panes declaratively. */
export interface GridTemplate {
  columns: string
  rows: string
  areas: string // grid-template-areas string
  cellArea: Record<PaneCell, string> // cell → grid-area name
}

export function gridTemplate(shape: SplitShape, ratios: SplitRatios): GridTemplate {
  const r = defaultRatiosFor(shape, ratios)
  const pct = (v: number): string => `${(v * 100).toFixed(4)}%`
  const rest = (v: number): string => `${((1 - v) * 100).toFixed(4)}%`
  switch (shape) {
    case 'single':
      return {
        columns: '100%',
        rows: '100%',
        areas: '"C0"',
        cellArea: { C0: 'C0' } as Record<PaneCell, string>
      }
    case 'halves':
      return {
        columns: `${pct(r.x!)} ${rest(r.x!)}`,
        rows: '100%',
        areas: '"L R"',
        cellArea: { L: 'L', R: 'R' } as Record<PaneCell, string>
      }
    case 'left-2stack':
      // Two columns; the right column is split into two rows by yRight.
      return {
        columns: `${pct(r.x!)} ${rest(r.x!)}`,
        rows: `${pct(r.yRight!)} ${rest(r.yRight!)}`,
        areas: '"L R1" "L R2"',
        cellArea: { L: 'L', R1: 'R1', R2: 'R2' } as Record<PaneCell, string>
      }
    case 'quad':
      return {
        columns: `${pct(r.x!)} ${rest(r.x!)}`,
        rows: `${pct(r.yQuad!)} ${rest(r.yQuad!)}`,
        areas: '"Q1 Q2" "Q3 Q4"',
        cellArea: { Q1: 'Q1', Q2: 'Q2', Q3: 'Q3', Q4: 'Q4' } as Record<PaneCell, string>
      }
  }
}

// ── Make-room reflow (redesign — docs/FOCUS-SPLIT-REDESIGN-SPEC.md) ───────────
//
// The "make room" drag animates the CSS grid TRACKS from a start template (where
// the incoming cell is collapsed to ~0 width/height, so existing content is at
// full size) to the target template (the real next-shape layout). Interpolating
// the tracks by a spring scalar t∈[0,1] makes the current content physically
// shrink into its destination cell while an empty translucent drop-well grows out
// of the zero-width seam. Pure + unit-tested; SplitGrid drives the style each frame.

// A hair, not literally 0, so the browser still lays out two tracks (a 0% track
// can collapse the grid line and make the seam pop rather than grow smoothly).
const SEAM = 0.0001

/** Parse a grid-template track string ("60.0000% 40.0000%" | "100%") into the
 *  numeric fractions of each track. */
export function parseTrackFractions(template: string): number[] {
  return template
    .trim()
    .split(/\s+/)
    .map((p) => (p.endsWith('%') ? parseFloat(p) / 100 : 1))
}

/** Serialize track fractions back to a "%"-separated template string. */
function serializeTracks(fracs: number[]): string {
  return fracs.map((f) => `${(f * 100).toFixed(4)}%`).join(' ')
}

/**
 * The START template for a make-room reflow into `nextShape`: the next shape's
 * AREAS (so the grid structure is already the target), but with the INCOMING
 * cell's column/row track(s) collapsed to a seam so the existing content still
 * fills the space. Animating from here to gridTemplate(nextShape) grows the well.
 *
 * The incoming cell per transition (matches ADD_REMAP.incoming):
 *   single→halves:      R   (right column collapses → 100% / seam)
 *   halves→left-2stack: R2  (right column's bottom row collapses → rows 100%/seam)
 *   left-2stack→quad:   Q3  (bottom row's left; the whole bottom row collapses so
 *                            the top row holds the 3 existing panes at full height)
 */
export function makeRoomFrom(nextShape: SplitShape, ratios: SplitRatios, incoming?: PaneCell): GridTemplate {
  const target = gridTemplate(nextShape, ratios)
  switch (nextShape) {
    case 'halves':
      // Incoming R is the 2nd column → collapse col 1, give col 0 the rest.
      // Dragged to the LEFT (previewLayout(…, 'left')) the well is L and the pane
      // slides to R: collapse col 0 instead. (target.rows is "100%" — unchanged.)
      return { ...target, columns: serializeTracks(incoming === 'L' ? [SEAM, 1 - SEAM] : [1 - SEAM, SEAM]) }
    case 'left-2stack':
      // Incoming R2 is the bottom row of the right column → collapse row 1.
      // Columns keep the target's L width (unchanged); only the rows animate, so
      // R1 fills the right column until the bottom well grows.
      return { ...target, rows: serializeTracks([1 - SEAM, SEAM]) }
    case 'quad':
      // Incoming Q3 lives in the bottom row → collapse the bottom row so the top
      // row (Q1,Q2) holds the existing panes; L(→Q1)+R1(→Q2) sit across the top.
      return { ...target, rows: serializeTracks([1 - SEAM, SEAM]) }
    default:
      // single (or unknown) has no reflow — return the target unchanged.
      return target
  }
}

/**
 * The layout previewed DURING a make-room drag: the existing panes remapped onto
 * the next shape's cells, plus the cell(s) that will be empty drop-wells. Pure so
 * SplitGrid can render it and the hit-test can target it identically (preview ===
 * commit). At MAX_PANES the "preview" is the current shape (drop = route to the
 * canonical incoming cell; no new cell opens), so wells is empty.
 */
export interface PreviewLayout {
  shape: SplitShape
  panes: Pane[] // existing panes, remapped to the preview shape's cells
  wells: PaneCell[] // cells that render as empty drop-wells
}

export function previewLayout(state: SplitState, side?: 'left' | 'right'): PreviewLayout {
  const n = state.panes.length
  if (n === 0) {
    // Nothing yet — the whole single cell is a well.
    return { shape: 'single', panes: [], wells: ['C0'] }
  }
  if (n >= MAX_PANES) {
    // Full: no new cell. Keep the current layout; drops route to canonical incoming.
    return { shape: state.shape, panes: state.panes, wells: [] }
  }
  const from = state.shape
  const to = shapeForCount(n + 1)
  // Directional 1→2 (the halves split): the existing pane slides to the side
  // OPPOSITE the drag, and the well opens on the side you drag toward — matching
  // the Mission-Control "scale-to-side" feel. Only the halves case is directional;
  // 2→3 and 3→4 have fixed geometry.
  if (from === 'single' && to === 'halves' && side === 'left') {
    return {
      shape: 'halves',
      panes: state.panes.map((p) => ({ ...p, cell: 'R' as PaneCell })),
      wells: ['L']
    }
  }
  const table = ADD_REMAP[`${from}->${to}`]
  if (!table) return { shape: from, panes: state.panes, wells: [] }
  const panes = state.panes.map((p) => ({ ...p, cell: table.remap[p.cell] ?? p.cell }))
  return { shape: to, panes, wells: [table.incoming] }
}

/**
 * Interpolate two grid templates by t∈[0,1]. Only the track SIZES lerp; the
 * grid-template-areas string is NOT interpolated (it can't tween) and is taken
 * from `to` — callers pass a `from` built by makeRoomFrom(), which already uses
 * the target areas, so the structure is constant across the whole reflow.
 */
export function interpolateGridTemplate(
  from: GridTemplate,
  to: GridTemplate,
  t: number
): { columns: string; rows: string } {
  const clampT = Math.min(1, Math.max(0, t))
  const lerpTracks = (a: string, b: string): string => {
    const fa = parseTrackFractions(a)
    const fb = parseTrackFractions(b)
    // If track counts differ (shouldn't, since from uses target areas), fall back
    // to `to` so we never emit a malformed template.
    if (fa.length !== fb.length) return b
    return serializeTracks(fa.map((v, i) => v + (fb[i] - v) * clampT))
  }
  return {
    columns: lerpTracks(from.columns, to.columns),
    rows: lerpTracks(from.rows, to.rows)
  }
}

// ── Helpers for the store / drop logic ───────────────────────────────────────

/** Does this source already occupy a pane? (widget dup guard — spec §9.1: a
 *  widget already shown is MOVED, not duplicated.) Returns the pane id if so. */
export function findPaneForSource(state: SplitState, source: PaneSource): string | null {
  const same = (a: PaneSource, b: PaneSource): boolean => {
    if (a.kind !== b.kind) return false
    if (a.kind === 'widget' && b.kind === 'widget') return a.widgetId === b.widgetId
    if (a.kind === 'chrome' && b.kind === 'chrome') return a.tab === b.tab
    if (a.kind === 'meet' && b.kind === 'meet') return a.roomId === b.roomId
    return false
  }
  return state.panes.find((p) => same(p.source, source))?.id ?? null
}
