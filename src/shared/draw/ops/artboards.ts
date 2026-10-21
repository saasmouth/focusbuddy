// Artboards on a v2 document: the active artboard, sizing, and the
// multi-artboard operations behind the Artboard tool, Object › Artboards and
// the Artboards panel (WP-ARTBOARD). Every artboard is a rectangle in DOCUMENT
// space; art lives in the same space and is never "on" an artboard by
// reference -- it is on whichever artboard it sits inside.

import type { Box } from '../../drawGeometry'
import type { DrawArtboard, DrawDoc, DrawDocLayer, DrawNode } from '../model'
import { isMeasurable, nodeBounds, translateNode } from './geometry'

/** The artboard the editor treats as "the page": the active one, else the first. */
export function primaryArtboard(doc: DrawDoc): DrawArtboard {
  return (doc.activeArtboardId ? doc.artboards.find((a) => a.id === doc.activeArtboardId) : undefined) ?? doc.artboards[0]
}

/** Where the existing artwork stays pinned when the artboard changes size. */
export type ArtboardAnchor = 'nw' | 'n' | 'ne' | 'w' | 'c' | 'e' | 'sw' | 's' | 'se'

export const ARTBOARD_ANCHORS: ArtboardAnchor[] = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se']

/** How far the artwork moves when the artboard goes from `from` to `to` pinned at `anchor`. */
export function artboardResizeOffset(from: { w: number; h: number }, to: { w: number; h: number }, anchor: ArtboardAnchor): { dx: number; dy: number } {
  const fx = anchor.includes('w') ? 0 : anchor.includes('e') ? 1 : 0.5
  const fy = anchor.startsWith('n') ? 0 : anchor.startsWith('s') ? 1 : 0.5
  return { dx: Math.round((to.w - from.w) * fx), dy: Math.round((to.h - from.h) * fy) }
}

/**
 * Resize the primary artboard.
 *
 * With ONE artboard (every v1 drawing), the page stays at the origin and the
 * art moves by the anchor offset
 * (locked and hidden ones too: the page moves under the art), so the drawing
 * stays writable by older builds. With SEVERAL artboards, the art stays where
 * it is and the artboard itself moves by minus that offset -- the same picture
 * relative to the anchor, without dragging the other artboards' art. Paint layers
 * take the re-laid pixels the editor hands in as asset ids in `rasterAssets`
 * (re-laying them needs a canvas, so the editor does it -- see
 * raster.reframeRaster); the new bytes must already be in `assets`.
 */
export function resizeArtboard(
  doc: DrawDoc,
  w: number,
  h: number,
  anchor: ArtboardAnchor = 'nw',
  rasterAssets: Record<string, string | undefined> = {},
  assets: DrawDoc['assets'] = doc.assets
): DrawDoc {
  const board = primaryArtboard(doc)
  const { dx, dy } = artboardResizeOffset({ w: board.w, h: board.h }, { w, h }, anchor)
  if (doc.artboards.length > 1) {
    const frame = rasterArtboard(doc)
    const layers = doc.layers.map((l): DrawDocLayer => {
      if (l.kind !== 'raster' || frame.id !== board.id || !Object.prototype.hasOwnProperty.call(rasterAssets, l.id)) return l
      const assetId = rasterAssets[l.id]
      const { assetId: _old, ...rest } = l
      void _old
      return assetId ? { ...rest, assetId } : rest
    })
    return { ...doc, assets, artboards: doc.artboards.map((a) => (a.id === board.id ? { ...a, x: a.x - dx, y: a.y - dy, w, h } : a)), layers }
  }
  const layers = doc.layers.map((l): DrawDocLayer => {
    if (l.kind === 'raster') {
      if (!Object.prototype.hasOwnProperty.call(rasterAssets, l.id)) return l
      const assetId = rasterAssets[l.id]
      const { assetId: _old, ...rest } = l
      void _old
      return assetId ? { ...rest, assetId } : rest
    }
    if (!dx && !dy) return l
    return { ...l, objects: l.objects.map((o) => translateNode(o, dx, dy)) }
  })
  return { ...doc, assets, artboards: doc.artboards.map((a) => (a.id === board.id ? { ...a, w, h } : a)), layers }
}

