// Shared geometry primitives for PlexiDiagrams: points, boxes, and a node's box
// from its shape defaults. Routing, layout, tidy, export and the editor all use
// these so they agree on where a shape is and how big it is.

import type { MapNode } from '../types'
import { getShape } from './shapes'

export interface Pt {
  x: number
  y: number
}

export interface Box {
  id: string
  x: number // top-left
  y: number
  w: number
  h: number
  rotation?: number // degrees clockwise about the centre
}

export type Side = 'top' | 'right' | 'bottom' | 'left'

export function nodeSize(n: Pick<MapNode, 'shape' | 'width' | 'height'>): { w: number; h: number } {
  const def = getShape(n.shape)
  return {
    w: typeof n.width === 'number' && n.width > 0 ? n.width : def.w,
    h: typeof n.height === 'number' && n.height > 0 ? n.height : def.h
  }
}

export function nodeBox(n: MapNode): Box {
  const { w, h } = nodeSize(n)
  return { id: n.id, x: n.x, y: n.y, w, h, ...(n.rotation ? { rotation: n.rotation } : {}) }
}

export function center(b: Box): Pt {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

export function boundsOf(boxes: Box[]): { x: number; y: number; w: number; h: number } {
  if (!boxes.length) return { x: 0, y: 0, w: 0, h: 0 }
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const b of boxes) {
    x1 = Math.min(x1, b.x)
    y1 = Math.min(y1, b.y)
    x2 = Math.max(x2, b.x + b.w)
    y2 = Math.max(y2, b.y + b.h)
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

export function intersects(a: Box, b: Box, pad = 0): boolean {
  return a.x - pad < b.x + b.w && a.x + a.w + pad > b.x && a.y - pad < b.y + b.h && a.y + a.h + pad > b.y
}

export function contains(outer: Box, inner: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
}

// Rotate a point about an origin by degrees clockwise.
export function rotatePt(p: Pt, o: Pt, deg: number): Pt {
  if (!deg) return p
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const dx = p.x - o.x
  const dy = p.y - o.y
  return { x: o.x + dx * c - dy * s, y: o.y + dx * s + dy * c }
}

// Parse a port id into a fractional point on the box.
//   'top' | 'right' | 'bottom' | 'left'  → side midpoints
//   'p:0.25:0'                           → explicit fraction
//   anything else / null                 → null (automatic)
export function parsePort(port: string | null | undefined): { fx: number; fy: number } | null {
  if (!port) return null
  switch (port) {
    case 'top':
      return { fx: 0.5, fy: 0 }
    case 'right':
      return { fx: 1, fy: 0.5 }
    case 'bottom':
      return { fx: 0.5, fy: 1 }
    case 'left':
      return { fx: 0, fy: 0.5 }
  }
  const m = /^p:(-?[\d.]+):(-?[\d.]+)$/.exec(port)
  if (!m) return null
  const fx = Math.min(1, Math.max(0, Number(m[1])))
  const fy = Math.min(1, Math.max(0, Number(m[2])))
  return Number.isFinite(fx) && Number.isFinite(fy) ? { fx, fy } : null
}

export function portId(fx: number, fy: number): string {
  if (fx === 0.5 && fy === 0) return 'top'
  if (fx === 1 && fy === 0.5) return 'right'
  if (fx === 0.5 && fy === 1) return 'bottom'
  if (fx === 0 && fy === 0.5) return 'left'
  return `p:${Math.round(fx * 1000) / 1000}:${Math.round(fy * 1000) / 1000}`
}

// Which side of the box a fractional point is closest to (its exit direction).
export function sideOf(fx: number, fy: number): Side {
  const d = { top: fy, bottom: 1 - fy, left: fx, right: 1 - fx }
  return (Object.entries(d).sort((a, b) => a[1] - b[1])[0]![0] as Side) ?? 'right'
}

export function portPoint(b: Box, fx: number, fy: number): Pt {
  return rotatePt({ x: b.x + fx * b.w, y: b.y + fy * b.h }, center(b), b.rotation ?? 0)
}
