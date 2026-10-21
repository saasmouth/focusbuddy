// Helpers several tools share: selection-box handles, the smart-guide snap,
// rubber-band boxes, and the paint-layer plumbing. Moved verbatim out of the
// old single-file DrawStudio.tsx so every tool computes these the same way.

import type { Box, Pt } from '@shared/drawGeometry'
import type { DrawDoc } from '@shared/draw/model'
import { addLayer, getObject, nodeBounds, nodesWorldBounds, primaryArtboard, rasterLayerV2 } from '@shared/draw/ops'
import type { EditorCtx, SnapGuide } from '../editor/types'

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const HANDLES: HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export function normBox(a: Pt, b: Pt): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}

/** Shift-drag: force the gesture into a square, keeping the dominant extent. */
export function squareOff(from: Pt, to: Pt): Pt {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const s = Math.max(Math.abs(dx), Math.abs(dy))
  return { x: from.x + Math.sign(dx || 1) * s, y: from.y + Math.sign(dy || 1) * s }
}

export function handlePoint(b: Box, h: HandleId): Pt {
  const midX = b.x + b.w / 2
  const midY = b.y + b.h / 2
  const right = b.x + b.w
  const bottom = b.y + b.h
  switch (h) {
    case 'nw':
      return { x: b.x, y: b.y }
    case 'n':
      return { x: midX, y: b.y }
    case 'ne':
      return { x: right, y: b.y }
    case 'e':
      return { x: right, y: midY }
    case 'se':
      return { x: right, y: bottom }
    case 's':
      return { x: midX, y: bottom }
    case 'sw':
      return { x: b.x, y: bottom }
    default:
      return { x: b.x, y: midY }
  }
}