/** Set the primary artboard's background paint. */
export function setArtboardBackground(doc: DrawDoc, background: DrawArtboard['background']): DrawDoc {
  const board = primaryArtboard(doc)
  return { ...doc, artboards: doc.artboards.map((a) => (a.id === board.id ? { ...a, background } : a)) }
}

// ── Several artboards (WP-ARTBOARD) ──────────────────────────────────────────

/** Smallest and largest artboard side, as in the Artboard size dialog. */
export const ARTBOARD_MIN = 1
export const ARTBOARD_MAX = 16384

export function artboardById(doc: DrawDoc, id: string): DrawArtboard | undefined {
  return doc.artboards.find((a) => a.id === id)
}

/**
 * The artboard paint layers are pixels of. A paint layer is one picture the
 * size of the first page, anchored at the document origin (v1's page), so it
 * keeps that frame whichever artboard is active.
 */
export function rasterArtboard(doc: DrawDoc): DrawArtboard {
  return doc.artboards.find((a) => a.id === 'artboard-1') ?? doc.artboards[0]
}

/** The paint layers' frame in document space: the raster artboard's size, at the origin. */
export function rasterFrame(doc: DrawDoc): Box {
  const a = rasterArtboard(doc)
  return { x: 0, y: 0, w: a.w, h: a.h }
}

/** The union of every artboard: what the canvas shows. */
export function artboardsBounds(doc: DrawDoc): Box {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const a of doc.artboards) {
    x0 = Math.min(x0, a.x)
    y0 = Math.min(y0, a.y)
    x1 = Math.max(x1, a.x + a.w)
    y1 = Math.max(y1, a.y + a.h)
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 1, h: 1 }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** The topmost artboard under a point (later artboards are drawn over earlier ones), or undefined. */
export function artboardAt(doc: DrawDoc, p: { x: number; y: number }): DrawArtboard | undefined {
  for (let i = doc.artboards.length - 1; i >= 0; i--) {
    const a = doc.artboards[i]
    if (p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h) return a
  }
  return undefined
}

/** Make an artboard the active one (unknown ids change nothing). */
export function setActiveArtboard(doc: DrawDoc, id: string): DrawDoc {
  if (!artboardById(doc, id) || primaryArtboard(doc).id === id && doc.activeArtboardId === id) return doc
  return { ...doc, activeArtboardId: id }
}

/** Illustrator's name for the next new artboard: "Artboard N", N one past the highest in use. */
export function nextArtboardName(doc: DrawDoc): string {
  let n = doc.artboards.length
  for (const a of doc.artboards) {
    const m = /^Artboard (\d+)$/.exec(a.name)
    if (m) n = Math.max(n, Number(m[1]))
  }
  return `Artboard ${n + 1}`
}

const clampSide = (v: number): number => Math.max(ARTBOARD_MIN, Math.min(ARTBOARD_MAX, Math.round(v)))

/** A rectangle made a valid artboard frame: positive, whole pixels, within limits. */
export function normalArtboardRect(r: Box): Box {
  const x = Math.min(r.x, r.x + r.w)
  const y = Math.min(r.y, r.y + r.h)
  return { x: Math.round(x), y: Math.round(y), w: clampSide(Math.abs(r.w)), h: clampSide(Math.abs(r.h)) }
}

/**
 * Add an artboard and make it active. `background` defaults to the active
 * artboard's (Illustrator's new artboards match the document); the name to
 * the next "Artboard N".
 */
export function addArtboard(doc: DrawDoc, id: string, rect: Box, opts: { name?: string; background?: DrawArtboard['background']; presetId?: string } = {}): DrawDoc {
  const r = normalArtboardRect(rect)
  const board: DrawArtboard = {
    id,
    name: opts.name?.trim() || nextArtboardName(doc),
    ...r,
    background: opts.background ?? primaryArtboard(doc).background,
    ...(opts.presetId ? { presetId: opts.presetId } : {})
  }
  return { ...doc, artboards: [...doc.artboards, board], activeArtboardId: id }
}

/** Where Object › Artboards › New Artboard puts one: the active artboard's size, to the right of every artboard, 20 px apart. */
export function newArtboardRect(doc: DrawDoc, gap = 20): Box {
  const b = artboardsBounds(doc)
  const a = primaryArtboard(doc)
  return { x: b.x + b.w + gap, y: a.y, w: a.w, h: a.h }
}

