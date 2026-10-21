// Object lifecycle on a v2 document: find, add, change, delete, duplicate,
// move, scale. Pure functions; unchanged branches keep their identity.
//
// Ids address nodes ANYWHERE in the tree (a group's members included), so a
// later direct-selection or isolation mode can edit inside groups through the
// same calls. Phase 0's selection only ever holds top-level ids.

import { drawId } from '../../draw'
import { applyMatrix, type Box } from '../../drawGeometry'
import type { DrawDoc, DrawDocVectorLayer, DrawGroupNode, DrawNode } from '../model'
import { findNode, mapNodesDeep, vectorLayersOf } from '../tree'
import { clipShapeOf, translateNode } from './geometry'
import { allPlaces, containerOf, invertMatrix, moveNodesWorld, parentMatrix, scaleNodesWorld, withChildren } from './groups'

/** The layer a node lives on (at any depth), or undefined when the id is unknown. */
export function layerOf(doc: DrawDoc, id: string): DrawDocVectorLayer | undefined {
  const hit = findNode(doc, id)
  return hit ? (doc.layers.find((l) => l.id === hit.layerId) as DrawDocVectorLayer) : undefined
}

export function getObject(doc: DrawDoc, id: string): DrawNode | undefined {
  return findNode(doc, id)?.node
}

/** The nodes for `ids`, in paint order (bottom first), each once. */
export function getObjects(doc: DrawDoc, ids: string[]): DrawNode[] {
  const wanted = new Set(ids)
  const out: DrawNode[] = []
  for (const l of vectorLayersOf(doc)) {
    const visit = (nodes: DrawNode[]): void => {
      for (const n of nodes) {
        if (wanted.has(n.id)) out.push(n)
        else if (n.type === 'group') visit(n.children)
      }
    }
    visit(l.objects)
  }
  return out
}

/**
 * The ids the user may act on: on a visible, unlocked layer; not hidden, not
 * locked, and not inside a hidden or locked group; and not opaque (made by a
 * newer PlexiiDraw, which this build cannot edit without damaging it).
 */
export function editableIds(doc: DrawDoc, ids: string[]): string[] {
  const wanted = new Set(ids)
  const out: string[] = []
  for (const l of vectorLayersOf(doc)) {
    if (l.locked || !l.visible) continue
    const visit = (nodes: DrawNode[], blocked: boolean): void => {
      for (const n of nodes) {
        const off = blocked || n.locked === true || n.hidden === true
        if (wanted.has(n.id) && !off && n.type !== 'opaque') out.push(n.id)
        if (n.type === 'group') visit(n.children, off)
      }
    }
    visit(l.objects, false)
  }
  return out
}

/**
 * What "Select all" picks: every top-level node on a visible, unlocked layer
 * that is neither hidden nor locked nor opaque.
 */
export function selectableObjectIds(doc: DrawDoc): string[] {
  const out: string[] = []
  for (const l of vectorLayersOf(doc)) {
    if (!l.visible || l.locked) continue
    for (const n of l.objects) if (!n.hidden && !n.locked && n.type !== 'opaque') out.push(n.id)
  }
  return out
}

/** Every top-level node with its layer, bottom layer first. */
export function allObjects(doc: DrawDoc): Array<{ layerId: string; object: DrawNode }> {
  const out: Array<{ layerId: string; object: DrawNode }> = []
  for (const l of vectorLayersOf(doc)) for (const o of l.objects) out.push({ layerId: l.id, object: o })
  return out
}

/**
 * Add a node to a layer. A raster (or missing, or locked) target falls back to
 * the topmost editable vector layer, and if there is none a fresh layer is made
 * -- so a draw gesture can never silently go nowhere.
 */
export function addObject(doc: DrawDoc, node: DrawNode, layerId?: string): DrawDoc {
  const vectors = vectorLayersOf(doc)
  const target = vectors.find((l) => l.id === layerId && !l.locked) ?? [...vectors].reverse().find((l) => !l.locked)
  if (!target) {
    const fresh: DrawDocVectorLayer = {
      id: drawId('lyr'),
      kind: 'vector',
      name: `Layer ${doc.layers.length + 1}`,
      visible: true,
      locked: false,
      opacity: 1,
      blend: 'normal',
      objects: [node]
    }
    return { ...doc, layers: [...doc.layers, fresh], activeLayerId: fresh.id }
  }
  return {
    ...doc,
    activeLayerId: target.id,
    layers: doc.layers.map((l) => (l.id === target.id ? { ...target, objects: [...target.objects, node] } : l))
  }
}

/** Change the nodes with these ids, wherever they are; everything else keeps its identity. */
export function mapObjects(doc: DrawDoc, ids: string[], fn: (n: DrawNode) => DrawNode): DrawDoc {
  const wanted = new Set(ids)
  return {
    ...doc,
    layers: doc.layers.map((l) => (l.kind === 'vector' ? { ...l, objects: mapNodesDeep(l.objects, (n) => (wanted.has(n.id) ? fn(n) : n)) } : l))
  }
}

