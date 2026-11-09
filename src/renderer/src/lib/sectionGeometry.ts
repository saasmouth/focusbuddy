import type { SectionLayout, Widget } from '@shared/types'
import { WIDGET_START_SIZES } from '@shared/widgetStartSizes'

export const SECTION_PADDING = 28
export const SECTION_MIN_W = 240
export const SECTION_MIN_H = 140
export const SECTION_GAP = 14
export const ICON_TILE = 86
export const LIST_ROW_H = 44

export interface SectionFrame {
  width: number
  height: number
  contentOriginX: number
  contentOriginY: number
}

export interface LayoutCell {
  x: number
  y: number
  width: number
  height: number
}

export function effectiveLayout(layout: SectionLayout | null | undefined): SectionLayout {
  return layout ?? 'free'
}

/**
 * Compute the per-child display cell for the given layout.
 * In 'free' mode the cell is just the child's stored x/y/w/h.
 * In other modes the cell is computed; child x/y are NOT used for placement.
 */
export function computeLayoutCells(
  layout: SectionLayout,
  children: Widget[],
  contentWidth: number
): LayoutCell[] {
  if (children.length === 0) return []

  if (layout === 'free') {
    return children.map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height }))
  }

  if (layout === 'stacks') {
    const OFFSET = 22
    return children.map((c, i) => ({
      x: i * OFFSET,
      y: i * OFFSET,
      width: c.width,
      height: c.height
    }))
  }

  if (layout === 'grid') {
    const cellW = Math.max(...children.map((c) => c.width))
    const cellH = Math.max(...children.map((c) => c.height))
    // Aim for a square-ish tile grid: cols ≈ ceil(sqrt(N)), capped at 4 to keep
    // sections from becoming absurdly wide. Frame width adapts to actual cells used.
    const idealCols = Math.ceil(Math.sqrt(children.length))
    const cols = Math.max(1, Math.min(children.length, idealCols, 4))
    return children.map((_, i) => ({
      x: (i % cols) * (cellW + SECTION_GAP),
      y: Math.floor(i / cols) * (cellH + SECTION_GAP),
      width: cellW,
      height: cellH
    }))
  }

  if (layout === 'icons') {
    const cols = Math.max(
      1,
      Math.floor((contentWidth + SECTION_GAP) / (ICON_TILE + SECTION_GAP))
    )
    return children.map((_, i) => ({
      x: (i % cols) * (ICON_TILE + SECTION_GAP),
      y: Math.floor(i / cols) * (ICON_TILE + SECTION_GAP),
      width: ICON_TILE,
      height: ICON_TILE
    }))
  }

  // list
  return children.map((_, i) => ({
    x: 0,
    y: i * (LIST_ROW_H + 6),
    width: contentWidth,
    height: LIST_ROW_H
  }))
}

/**
 * The frame of a section on a desk. A new one stands empty at its starting size,
 * with room for two small work widgets side by side, until something goes in it.
 * After that its frame comes from what it holds. A section that was already
 * empty before the standard is not at that size, and stays as small as it was.
 */
export function sectionFrameOf(
  section: Pick<Widget, 'width' | 'height' | 'layout'>,
  children: Widget[],
  layout: SectionLayout = effectiveLayout(section.layout)
): SectionFrame {
  const start = WIDGET_START_SIZES.section
  if (children.length === 0 && section.width === start.width && section.height === start.height) {
    return {
      width: start.width,
      height: start.height,
      contentOriginX: SECTION_PADDING,
      contentOriginY: SECTION_PADDING
    }
  }
  return computeSectionFrame(children, layout)
}

export function computeSectionFrame(
  children: Widget[],
  layout: SectionLayout = 'free',
  preferredContentW?: number
): SectionFrame {
  if (children.length === 0) {
    return {
      width: SECTION_MIN_W,
      height: SECTION_MIN_H,
      contentOriginX: SECTION_PADDING,
      contentOriginY: SECTION_PADDING
    }
  }

  // First compute cells using a conservative content width; if grid/icons need cols,
  // they'll use this. Iterate once is enough.
  const contentW = preferredContentW ?? Math.max(SECTION_MIN_W - 2 * SECTION_PADDING, 320)
  const cells = computeLayoutCells(layout, children, contentW)
  const maxX = Math.max(...cells.map((c) => c.x + c.width))
  const maxY = Math.max(...cells.map((c) => c.y + c.height))
  return {
    width: Math.max(SECTION_MIN_W, maxX + 2 * SECTION_PADDING),
    height: Math.max(SECTION_MIN_H, maxY + 2 * SECTION_PADDING),
    contentOriginX: SECTION_PADDING,
    contentOriginY: SECTION_PADDING
  }
}