/**
 * Delete artboards (never the last one). The art stays, as in Illustrator:
 * deleting an artboard removes the page, not what was drawn on it. The
 * active artboard becomes the nearest remaining one in panel order.
 */
export function deleteArtboards(doc: DrawDoc, ids: string[]): DrawDoc {
  const gone = new Set(ids)
  const keep = doc.artboards.filter((a) => !gone.has(a.id))
  if (!keep.length || keep.length === doc.artboards.length) return doc
  const active = primaryArtboard(doc)
  let activeArtboardId = active.id
  if (gone.has(active.id)) {
    const i = doc.artboards.findIndex((a) => a.id === active.id)
    const after = doc.artboards.slice(i + 1).find((a) => !gone.has(a.id))
    const before = doc.artboards.slice(0, i).reverse().find((a) => !gone.has(a.id))
    activeArtboardId = (before ?? after ?? keep[0]).id
  }
  return { ...doc, artboards: keep, activeArtboardId }
}

/** Rename an artboard (a blank name is refused: the panel and the PDF bookmarks need one). */
export function renameArtboard(doc: DrawDoc, id: string, name: string): DrawDoc {
  const n = name.trim().slice(0, 120)
  const a = artboardById(doc, id)
  if (!a || !n || a.name === n) return doc
  return { ...doc, artboards: doc.artboards.map((x) => (x.id === id ? { ...x, name: n } : x)) }
}

/** Patch one artboard's frame or settings. The frame is normalised; a preset id is dropped when the size no longer matches it. */
export function patchArtboard(doc: DrawDoc, id: string, patch: Partial<Omit<DrawArtboard, 'id'>>): DrawDoc {
  const a = artboardById(doc, id)
  if (!a) return doc
  const next: DrawArtboard = { ...a, ...patch }
  const r = normalArtboardRect({ x: next.x, y: next.y, w: next.w, h: next.h })
  Object.assign(next, r)
  if (patch.presetId === undefined && next.presetId !== undefined && (next.w !== a.w || next.h !== a.h)) delete next.presetId
  if (next.x === a.x && next.y === a.y && next.w === a.w && next.h === a.h && next.name === a.name && next.background === a.background && next.presetId === a.presetId) return doc
  return { ...doc, artboards: doc.artboards.map((x) => (x.id === id ? next : x)) }
}

/** Move an artboard to `index` in the Artboards panel's order (the order PDF pages and "next artboard" follow). */
export function reorderArtboard(doc: DrawDoc, id: string, index: number): DrawDoc {
  const from = doc.artboards.findIndex((a) => a.id === id)
  if (from < 0) return doc
  const to = Math.max(0, Math.min(doc.artboards.length - 1, Math.round(index)))
  if (to === from) return doc
  const list = doc.artboards.slice()
  const [a] = list.splice(from, 1)
  list.splice(to, 0, a)
  return { ...doc, artboards: list }
}

/** Is a box wholly inside an artboard? */
function boxInside(b: Box, a: Box): boolean {
  return b.x >= a.x - 1e-6 && b.y >= a.y - 1e-6 && b.x + b.w <= a.x + a.w + 1e-6 && b.y + b.h <= a.y + a.h + 1e-6
}

/**
 * Top-level objects that sit on an artboard: wholly inside it, unlocked, on
 * an unlocked layer. This is the art Illustrator's "Move/Copy Artwork with
 * Artboard" carries along; hidden objects ride along too (they are on the page).
 */
export function artOnArtboard(doc: DrawDoc, board: Box): Array<{ layerId: string; node: DrawNode }> {
  const out: Array<{ layerId: string; node: DrawNode }> = []
  for (const l of doc.layers) {
    if (l.kind !== 'vector' || l.locked) continue
    for (const o of l.objects) {
      if (o.locked || o.type === 'opaque' || !isMeasurable(o)) continue
      if (boxInside(nodeBounds(o), board)) out.push({ layerId: l.id, node: o })
    }
  }
  return out
}