export function mapObject(doc: DrawDoc, id: string, fn: (n: DrawNode) => DrawNode): DrawDoc {
  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.kind !== 'vector') return l
      const objects = mapNodesDeep(l.objects, (n) => (n.id === id ? fn(n) : n))
      return objects === l.objects ? l : { ...l, objects }
    })
  }
}

function removeDeep(nodes: DrawNode[], wanted: Set<string>): DrawNode[] {
  return nodes
    .filter((n) => !wanted.has(n.id))
    .map((n) => (n.type === 'group' ? ({ ...n, children: removeDeep(n.children, wanted) } as DrawGroupNode) : n))
}

export function deleteObjects(doc: DrawDoc, ids: string[]): DrawDoc {
  const wanted = new Set(ids)
  return {
    ...doc,
    layers: doc.layers.map((l) => (l.kind === 'vector' ? { ...l, objects: removeDeep(l.objects, wanted) } : l))
  }
}

/**
 * A copy of a node with a fresh id -- and fresh ids for every member of a group.
 *
 * DEEP, not `{ ...n }`: a shallow copy left the duplicate sharing the original's
 * fill, stroke, gradient and dash objects by reference. The IPC payload check
 * then saw the same object twice and refused every save of that drawing as
 * "cyclic data", and an in-place paint edit would have changed both shapes.
 */
function cloneWithNewIds(n: DrawNode): DrawNode {
  const id = drawId('obj')
  if (n.type === 'group') {
    const { children, ...rest } = n
    return { ...structuredClone(rest), id, children: children.map(cloneWithNewIds) }
  }
  return { ...structuredClone(n), id }
}

/** Copies of the nodes `ids`, offset by (dx, dy) on screen, placed directly above the originals' layer stack (or group). */
export function duplicateObjects(doc: DrawDoc, ids: string[], dx = 12, dy = 12): { doc: DrawDoc; newIds: string[] } {
  const wanted = new Set(ids)
  const newIds: string[] = []
  const layers = doc.layers.map((l) => {
    if (l.kind !== 'vector') return l
    const copies: DrawNode[] = []
    for (const o of l.objects) {
      if (!wanted.has(o.id) || o.type === 'opaque') continue
      const copy = cloneWithNewIds(o)
      newIds.push(copy.id)
      copies.push(translateNode({ ...copy, name: o.name ? `${o.name} copy` : undefined } as DrawNode, dx, dy))
    }
    return copies.length ? { ...l, objects: [...l.objects, ...copies] } : l
  })
  // Members of groups (selected in isolation mode, with Group Selection or
  // Edit Contents) are copied inside their own group, on top of its members
  // (under a clip path), offset on screen by the same (dx, dy).
  let next: DrawDoc = { ...doc, layers }
  const nested = allPlaces(doc).filter((p) => p.parents.length > 0 && wanted.has(p.node.id) && p.node.type !== 'opaque' && !p.parents.some((g) => wanted.has(g.id)))
  for (const p of nested) {
    const m = parentMatrix(p.parents)
    const inv = invertMatrix([m[0], m[1], m[2], m[3], 0, 0])
    const d = inv ? applyMatrix(inv, { x: dx, y: dy }) : { x: dx, y: dy }
    const copy = translateNode({ ...cloneWithNewIds(p.node), name: p.node.name ? `${p.node.name} copy` : undefined } as DrawNode, d.x, d.y)
    newIds.push(copy.id)
    const g = p.parents[p.parents.length - 1]
    const clipped = clipShapeOf(g) !== null
    next = withChildren(next, containerOf(p), (children) => (clipped ? [...children.slice(0, -1), copy, children[children.length - 1]] : [...children, copy]))
  }
  return { doc: next, newIds }
}

/** Move nodes by (dx, dy) on the artboard -- inside a transformed group too (see groups.ts). */
export function moveObjects(doc: DrawDoc, ids: string[], dx: number, dy: number): DrawDoc {
  return moveNodesWorld(doc, ids, dx, dy)
}

/**
 * Scale nodes so the box they occupy becomes `to` -- the selection handles. A
 * multi-node selection resizes as one unit, exactly as a single node does.
 */
export function scaleObjects(doc: DrawDoc, ids: string[], from: Box, to: Box): DrawDoc {
  // Artboard-space boxes; a member of a transformed group is scaled through
  // the group's matrix so it follows the handles on screen (see groups.ts).
  return scaleNodesWorld(doc, ids, from, to)
}

/** The visible bounds of a set of nodes (opaque ones, which have no geometry here, left out). */
export { nodesBounds as objectsBounds } from './geometry'
