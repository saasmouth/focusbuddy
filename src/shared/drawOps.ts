// PlexiDraw operations — every edit the studio can make to a document, as pure
// functions over DrawBody. The editor component owns pointers, panels and undo
// history; it owns no geometry and no mutation logic, which is why all of this
// can be tested without a DOM and why undo is simply "keep the previous body".

import {
  activeLayer,
  drawId,
  objectBounds,
  objectsBounds,
  shapePath,
  type DrawBody,
  type DrawLayer,
  type DrawObject,
  type DrawPathObject,
  type DrawVectorLayer
} from './draw'
import { booleanPath, fitPathToBox, transformPath, type BooleanOp, type Box } from './drawGeometry'

export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type ArrangeDir = 'front' | 'forward' | 'backward' | 'back'

function vectorLayers(body: DrawBody): DrawVectorLayer[] {
  return body.layers.filter((l): l is DrawVectorLayer => l.kind === 'vector')
}

/** The layer an object lives on, or undefined when the id is unknown. */
export function layerOf(body: DrawBody, objectId: string): DrawVectorLayer | undefined {
  return vectorLayers(body).find((l) => l.objects.some((o) => o.id === objectId))
}

export function getObject(body: DrawBody, objectId: string): DrawObject | undefined {
  for (const l of vectorLayers(body)) {
    const o = l.objects.find((x) => x.id === objectId)
    if (o) return o
  }
  return undefined
}

export function getObjects(body: DrawBody, ids: string[]): DrawObject[] {
  const wanted = new Set(ids)
  const out: DrawObject[] = []
  for (const l of vectorLayers(body)) for (const o of l.objects) if (wanted.has(o.id)) out.push(o)
  return out
}

/** Objects the user may actually act on: not hidden, not locked, on an editable layer. */
export function editableIds(body: DrawBody, ids: string[]): string[] {
  const out: string[] = []
  for (const l of vectorLayers(body)) {
    if (l.locked || !l.visible) continue
    for (const o of l.objects) if (ids.includes(o.id) && !o.locked && !o.hidden) out.push(o.id)
  }
  return out
}

// ── Object lifecycle ─────────────────────────────────────────────────────────

/**
 * Add an object to a layer. A raster (or missing, or locked) target falls back
 * to the topmost editable vector layer, and if there is none a fresh layer is
 * made — so a draw gesture can never silently go nowhere.
 */
export function addObject(body: DrawBody, obj: DrawObject, layerId?: string): DrawBody {
  const target =
    body.layers.find((l): l is DrawVectorLayer => l.id === layerId && l.kind === 'vector' && !l.locked) ??
    [...vectorLayers(body)].reverse().find((l) => !l.locked)
  if (!target) {
    const fresh: DrawVectorLayer = {
      id: drawId('lyr'),
      kind: 'vector',
      name: `Layer ${body.layers.length + 1}`,
      visible: true,
      locked: false,
      opacity: 1,
      blend: 'normal',
      objects: [obj]
    }
    return { ...body, layers: [...body.layers, fresh], activeLayerId: fresh.id }
  }
  return {
    ...body,
    activeLayerId: target.id,
    layers: body.layers.map((l) => (l.id === target.id ? { ...target, objects: [...target.objects, obj] } : l))
  }
}

export function mapObject(body: DrawBody, id: string, fn: (o: DrawObject) => DrawObject): DrawBody {
  return {
    ...body,
    layers: body.layers.map((l) =>
      l.kind === 'vector' && l.objects.some((o) => o.id === id) ? { ...l, objects: l.objects.map((o) => (o.id === id ? fn(o) : o)) } : l
    )
  }
}

export function mapObjects(body: DrawBody, ids: string[], fn: (o: DrawObject) => DrawObject): DrawBody {
  const wanted = new Set(ids)
  return {
    ...body,
    layers: body.layers.map((l) => (l.kind === 'vector' ? { ...l, objects: l.objects.map((o) => (wanted.has(o.id) ? fn(o) : o)) } : l))
  }
}

export function deleteObjects(body: DrawBody, ids: string[]): DrawBody {
  const wanted = new Set(ids)
  return {
    ...body,
    layers: body.layers.map((l) => (l.kind === 'vector' ? { ...l, objects: l.objects.filter((o) => !wanted.has(o.id)) } : l))
  }
}