/** Move top-level objects by (dx, dy), by id. */
function moveTopLevel(doc: DrawDoc, ids: Set<string>, dx: number, dy: number): DrawDoc {
  if (!ids.size || (!dx && !dy)) return doc
  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.kind !== 'vector' || !l.objects.some((o) => ids.has(o.id))) return l
      return { ...l, objects: l.objects.map((o) => (ids.has(o.id) ? translateNode(o, dx, dy) : o)) }
    })
  }
}

/**
 * Move artboards by (dx, dy). With `withArt` (Illustrator's "Move/Copy
 * Artwork with Artboard", on by default) the art sitting on each one moves
 * with it -- and only that art.
 */
export function moveArtboards(doc: DrawDoc, ids: string[], dx: number, dy: number, withArt = true): DrawDoc {
  if (!dx && !dy) return doc
  const set = new Set(ids)
  const art = new Set<string>()
  if (withArt) for (const a of doc.artboards) if (set.has(a.id)) for (const x of artOnArtboard(doc, a)) art.add(x.node.id)
  const moved = { ...doc, artboards: doc.artboards.map((a) => (set.has(a.id) ? { ...a, x: Math.round(a.x + dx), y: Math.round(a.y + dy) } : a)) }
  return moveTopLevel(moved, art, Math.round(dx), Math.round(dy))
}

/**
 * Duplicate an artboard (Alt-drag, the panel's Duplicate): a copy offset by
 * (dx, dy), named "<name> copy", and -- with `withArt` -- copies of the art on
 * it, each placed directly above its original. `newId` mints every new id.
 */
export function duplicateArtboard(
  doc: DrawDoc,
  id: string,
  newBoardId: string,
  dx: number,
  dy: number,
  opts: { withArt?: boolean; copyNode?: (n: DrawNode) => DrawNode } = {}
): { doc: DrawDoc; newNodeIds: string[] } {
  const a = artboardById(doc, id)
  if (!a) return { doc, newNodeIds: [] }
  const copy: DrawArtboard = { ...a, id: newBoardId, name: `${a.name} copy`.slice(0, 120), x: Math.round(a.x + dx), y: Math.round(a.y + dy) }
  const i = doc.artboards.indexOf(a)
  const artboards = [...doc.artboards.slice(0, i + 1), copy, ...doc.artboards.slice(i + 1)]
  let next: DrawDoc = { ...doc, artboards, activeArtboardId: copy.id }
  const newNodeIds: string[] = []
  if (opts.withArt !== false && opts.copyNode) {
    const on = artOnArtboard(doc, a)
    const byLayer = new Map<string, Set<string>>()
    for (const x of on) {
      if (!byLayer.has(x.layerId)) byLayer.set(x.layerId, new Set())
      byLayer.get(x.layerId)!.add(x.node.id)
    }
    next = {
      ...next,
      layers: next.layers.map((l) => {
        const ids = byLayer.get(l.id)
        if (!ids || l.kind !== 'vector') return l
        const objects: DrawNode[] = []
        for (const o of l.objects) {
          objects.push(o)
          if (!ids.has(o.id)) continue
          const c = translateNode(opts.copyNode!(o), Math.round(dx), Math.round(dy))
          newNodeIds.push(c.id)
          objects.push(c)
        }
        return { ...l, objects }
      })
    }
  }
  return { doc: next, newNodeIds }
}

/** Fit an artboard to a box (Fit to Artwork Bounds / Fit to Selected Art), in whole pixels that cover it. */
export function fitArtboardTo(doc: DrawDoc, id: string, box: Box): DrawDoc {
  if (!(box.w > 0) || !(box.h > 0)) return doc
  const x = Math.floor(box.x)
  const y = Math.floor(box.y)
  return patchArtboard(doc, id, { x, y, w: Math.ceil(box.x + box.w) - x, h: Math.ceil(box.y + box.h) - y })
}

