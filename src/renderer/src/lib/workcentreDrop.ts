// Dragging things onto the Workcentre (owner, 2026-11-03): show where a thing
// will land while it is held over the view, and land it there — not at the
// first free gap, which after compaction is nearly always the bottom.
//
// What a drop MAKES is the free canvas's business (Canvas.handleDrop: Finder
// files, links and browser tabs, connected apps, documents, widget files,
// palette kinds, desk links). The Workcentre decides where it LANDS: while the
// thing is held, it previews a tile at the pointer (dropSizeFor guesses the
// size from the drag's types, the only part of a drag readable before the
// drop); on drop it arms a claim (armArrivals) and every object the drop then
// creates on this desk is placed at that cell (claimArrivals → pending tile).
// Files-panel drops keep their own direct path in WorkcentreView.

import { FILES_DRAG_MIME } from './filesDrag'
import { DRAG_MIME, catalogFor } from './widgetCatalog'
import { WIDGET_FILE_DRAG_MIME, WIDGET_NEW_FILE_DRAG_MIME } from './widgetFileDrag'
import { DOC_DRAG_TYPE } from './documentDrag'
import { DOC_DRAG_MIME } from './docMetaCache'
import { CONNECTED_APP_DRAG_MIME } from './connectedAppDrag'

function catalogSize(kind: Parameters<typeof catalogFor>[0], w: number, h: number): { w: number; h: number } {
  const e = catalogFor(kind)
  return { w: e?.defaultWidth ?? w, h: e?.defaultHeight ?? h }
}

/**
 * The size (px) a dragged thing will most likely arrive at, from its types, in
 * the same order the canvas reads them. Null: nothing the desk places from it
 * (plain text that is not a link), so no preview is shown.
 */
export function dropSizeFor(types: readonly string[]): { w: number; h: number } | null {
  const has = (t: string): boolean => types.includes(t)
  if (has(FILES_DRAG_MIME) || has('Files')) return catalogSize('file', 360, 280)
  if (has(CONNECTED_APP_DRAG_MIME) || has('text/uri-list')) return catalogSize('webview', 560, 400)
  if (has(WIDGET_NEW_FILE_DRAG_MIME) || has(WIDGET_FILE_DRAG_MIME) || has(DRAG_MIME)) return { w: 320, h: 240 }
  if (has(DOC_DRAG_TYPE) || has(DOC_DRAG_MIME)) return { w: 520, h: 400 }
  if (has('text/fb-task-link')) return catalogSize('task-link', 280, 120)
  return null
}

/** Where a dropped tile of `size` (grid units) goes for a pointer over `cell`: centred on it, top at its row, on the grid. */
export function dropCellFor(cell: { x: number; y: number }, size: { w: number; h: number }, cols: number): { x: number; y: number } {
  const w = Math.min(cols, size.w)
  return { x: Math.max(0, Math.min(cols - w, cell.x - Math.floor(w / 2))), y: Math.max(0, cell.y) }
}

/** How long after a drop new objects are still taken for its cell, if none arrived yet (Finder files are read first). */
export const ARRIVAL_WINDOW_MS = 15_000
/** After an arrival, how long later ones (the rest of a multi-file drop) still join it. */
export const ARRIVAL_TAIL_MS = 2_500

export interface Arrivals {
  cell: { x: number; y: number }
  before: ReadonlySet<string>
  until: number
}

/** Arm a claim at a drop: the objects on the desk now are the ones it must not take. */
export function armArrivals(cell: { x: number; y: number }, presentIds: Iterable<string>, now: number): Arrivals {
  return { cell, before: new Set(presentIds), until: now + ARRIVAL_WINDOW_MS }
}

/** The objects (in `ids` order) the drop created since it was armed; and the claim to keep, or null when it has run out. */
export function claimArrivals(a: Arrivals | null, ids: readonly string[], now: number): { claimed: string[]; next: Arrivals | null } {
  if (!a || now > a.until) return { claimed: [], next: null }
  const claimed = ids.filter((id) => !a.before.has(id))
  if (!claimed.length) return { claimed, next: a }
  return { claimed, next: { cell: a.cell, before: new Set([...a.before, ...claimed]), until: Math.min(a.until, now + ARRIVAL_TAIL_MS) } }
}