export function duplicateObjects(body: DrawBody, ids: string[], dx = 12, dy = 12): { body: DrawBody; newIds: string[] } {
  const wanted = new Set(ids)
  const newIds: string[] = []
  const layers = body.layers.map((l) => {
    if (l.kind !== 'vector') return l
    const copies: DrawObject[] = []
    for (const o of l.objects) {
      if (!wanted.has(o.id)) continue
      const id = drawId('obj')
      newIds.push(id)
      copies.push(offsetObject({ ...o, id, name: o.name ? `${o.name} copy` : undefined }, dx, dy))
    }
    return copies.length ? { ...l, objects: [...l.objects, ...copies] } : l
  })
  return { body: { ...body, layers }, newIds }
}

function offsetObject(o: DrawObject, dx: number, dy: number): DrawObject {
  if (o.type === 'path') return { ...o, path: transformPath(o.path, [1, 0, 0, 1, dx, dy]) }
  return { ...o, x: o.x + dx, y: o.y + dy }
}

export function moveObjects(body: DrawBody, ids: string[], dx: number, dy: number): DrawBody {
  return mapObjects(body, ids, (o) => offsetObject(o, dx, dy))
}

/**
 * Scale a set of objects so the box they occupy becomes `to`. Used by the
 * selection handles, so a multi-object selection resizes as one unit exactly
 * the way a single object does.
 */
export function scaleObjects(body: DrawBody, ids: string[], from: Box, to: Box): DrawBody {
  const sx = from.w > 1e-6 ? to.w / from.w : 1
  const sy = from.h > 1e-6 ? to.h / from.h : 1
  const e = to.x - from.x * sx
  const f = to.y - from.y * sy
  return mapObjects(body, ids, (o) => {
    if (o.type === 'path') return { ...o, path: transformPath(o.path, [sx, 0, 0, sy, e, f]) }
    const b = objectBounds(o)
    const nx = b.x * sx + e
    const ny = b.y * sy + f
    if (o.type === 'image') return { ...o, x: nx, y: ny, w: Math.max(1, b.w * sx), h: Math.max(1, b.h * sy) }
    // Scaling text scales its point size with the vertical factor, which is what
    // makes dragging a corner feel like resizing the words rather than the box.
    return { ...o, x: nx, y: ny, w: Math.max(8, b.w * sx), fontSize: Math.max(1, o.fontSize * sy) }
  })
}

// ── Z-order ──────────────────────────────────────────────────────────────────

export function arrange(body: DrawBody, ids: string[], dir: ArrangeDir): DrawBody {
  const wanted = new Set(ids)
  return {
    ...body,
    layers: body.layers.map((l) => {
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
          if (wanted.has(next[i].id) && !wanted.has(next[i + 1].id)) {
            ;[next[i], next[i + 1]] = [next[i + 1], next[i]]
          }
        }
      } else {
        for (let i = 1; i < next.length; i++) {
          if (wanted.has(next[i].id) && !wanted.has(next[i - 1].id)) {
            ;[next[i], next[i - 1]] = [next[i - 1], next[i]]
          }
        }
      }
      return { ...l, objects: next }
    })
  }
}

// ── Align & distribute ───────────────────────────────────────────────────────

/**
 * Align to the selection's own bounding box — or, with a single object
 * selected, to the artboard, which is how every editor behaves and saves a
 * "centre this on the page" from needing its own command.
 */
export function alignObjects(body: DrawBody, ids: string[], edge: AlignEdge): DrawBody {
  const objs = getObjects(body, ids)
  if (objs.length === 0) return body
  const frame: Box = objs.length === 1 ? { x: 0, y: 0, w: body.width, h: body.height } : objectsBounds(objs)
  return mapObjects(body, ids, (o) => {
    const b = objectBounds(o)
    switch (edge) {
      case 'left':
        return offsetObject(o, frame.x - b.x, 0)
      case 'right':
        return offsetObject(o, frame.x + frame.w - (b.x + b.w), 0)
      case 'center':
        return offsetObject(o, frame.x + frame.w / 2 - (b.x + b.w / 2), 0)
      case 'top':
        return offsetObject(o, 0, frame.y - b.y)
      case 'bottom':
        return offsetObject(o, 0, frame.y + frame.h - (b.y + b.h))
      default:
        return offsetObject(o, 0, frame.y + frame.h / 2 - (b.y + b.h / 2))
    }
  })
}

