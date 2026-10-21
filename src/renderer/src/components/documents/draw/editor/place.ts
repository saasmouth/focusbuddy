// File › Place, the editor half: the "loaded" cursor and putting placed files
// into the drawing.
//
// Illustrator's model, which this follows:
//   - Place (⇧⌘P) loads one or more files into the cursor; the canvas shows a
//     preview of the next one under the pointer and how many are waiting.
//   - A CLICK places the next file at its actual size with its top-left
//     corner at the click. A DRAG places it into the dragged box, keeping its
//     proportions. Escape discards the file in the cursor (the next one is
//     then loaded); choosing another tool unloads them all.
//   - A placed image is EMBEDDED (its bytes go into the drawing's asset
//     store). Linked placement is not offered: a drawing pointing at a file on
//     this computer would make every viewer of a shared drawing fetch it.
//   - A placed SVG arrives as editable art: one group named after the file
//     (or, while this drawing is still written in the older format, its
//     objects, selected together).
// Each placement is one undo step.

import { putAsset } from '@shared/draw/assets'
import type { Box, DrawAsset, DrawDoc, DrawNode } from '@shared/draw/model'
import { addLayer, addObject, targetLayerId } from '@shared/draw/ops'
import { transformPath } from '@shared/drawGeometry'
import type { EditorCtx } from './types'

/** One file, ready to be placed. */
export interface PlaceItem {
  name: string
  /** What it is, in words: "image", "SVG", "PDF page 1 of 3". */
  label: string
  /** Its actual size in document units (what a click places). */
  size: { w: number; h: number }
  /** A picture for the loaded cursor, when there is one. */
  preview?: string
  /** Remarks from the import, shown once it is placed. */
  report?: string[]
  /** The nodes (and assets they need) for this file at `rect`, with fresh ids. */
  make(rect: Box): { nodes: DrawNode[]; assets: Record<string, DrawAsset> }
}

export interface PlaceQueue {
  items: PlaceItem[]
  /** Place onto a new template layer (dimmed, locked, not exported), as Illustrator's Template option. */
  template?: boolean
  /** Import reports of files already placed from this queue, shown when it is empty. */
  reports?: Array<{ name: string; lines: string[] }>
}

/** Load files into the place cursor and switch to it. */
export function loadPlaceCursor(ctx: EditorCtx, items: PlaceItem[], template = false): void {
  if (!items.length) return
  ctx.set({ placing: { items, template }, tool: 'place' })
  ctx.status(placeStatus(items))
}

export function placeStatus(items: PlaceItem[]): string {
  const n = items.length
  const next = items[0]
  return `Click to place ${next.name} at actual size, or drag to size it${n > 1 ? ` (${n} files loaded)` : ''}. Esc discards it.`
}

/** Escape in the place cursor: drop the file at the front of the queue. */
export function discardPlaceItem(ctx: EditorCtx): void {
  const q = ctx.get().placing
  if (!q) return
  const rest = q.items.slice(1)
  if (rest.length) {
    ctx.set({ placing: { ...q, items: rest } })
    ctx.status(placeStatus(rest))
    return
  }
  ctx.set({ placing: null, tool: 'select' })
  ctx.status(null)
  if (q.reports?.length) showImportReport(ctx, q.reports)
}

/** The box a click or drag places `item` in: actual size at the click, or the drag box at the item's proportions. */
export function placeRect(item: Pick<PlaceItem, 'size'>, from: { x: number; y: number }, to: { x: number; y: number } | null): Box {
  const { w, h } = item.size
  if (!to || (Math.abs(to.x - from.x) < 3 && Math.abs(to.y - from.y) < 3)) return { x: from.x, y: from.y, w, h }
  const dx = to.x - from.x
  const dy = to.y - from.y
  // Proportional: the larger of the two scale factors the drag implies.
  const k = Math.max(Math.abs(dx) / w, Math.abs(dy) / h)
  const W = w * k
  const H = h * k
  return { x: dx < 0 ? from.x - W : from.x, y: dy < 0 ? from.y - H : from.y, w: W, h: H }
}

