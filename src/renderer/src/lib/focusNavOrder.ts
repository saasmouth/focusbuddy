import type { Widget } from '@shared/types'

// Pure spatial ordering for widget focus mode — no store / DOM / renderer deps,
// so it is unit-testable in isolation. The widgets store re-exports these.

// The set of widgets you can walk through in focus mode: the desk's real, live
// windows. Excludes archived, section CONTAINERS (a section is scaffolding, not
// a thing you "open"), and pinned widgets (screen-docked chrome). Widgets that
// live INSIDE a section ARE included — on a desk organised entirely into
// sections they'd otherwise leave the deck empty (no dock, no arrows). Their
// spatial order is resolved to absolute canvas coordinates in focusNavOrder.
export function isFocusable(w: Widget): boolean {
  return !w.archived && !w.pinned && w.kind !== 'section'
}

// Padding between a section's frame and its children (mirrors Canvas's
// SECTION_PADDING). Used only to approximate a child's absolute position for
// ordering — exact layout math isn't needed, just "near its section".
const SECTION_PADDING_APPROX = 48

// Effective absolute top-left of a widget for spatial ordering. A section child
// stores x/y relative to its parent; translate to canvas space so it sorts near
// its section rather than at the desk origin. Falls back to the widget's own x/y
// if the parent isn't found (defensive).
//
// Exported because deskCameraNav needs the same translation to aim the camera.
// Two copies of this would drift, and the symptom would be arrow keys and the
// focus-mode dock disagreeing about where a widget is -- the kind of bug nobody
// reports clearly because it only shows up on desks that use sections.
export function effectivePos(w: Widget, byId: Map<string, Widget>): { x: number; y: number } {
  if (!w.parentSectionId) return { x: w.x, y: w.y }
  const parent = byId.get(w.parentSectionId)
  if (!parent) return { x: w.x, y: w.y }
  return {
    x: parent.x + SECTION_PADDING_APPROX + w.x,
    y: parent.y + SECTION_PADDING_APPROX + w.y
  }
}

// Canonical order for focus-mode navigation + the focus-mode dock. Spatial
// reading order — top-to-bottom in rows, then left-to-right within each row — so
// pressing → walks across the desk the way your eye would, and the dock
// filmstrip matches the arrow keys exactly.
//
// Rows are found by RELATIVE clustering, not a fixed grid. An earlier version
// banded by Math.floor(y / 200), which split two side-by-side widgets whenever
// their y straddled a 200px grid line (e.g. y=-479 and y=-272 landed in
// different bands despite sitting on the same visual row) — that was the "won't
// always go left-to-right" bug. Instead we sort by y, then greedily grow a row
// while the next widget still VERTICALLY OVERLAPS the row's band by a healthy
// margin. Two windows the eye reads as one row overlap vertically; a genuinely
// lower window does not. Widget height is respected, so a tall window and a
// short one that line up at the top still group correctly.
export function focusNavOrder(widgets: Widget[]): Widget[] {
  const items = widgets.filter(isFocusable)
  if (items.length < 2) return items

  // Resolve each widget to an absolute canvas position once (section children
  // are stored relative to their parent). All subsequent ordering uses these.
  const byId = new Map(widgets.map((w) => [w.id, w]))
  const posOf = new Map(items.map((w) => [w.id, effectivePos(w, byId)]))
  const yOf = (w: Widget): number => posOf.get(w.id)!.y
  const xOf = (w: Widget): number => posOf.get(w.id)!.x

  // Top-to-bottom first; createdAt only as a last-resort stable tiebreak.
  const byTop = [...items].sort((a, b) => yOf(a) - yOf(b) || a.createdAt - b.createdAt)

  // Greedily cluster into rows. A widget joins the current row if its vertical
  // span overlaps the row's running band by more than OVERLAP_FRAC of the
  // smaller of the two heights — i.e. they clearly share a horizontal line.
  const OVERLAP_FRAC = 0.35
  const rows: Widget[][] = []
  let row: Widget[] = []
  let bandTop = 0
  let bandBottom = 0
  for (const w of byTop) {
    const top = yOf(w)
    const bottom = top + Math.max(1, w.height)
    if (row.length === 0) {
      row = [w]
      bandTop = top
      bandBottom = bottom
      continue
    }
    const overlap = Math.min(bottom, bandBottom) - Math.max(top, bandTop)
    const minH = Math.min(bottom - top, bandBottom - bandTop)
    if (overlap >= OVERLAP_FRAC * minH) {
      row.push(w)
      // The band is the union of the row's members so a staggered row keeps
      // accreting neighbours instead of drifting off the first widget.
      bandTop = Math.min(bandTop, top)
      bandBottom = Math.max(bandBottom, bottom)
    } else {
      rows.push(row)
      row = [w]
      bandTop = top
      bandBottom = bottom
    }
  }
  if (row.length) rows.push(row)

  // Within each row, left-to-right; exact-overlap ties fall back to createdAt so
  // the order is deterministic across reloads.
  return rows.flatMap((r) => r.sort((a, b) => xOf(a) - xOf(b) || a.createdAt - b.createdAt))
}