/** Even gaps between three or more objects along one axis. */
export function distributeObjects(body: DrawBody, ids: string[], axis: 'h' | 'v'): DrawBody {
  const objs = getObjects(body, ids)
  if (objs.length < 3) return body
  const sorted = objs
    .map((o) => ({ o, b: objectBounds(o) }))
    .sort((a, b) => (axis === 'h' ? a.b.x - b.b.x : a.b.y - b.b.y))
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
  return mapObjects(body, ids, (o) => {
    const d = shifts.get(o.id) ?? 0
    return axis === 'h' ? offsetObject(o, d, 0) : offsetObject(o, 0, d)
  })
}

// ── Booleans & path ops ──────────────────────────────────────────────────────

/**
 * Combine two or more selected paths. The result inherits the appearance of the
 * BOTTOM-most operand, matching Illustrator's Pathfinder: what you keep looks
 * like the shape you started from, not like the cutter you threw away.
 *
 * Non-path objects in the selection are left untouched rather than silently
 * discarded — a boolean has no meaning for a photo or a text frame.
 */
export function booleanObjects(body: DrawBody, ids: string[], op: BooleanOp): { body: DrawBody; newId: string | null } {
  const ordered: DrawPathObject[] = []
  for (const l of vectorLayers(body)) for (const o of l.objects) if (ids.includes(o.id) && o.type === 'path') ordered.push(o)
  if (ordered.length < 2) return { body, newId: null }

  const base = ordered[0]
  let path = base.path
  for (let i = 1; i < ordered.length; i++) path = booleanPath(path, ordered[i].path, op)
  if (path.subpaths.length === 0) {
    // A subtraction that consumes the shape entirely is a real outcome: remove
    // the operands rather than leaving an invisible empty object behind.
    return { body: deleteObjects(body, ordered.map((o) => o.id)), newId: null }
  }

  const layer = layerOf(body, base.id)
  const newId = drawId('obj')
  const combined: DrawPathObject = {
    ...base,
    id: newId,
    path,
    shapeKind: 'path',
    name: base.name,
    cornerRadius: undefined,
    sides: undefined,
    innerRatio: undefined
  }
  const cleared = deleteObjects(body, ordered.map((o) => o.id))
  return { body: addObject(cleared, combined, layer?.id), newId }
}

/** Reverse every subpath's direction — flips which side a hole cuts from. */
export function reversePath(body: DrawBody, id: string): DrawBody {
  return mapObject(body, id, (o) => {
    if (o.type !== 'path') return o
    return {
      ...o,
      path: {
        ...o.path,
        subpaths: o.path.subpaths.map((sp) => ({
          closed: sp.closed,
          nodes: sp.nodes
            .slice()
            .reverse()
            .map((n) => ({ x: n.x, y: n.y, ...(n.outX != null ? { inX: n.outX, inY: n.outY } : {}), ...(n.inX != null ? { outX: n.inX, outY: n.inY } : {}) }))
        }))
      }
    }
  })
}

export function setPathClosed(body: DrawBody, id: string, closed: boolean): DrawBody {
  return mapObject(body, id, (o) =>
    o.type === 'path' ? { ...o, path: { ...o.path, subpaths: o.path.subpaths.map((sp) => ({ ...sp, closed })) } } : o
  )
}

/** Merge several paths into one multi-subpath object, without a boolean. */
export function joinPaths(body: DrawBody, ids: string[]): { body: DrawBody; newId: string | null } {
  const ordered: DrawPathObject[] = []
  for (const l of vectorLayers(body)) for (const o of l.objects) if (ids.includes(o.id) && o.type === 'path') ordered.push(o)
  if (ordered.length < 2) return { body, newId: null }
  const base = ordered[0]
  const newId = drawId('obj')
  const merged: DrawPathObject = {
    ...base,
    id: newId,
    shapeKind: 'path',
    path: { fillRule: 'evenodd', subpaths: ordered.flatMap((o) => o.path.subpaths) }
  }
  const layer = layerOf(body, base.id)
  const cleared = deleteObjects(body, ordered.map((o) => o.id))
  return { body: addObject(cleared, merged, layer?.id), newId }
}