/** Bounds of every visible, measurable object on visible vector layers (Fit to Artwork Bounds), or null when there is none. */
export function artworkBounds(doc: DrawDoc): Box | null {
  let b: Box | null = null
  for (const l of doc.layers) {
    if (l.kind !== 'vector' || !l.visible || l.template) continue
    for (const o of l.objects) {
      if (o.hidden || o.type === 'opaque' || !isMeasurable(o)) continue
      const ob = nodeBounds(o)
      if (!(ob.w >= 0 && ob.h >= 0)) continue
      b = b ? union(b, ob) : ob
    }
  }
  return b
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

/** Illustrator's Rearrange All Artboards layouts. */
export type ArtboardLayout = 'grid-by-row' | 'grid-by-column' | 'row' | 'column'

export interface RearrangeOptions {
  layout: ArtboardLayout
  /** Columns (grid by row) or rows (grid by column); ignored for a single row or column. */
  count: number
  /** Gap between artboards, document px. */
  spacing: number
  /** Right-to-left order (Illustrator's "Change to Right-to-Left Layout"). */
  rtl?: boolean
  /** Move the art on each artboard with it. */
  withArt: boolean
}

/**
 * Where each artboard goes for a layout, in panel order, starting at the
 * first artboard's top-left. Cells are as wide as the widest artboard in
 * their column and as tall as the tallest in their row, so artboards of mixed
 * sizes never overlap; each sits at its cell's top-left, as in Illustrator.
 */
export function rearrangePositions(boards: Array<{ w: number; h: number }>, opts: Omit<RearrangeOptions, 'withArt'>, origin = { x: 0, y: 0 }): Array<{ x: number; y: number }> {
  const n = boards.length
  if (!n) return []
  const count = Math.max(1, Math.round(opts.count) || 1)
  const gap = Number.isFinite(opts.spacing) ? opts.spacing : 0
  let cols: number
  let rows: number
  const cell = (i: number): { c: number; r: number } => {
    if (opts.layout === 'row') return { c: i, r: 0 }
    if (opts.layout === 'column') return { c: 0, r: i }
    if (opts.layout === 'grid-by-row') return { c: i % cols, r: Math.floor(i / cols) }
    return { c: Math.floor(i / rows), r: i % rows }
  }
  if (opts.layout === 'row') {
    cols = n
    rows = 1
  } else if (opts.layout === 'column') {
    cols = 1
    rows = n
  } else if (opts.layout === 'grid-by-row') {
    cols = Math.min(count, n)
    rows = Math.ceil(n / cols)
  } else {
    rows = Math.min(count, n)
    cols = Math.ceil(n / rows)
  }
  const colW = new Array<number>(cols).fill(0)
  const rowH = new Array<number>(rows).fill(0)
  boards.forEach((b, i) => {
    const { c, r } = cell(i)
    colW[c] = Math.max(colW[c], b.w)
    rowH[r] = Math.max(rowH[r], b.h)
  })
  const colX: number[] = []
  let x = origin.x
  const order = opts.rtl ? colW.map((_, i) => cols - 1 - i) : colW.map((_, i) => i)
  for (const c of order) {
    colX[c] = x
    x += colW[c] + gap
  }
  const rowY: number[] = []
  let y = origin.y
  for (let r = 0; r < rows; r++) {
    rowY[r] = y
    y += rowH[r] + gap
  }
  return boards.map((_, i) => {
    const { c, r } = cell(i)
    return { x: Math.round(colX[c]), y: Math.round(rowY[r]) }
  })
}

/** Rearrange every artboard (Object › Artboards › Rearrange All…). */
export function rearrangeArtboards(doc: DrawDoc, opts: RearrangeOptions): DrawDoc {
  if (!doc.artboards.length) return doc
  const first = doc.artboards[0]
  const pos = rearrangePositions(doc.artboards, opts, { x: first.x, y: first.y })
  // Each artboard's art is found BEFORE anything moves, so art is never
  // claimed by an artboard that only arrives over it mid-rearrange.
  const carried = doc.artboards.map((a) => (opts.withArt ? artOnArtboard(doc, a).map((x) => x.node.id) : []))
  const claimed = new Set<string>()
  let next: DrawDoc = { ...doc, artboards: doc.artboards.map((a, i) => ({ ...a, x: pos[i].x, y: pos[i].y })) }
  doc.artboards.forEach((a, i) => {
    const ids = new Set(carried[i].filter((id) => !claimed.has(id)))
    ids.forEach((id) => claimed.add(id))
    next = moveTopLevel(next, ids, pos[i].x - a.x, pos[i].y - a.y)
  })
  const same = next.artboards.every((a, i) => a.x === doc.artboards[i].x && a.y === doc.artboards[i].y)
  return same ? doc : next
}