/**
 * Find a non-overlapping position near `desired` within an existing set of children.
 *
 * Strategy:
 * 1. If the requested rect is clear, keep it.
 * 2. For every widget the drop overlaps, propose 4 cardinal "slide" slots
 *    (right of it, left of it, above it, below it). Take the candidate with
 *    the shortest displacement from the original drop point.
 * 3. If nothing in step 2 is clear (the drop landed in a tight cluster),
 *    spiral outward from the drop point in 8 directions until a free slot
 *    appears.
 * 4. Last resort: stack just below all existing items, preserving the
 *    requested X so the result stays near where the user aimed — never
 *    snap to x=0 (that was the old behaviour that produced the "everything
 *    piles at the center" bug).
 */
export function findNonOverlapPosition(
  desired: { x: number; y: number; width: number; height: number },
  existing: Widget[],
  gap = SECTION_GAP
): { x: number; y: number } {
  type Rect = { x: number; y: number; width: number; height: number }
  const overlaps = (a: Rect, b: Rect): boolean =>
    !(
      a.x + a.width + gap <= b.x ||
      a.x >= b.x + b.width + gap ||
      a.y + a.height + gap <= b.y ||
      a.y >= b.y + b.height + gap
    )
  const isClear = (pos: Rect): boolean => existing.every((e) => !overlaps(pos, e))

  // The canvas is an infinite world — negative coordinates are legitimate
  // (they represent space "above" or "left of" the origin once the user
  // has panned). Clamping to (0, 0) caused a clear free-space drop at e.g.
  // canvas-coord (-30, 400) to jump to (0, 400) — which fired the "moved"
  // path and yanked the camera. Honour the user's intended position.
  if (isClear(desired)) return { x: desired.x, y: desired.y }

  // Step 2 — collect every cardinal slot adjacent to a colliding widget and
  // pick the one closest to the actual drop point. We try all four sides of
  // every collider, not just right + below.
  type Candidate = { x: number; y: number; dist: number }
  const candidates: Candidate[] = []
  for (const e of existing) {
    if (!overlaps(desired, e)) continue
    const slots: Array<{ x: number; y: number }> = [
      { x: e.x + e.width + gap, y: desired.y },
      { x: e.x - desired.width - gap, y: desired.y },
      { x: desired.x, y: e.y + e.height + gap },
      { x: desired.x, y: e.y - desired.height - gap }
    ]
    for (const s of slots) {
      const probe: Rect = { x: s.x, y: s.y, width: desired.width, height: desired.height }
      if (!isClear(probe)) continue
      const dx = s.x - desired.x
      const dy = s.y - desired.y
      candidates.push({ x: s.x, y: s.y, dist: Math.hypot(dx, dy) })
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => a.dist - b.dist)
    const best = candidates[0]
    return { x: best.x, y: best.y }
  }

  // Step 3 — spiral outward from the drop. Step size scales with the widget
  // so we don't waste cycles probing single pixels.
  const stepX = Math.max(48, Math.round(desired.width / 2))
  const stepY = Math.max(48, Math.round(desired.height / 2))
  const directions: Array<[number, number]> = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1]
  ]
  for (let ring = 1; ring <= 12; ring++) {
    for (const [ox, oy] of directions) {
      const probe: Rect = {
        x: desired.x + ox * stepX * ring,
        y: desired.y + oy * stepY * ring,
        width: desired.width,
        height: desired.height
      }
      if (isClear(probe)) return { x: probe.x, y: probe.y }
    }
  }

  // Step 4 — stack below everything but keep the user's intended X.
  const maxBottom = Math.max(...existing.map((e) => e.y + e.height), 0)
  return { x: desired.x, y: maxBottom + gap }
}