/** Resize one live shape's geometry from its parameters (radius, points…). */
export function reshape(body: DrawBody, id: string, patch: { cornerRadius?: number; sides?: number; innerRatio?: number }): DrawBody {
  const target = getObject(body, id)
  // Only a shape that still remembers how it was made can be re-derived. Once a
  // boolean or a node edit has changed the geometry there are no parameters left
  // to change, so this returns the body untouched — identity included, so an
  // unchanged document never lands on the undo stack.
  if (!target || target.type !== 'path' || !target.shapeKind || target.shapeKind === 'path' || target.shapeKind === 'pen' || target.shapeKind === 'pencil') {
    return body
  }
  // The new geometry is refitted into the CURRENT bounding box, so changing a
  // star's point count (whose natural extents differ per count) keeps the shape
  // exactly where it sits instead of nudging it each time.
  const box = objectBounds(target)
  return mapObject(body, id, (o) => {
    if (o.type !== 'path' || !o.shapeKind) return o
    const next = { ...o, ...patch }
    return { ...next, path: fitPathToBox(shapePath(o.shapeKind, box, next), box) }
  })
}

// ── Layers ───────────────────────────────────────────────────────────────────

export function addLayer(body: DrawBody, layer: DrawLayer, aboveLayerId?: string): DrawBody {
  const at = aboveLayerId ? body.layers.findIndex((l) => l.id === aboveLayerId) : body.layers.length - 1
  const layers = body.layers.slice()
  layers.splice(at + 1, 0, layer)
  return { ...body, layers, activeLayerId: layer.id }
}

/** Remove a layer. The last remaining layer is never removed — there must always be somewhere to draw. */
export function removeLayer(body: DrawBody, id: string): DrawBody {
  if (body.layers.length <= 1) return body
  const layers = body.layers.filter((l) => l.id !== id)
  const activeLayerId = body.activeLayerId === id ? layers[layers.length - 1].id : body.activeLayerId
  return { ...body, layers, activeLayerId }
}

export function moveLayer(body: DrawBody, id: string, delta: number): DrawBody {
  const i = body.layers.findIndex((l) => l.id === id)
  if (i < 0) return body
  const j = Math.max(0, Math.min(body.layers.length - 1, i + delta))
  if (i === j) return body
  const layers = body.layers.slice()
  const [moved] = layers.splice(i, 1)
  layers.splice(j, 0, moved)
  return { ...body, layers }
}

export function patchLayer(body: DrawBody, id: string, patch: Partial<Omit<DrawLayer, 'kind' | 'id'>>): DrawBody {
  return { ...body, layers: body.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as DrawLayer) : l)) }
}

export function duplicateLayer(body: DrawBody, id: string): DrawBody {
  const l = body.layers.find((x) => x.id === id)
  if (!l) return body
  const copy: DrawLayer =
    l.kind === 'vector'
      ? { ...l, id: drawId('lyr'), name: `${l.name} copy`, objects: l.objects.map((o) => ({ ...o, id: drawId('obj') })) }
      : { ...l, id: drawId('lyr'), name: `${l.name} copy` }
  return addLayer(body, copy, id)
}

/**
 * Merge a vector layer into the vector layer below it. Raster merges need real
 * pixels and therefore a canvas, so they are done in the editor and are not
 * attempted here — this returns the body unchanged rather than pretending.
 */
export function mergeVectorLayerDown(body: DrawBody, id: string): DrawBody {
  const i = body.layers.findIndex((l) => l.id === id)
  if (i <= 0) return body
  const upper = body.layers[i]
  const lower = body.layers[i - 1]
  if (upper.kind !== 'vector' || lower.kind !== 'vector') return body
  const merged: DrawVectorLayer = { ...lower, objects: [...lower.objects, ...upper.objects] }
  const layers = body.layers.filter((l) => l.id !== id).map((l) => (l.id === lower.id ? merged : l))
  return { ...body, layers, activeLayerId: lower.id }
}

/** The layer new work should land on, guaranteed to exist. */
export function targetLayerId(body: DrawBody): string {
  return activeLayer(body)?.id ?? body.layers[body.layers.length - 1].id
}