export function angleTo(center: Pt, p: Pt): number {
  return (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI
}

/**
 * The new box for a handle drag. Shift keeps the aspect ratio; Alt resizes about
 * the centre. A box is never allowed to collapse past 1px, which is what stops a
 * shape from inverting into nothing and becoming unselectable.
 */
export function resizeBox(start: Box, handle: HandleId, p: Pt, keepAspect: boolean, fromCenter: boolean): Box {
  const left = handle.includes('w')
  const right = handle.includes('e')
  const top = handle.startsWith('n')
  const bottom = handle.startsWith('s')
  let x = start.x
  let y = start.y
  let w = start.w
  let h = start.h

  if (right) w = p.x - start.x
  if (left) {
    w = start.x + start.w - p.x
    x = p.x
  }
  if (bottom) h = p.y - start.y
  if (top) {
    h = start.y + start.h - p.y
    y = p.y
  }

  if (keepAspect && start.w > 0 && start.h > 0 && (left || right) && (top || bottom)) {
    const ratio = start.w / start.h
    if (Math.abs(w / ratio) > Math.abs(h)) h = w / ratio
    else w = h * ratio
    if (top) y = start.y + start.h - h
    if (left) x = start.x + start.w - w
  }

  if (fromCenter) {
    const cx = start.x + start.w / 2
    const cy = start.y + start.h / 2
    if (left || right) {
      const halfW = Math.abs(right ? p.x - cx : cx - p.x)
      w = halfW * 2
      x = cx - halfW
    }
    if (top || bottom) {
      const halfH = Math.abs(bottom ? p.y - cy : cy - p.y)
      h = halfH * 2
      y = cy - halfH
    }
  }

  if (w < 0) {
    x += w
    w = -w
  }
  if (h < 0) {
    y += h
    h = -h
  }
  return { x, y, w: Math.max(1, w), h: Math.max(1, h) }
}

/** The visible bounds of the current selection, or null when nothing is selected. */
export function selectionBox(doc: DrawDoc, selection: string[]): Box | null {
  // On the artboard, for members of (transformed) groups too.
  return nodesWorldBounds(doc, selection)
}

/** Which selection handle, if any, is under a point. */
export function handleAt(p: Pt, box: Box, zoom: number): HandleId | 'rot' | null {
  const r = 7 / zoom
  const rotY = box.y - 22 / zoom
  if (Math.hypot(p.x - (box.x + box.w / 2), p.y - rotY) <= r) return 'rot'
  for (const h of HANDLES) {
    const hp = handlePoint(box, h)
    if (Math.abs(p.x - hp.x) <= r && Math.abs(p.y - hp.y) <= r) return h
  }
  return null
}

/** Which path anchor or bezier handle of a selected path, if any, is under a point. */
export function hitNodeAt(doc: DrawDoc, selection: string[], p: Pt, zoom: number): { id: string; si: number; ni: number; part: 'anchor' | 'in' | 'out' } | null {
  const r = 7 / zoom
  for (const id of selection) {
    const o = getObject(doc, id)
    if (!o || o.type !== 'path') continue
    for (let si = 0; si < o.path.subpaths.length; si++) {
      const sp = o.path.subpaths[si]
      for (let ni = 0; ni < sp.nodes.length; ni++) {
        const n = sp.nodes[ni]
        if (n.outX != null && Math.hypot(p.x - n.outX, p.y - (n.outY ?? 0)) <= r) return { id, si, ni, part: 'out' }
        if (n.inX != null && Math.hypot(p.x - n.inX, p.y - (n.inY ?? 0)) <= r) return { id, si, ni, part: 'in' }
        if (Math.hypot(p.x - n.x, p.y - n.y) <= r) return { id, si, ni, part: 'anchor' }
      }
    }
  }
  return null
}

/**
 * Snap a moving box's edges to the artboard's edges and centre and to the
 * other objects' edges, returning the corrected delta plus the guides to draw.
 */
export function snapDelta(ctx: EditorCtx, box: Box, dx: number, dy: number, ignore: string[]): { dx: number; dy: number; guides: SnapGuide[] } {
  const s = ctx.get()
  if (!s.snapOn) return { dx, dy, guides: [] }
  const doc = s.doc
  const board = primaryArtboard(doc)
  const tol = 6 / s.zoom
  const xs: number[] = [board.x, board.x + board.w / 2, board.x + board.w]
  const ys: number[] = [board.y, board.y + board.h / 2, board.y + board.h]
  for (const l of doc.layers) {
    if (l.kind !== 'vector' || !l.visible) continue
    for (const o of l.objects) {
      if (ignore.includes(o.id) || o.hidden || o.type === 'opaque') continue
      const ob = nodeBounds(o)
      xs.push(ob.x, ob.x + ob.w / 2, ob.x + ob.w)
      ys.push(ob.y, ob.y + ob.h / 2, ob.y + ob.h)
    }
  }
  const g: SnapGuide[] = []
  let bestDx = dx
  let bestDistX = tol
  for (const edge of [box.x + dx, box.x + box.w / 2 + dx, box.x + box.w + dx]) {
    for (const candidate of xs) {
      const d = Math.abs(candidate - edge)
      if (d < bestDistX) {
        bestDistX = d
        bestDx = dx + (candidate - edge)
        g.push({ axis: 'x', at: candidate })
      }
    }
  }
  let bestDy = dy
  let bestDistY = tol
  for (const edge of [box.y + dy, box.y + box.h / 2 + dy, box.y + box.h + dy]) {
    for (const candidate of ys) {
      const d = Math.abs(candidate - edge)
      if (d < bestDistY) {
        bestDistY = d
        bestDy = dy + (candidate - edge)
        g.push({ axis: 'y', at: candidate })
      }
    }
  }
  return { dx: bestDx, dy: bestDy, guides: g.filter((x) => (x.axis === 'x' ? bestDistX < tol : bestDistY < tol)) }
}

/** The colour a raster tool paints with: the solid fill, a gradient's first stop, else the brush colour. */
export function currentSolidColor(ctx: EditorCtx): string {
  const s = ctx.get()
  const f = s.fill
  if (f.type === 'solid') return f.color
  if (f.type === 'linear' || f.type === 'radial') return f.stops[0].color
  return s.brush.color
}

/** The active layer if it is an unlocked paint layer. */
export function activeRasterLayerId(ctx: EditorCtx): string | null {
  const doc = ctx.doc()
  const l = doc.layers.find((x) => x.id === doc.activeLayerId)
  if (l && l.kind === 'raster' && !l.locked) return l.id
  return null
}

/**
 * The paint layer to draw on, creating one if the document has none the tools
 * can use. Returns null only when the active layer is a LOCKED paint layer,
 * where silently making a second one would be the wrong answer.
 */
export function ensurePaintLayer(ctx: EditorCtx): string | null {
  const doc = ctx.doc()
  const active = doc.layers.find((l) => l.id === doc.activeLayerId)
  if (active && active.kind === 'raster') {
    if (active.locked) {
      ctx.status('That paint layer is locked — unlock it to paint on it.')
      return null
    }
    return active.id
  }
  // Prefer an unlocked paint layer that already exists over making another.
  const existing = [...doc.layers].reverse().find((l) => l.kind === 'raster' && !l.locked)
  if (existing) {
    ctx.history.replace({ ...doc, activeLayerId: existing.id })
    return existing.id
  }
  const layer = rasterLayerV2(`Paint ${doc.layers.filter((l) => l.kind === 'raster').length + 1}`)
  ctx.history.commit(addLayer(doc, layer, doc.activeLayerId), 'New paint layer')
  return layer.id
}
