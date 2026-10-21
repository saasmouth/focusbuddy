// Z-order, alignment and distribution on a v2 document. Groups move as units;
// locked, hidden and opaque nodes are never moved, whatever the selection says.

import type { Box } from '../../drawGeometry'
import type { DrawDoc, DrawNode } from '../model'
import { primaryArtboard } from './artboards'
import { nodeBounds, nodesBounds, translateNode } from './geometry'
import { editableIds, getObjects, mapObjects } from './objects'

export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type ArrangeDir = 'front' | 'forward' | 'backward' | 'back'

/** Bring to front / forward, send backward / to back, within each layer. */
export function arrange(doc: DrawDoc, ids: string[], dir: ArrangeDir): DrawDoc {
  const wanted = new Set(editableIds(doc, ids))
  if (wanted.size === 0) return doc
  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.kind !== 'vector') return l
      const picked = l.objects.filter((o) => wanted.has(o.id))
      if (picked.length === 0) return l
      const rest = l.objects.filter((o) => !wanted.has(o.id))
      if (dir === 'front') return { ...l, objects: [...rest, ...picked] }
      if (dir === 'back') return { ...l, objects: [...picked, ...rest] }
      // One step: walk the array and swap each selected item past its neighbour.
      const next = l.objects.slice()
      if (dir === 'forward') {
        for (let i = next.length - 2; i >= 0; i--) {
          if (wanted.has(next[i].id) && !wanted.has(next[i + 1].id)) [next[i], next[i + 1]] = [next[i + 1], next[i]]
        }
      } else {
        for (let i = 1; i < next.length; i++) {
          if (wanted.has(next[i].id) && !wanted.has(next[i - 1].id)) [next[i], next[i - 1]] = [next[i - 1], next[i]]
        }
      }
      return { ...l, objects: next }
    })
  }
}

/**
 * Align to the selection's own bounding box -- or, with a single node
 * selected, to the (first) artboard. Locked and hidden nodes never move.
 */
export function alignObjects(doc: DrawDoc, allIds: string[], edge: AlignEdge): DrawDoc {
  const ids = editableIds(doc, allIds)
  const objs = getObjects(doc, ids)
  if (objs.length === 0) return doc
  const board = primaryArtboard(doc)
  const frame: Box = objs.length === 1 ? { x: board.x, y: board.y, w: board.w, h: board.h } : nodesBounds(objs)
  return mapObjects(doc, ids, (o: DrawNode) => {
    const b = nodeBounds(o)
    switch (edge) {
      case 'left':
        return translateNode(o, frame.x - b.x, 0)
      case 'right':
        return translateNode(o, frame.x + frame.w - (b.x + b.w), 0)
      case 'center':
        return translateNode(o, frame.x + frame.w / 2 - (b.x + b.w / 2), 0)
      case 'top':
        return translateNode(o, 0, frame.y - b.y)
      case 'bottom':
        return translateNode(o, 0, frame.y + frame.h - (b.y + b.h))
      default:
        return translateNode(o, 0, frame.y + frame.h / 2 - (b.y + b.h / 2))
    }
  })
}

/** Even gaps between three or more nodes along one axis. */
export function distributeObjects(doc: DrawDoc, allIds: string[], axis: 'h' | 'v'): DrawDoc {
  const ids = editableIds(doc, allIds)
  const objs = getObjects(doc, ids)
  if (objs.length < 3) return doc
  const sorted = objs.map((o) => ({ o, b: nodeBounds(o) })).sort((a, b) => (axis === 'h' ? a.b.x - b.b.x : a.b.y - b.b.y))
  const first = sorted[0].b
  const last = sorted[sorted.length - 1].b
  const span = axis === 'h' ? last.x + last.w - first.x : last.y + last.h - first.y
  const used = sorted.reduce((sum, s) => sum + (axis === 'h' ? s.b.w : s.b.h), 0)
  const gap = (span - used) / (sorted.length - 1)
  let cursor = axis === 'h' ? first.x : first.y
  const shifts = new Map<string, number>()
  for (const s of sorted) {
    shifts.set(s.o.id, cursor - (axis === 'h' ? s.b.x : s.b.y))
    cursor += (axis === 'h' ? s.b.w : s.b.h) + gap
  }
  return mapObjects(doc, ids, (o) => {
    const d = shifts.get(o.id) ?? 0
    return axis === 'h' ? translateNode(o, d, 0) : translateNode(o, 0, d)
  })
}