/** Scale and move a node uniformly (k, then +e, +f), strokes and type included. */
export function scalePlaced(n: DrawNode, k: number, e: number, f: number): DrawNode {
  const map = (x: number, y: number): { x: number; y: number } => ({ x: x * k + e, y: y * k + f })
  switch (n.type) {
    case 'path': {
      const stroke = n.stroke ? { ...n.stroke, width: n.stroke.width * k, ...(n.stroke.dash ? { dash: n.stroke.dash.map((d) => d * k) } : {}) } : undefined
      return {
        ...n,
        path: transformPath(n.path, [k, 0, 0, k, e, f]),
        ...(stroke ? { stroke } : {}),
        ...(n.cornerRadius !== undefined ? { cornerRadius: n.cornerRadius * k } : {})
      }
    }
    case 'group':
      if (n.transform) {
        const t = n.transform
        return { ...n, transform: [t[0] * k, t[1] * k, t[2] * k, t[3] * k, t[4] * k + e, t[5] * k + f] }
      }
      return { ...n, children: n.children.map((c) => scalePlaced(c, k, e, f)) }
    case 'text': {
      if (n.transform) {
        const t = n.transform
        return { ...n, transform: [t[0] * k, t[1] * k, t[2] * k, t[3] * k, t[4] * k + e, t[5] * k + f] }
      }
      const p = map(n.x, n.y)
      return {
        ...n,
        x: p.x,
        y: p.y,
        w: n.w * k,
        fontSize: n.fontSize * k,
        ...(n.letterSpacing ? { letterSpacing: n.letterSpacing * k } : {}),
        ...(n.stroke ? { stroke: { ...n.stroke, width: n.stroke.width * k } } : {})
      }
    }
    case 'image':
    case 'widget': {
      if (n.transform) {
        const t = n.transform
        return { ...n, transform: [t[0] * k, t[1] * k, t[2] * k, t[3] * k, t[4] * k + e, t[5] * k + f] }
      }
      const p = map(n.x, n.y)
      return { ...n, x: p.x, y: p.y, w: n.w * k, h: n.h * k }
    }
    default:
      return n
  }
}

/** Fresh ids throughout (a file placed twice must not share ids). */
export function withFreshIds(nodes: DrawNode[], newId: (prefix: string) => string): DrawNode[] {
  return nodes.map((n) => {
    const id = newId(n.type === 'group' ? 'grp' : n.type === 'image' ? 'img' : n.type === 'text' ? 'txt' : 'obj')
    if (n.type === 'group') return { ...n, id, children: withFreshIds(n.children, newId) }
    return { ...n, id }
  })
}

/**
 * The document with `item` placed at `rect`: on the target layer, or on a
 * fresh template layer. Returns the new document and the ids to select.
 */
export function placeIntoDoc(doc: DrawDoc, item: PlaceItem, rect: Box, opts: { template?: boolean; newId: (prefix: string) => string }): { doc: DrawDoc; ids: string[] } {
  const made = item.make(rect)
  let assets = doc.assets
  for (const [id, a] of Object.entries(made.assets)) {
    if (Object.prototype.hasOwnProperty.call(assets, id)) continue
    assets = putAsset(assets, a.dataUrl, a.w !== undefined && a.h !== undefined ? { w: a.w, h: a.h } : undefined).assets
  }
  let next: DrawDoc = { ...doc, assets }
  if (opts.template) {
    const id = opts.newId('lyr')
    next = addLayer(next, { id, kind: 'vector', name: `Template: ${item.name}`.slice(0, 80), visible: true, locked: true, opacity: 0.5, blend: 'normal', objects: made.nodes, template: true })
    return { doc: next, ids: [] }
  }
  const layer = targetLayerId(next)
  for (const n of made.nodes) next = addObject(next, n, layer)
  return { doc: next, ids: made.nodes.map((n) => n.id) }
}

/** Place the item at the front of the queue into the drawing as one undo step, then load the next. */
export function placeNext(ctx: EditorCtx, rect: Box, newId: (prefix: string) => string): void {
  const q = ctx.get().placing
  if (!q || !q.items.length) return
  const item = q.items[0]
  const { doc, ids } = placeIntoDoc(ctx.doc(), item, rect, { template: q.template, newId })
  ctx.history.commit(doc, q.template ? 'Place as template' : `Place ${item.label}`)
  ctx.select(ids)
  const reports = [...(q.reports ?? []), ...(item.report?.length ? [{ name: item.name, lines: item.report }] : [])]
  const rest = q.items.slice(1)
  if (rest.length) {
    ctx.set({ placing: { ...q, items: rest, reports } })
    ctx.status(placeStatus(rest))
    return
  }
  ctx.set({ placing: null, tool: 'select' })
  if (reports.length) showImportReport(ctx, reports)
  else ctx.status(`Placed ${item.name}.`)
}

/** The import report dialog (see dialogs/importReport.dialog.tsx). */
export function showImportReport(ctx: EditorCtx, reports: Array<{ name: string; lines: string[] }>, action?: { label: string; run: () => void }): void {
  ctx.set({ dialog: { id: 'import-report', props: { reports, ...(action ? { action } : {}) } } })
}