// A top-level object the desk drag can push out of the way. Minimal shape so
// callers can build these from a Widget or a computed section frame.
export interface Placeable {
  id: string
  x: number
  y: number
  width: number
  height: number
}

// Drag priority: the widget the user is moving stays exactly where they dropped
// it (the "anchor"), and any top-level widgets it now overlaps flow OUT of its
// way to the nearest clear spot, cascading so pushed widgets never end up on top
// of each other or of the anchor. This is the inverse of findNonOverlapPosition,
// which relocates the DROPPED widget instead — the wrong priority once the user
// has deliberately placed something. `blockers` (e.g. section frames) are treated
// as immovable: pushed widgets avoid them, but they never move. Nearest widgets
// resolve first so the closest thing moves the least. Returns only the widgets
// that actually moved, mapped to their new position.
export function resolvePushFromAnchor(
  anchor: { x: number; y: number; width: number; height: number },
  movable: Placeable[],
  blockers: Array<{ x: number; y: number; width: number; height: number }> = [],
  gap = SECTION_GAP,
  // 'horizontal' (default) slides impacted widgets left/right to keep the same
  // reading row, so a dragged widget "parts" its neighbours sideways (N4 spec).
  // 'nearest' finds the closest clear spot in any direction.
  axis: 'horizontal' | 'nearest' = 'horizontal'
): Map<string, { x: number; y: number }> {
  type Rect = { x: number; y: number; width: number; height: number }
  const overlaps = (a: Rect, b: Rect): boolean =>
    !(
      a.x + a.width + gap <= b.x ||
      a.x >= b.x + b.width + gap ||
      a.y + a.height + gap <= b.y ||
      a.y >= b.y + b.height + gap
    )
  const cx = (r: Rect): number => r.x + r.width / 2
  const cy = (r: Rect): number => r.y + r.height / 2
  const order = [...movable].sort(
    (p, q) => Math.hypot(cx(p) - cx(anchor), cy(p) - cy(anchor)) - Math.hypot(cx(q) - cx(anchor), cy(q) - cy(anchor))
  )
  const fixed: Rect[] = [anchor, ...blockers]
  const clearOf = (r: Rect): boolean => fixed.every((f) => !overlaps(r, f))

  // Slide a rect horizontally (y fixed) past every obstacle it hits, moving in
  // the preferred direction until clear. Monotonic + guarded, so it terminates.
  const slideHorizontally = (p: Placeable, preferRight: boolean): Rect => {
    let x = p.x
    const rectAt = (): Rect => ({ x, y: p.y, width: p.width, height: p.height })
    for (let guard = 0; guard < 400; guard++) {
      const hit = fixed.find((f) => overlaps(rectAt(), f))
      if (!hit) break
      x = preferRight ? hit.x + hit.width + gap : hit.x - p.width - gap
    }
    return rectAt()
  }

  const moved = new Map<string, { x: number; y: number }>()
  for (const p of order) {
    const desired: Rect = { x: p.x, y: p.y, width: p.width, height: p.height }
    if (clearOf(desired)) {
      fixed.push(desired)
      continue
    }
    // findNonOverlapPosition only reads x/y/width/height off the obstacles, so a
    // plain rect array stands in for Widget[].
    let px: number
    let py: number
    if (axis === 'horizontal') {
      // Push toward the side the widget already sits on relative to the anchor,
      // so it moves the shorter way out; keep its row (y).
      const slid = slideHorizontally(p, cx(desired) >= cx(anchor))
      if (clearOf(slid)) {
        px = slid.x
        py = slid.y
      } else {
        // Rare — boxed in on that row: fall back to the nearest clear spot so it
        // never lands overlapping.
        const fb = findNonOverlapPosition(desired, fixed as unknown as Widget[], gap)
        px = fb.x
        py = fb.y
      }
    } else {
      const fb = findNonOverlapPosition(desired, fixed as unknown as Widget[], gap)
      px = fb.x
      py = fb.y
    }
    moved.set(p.id, { x: Math.round(px), y: Math.round(py) })
    fixed.push({ x: px, y: py, width: p.width, height: p.height })
  }
  return moved
}
