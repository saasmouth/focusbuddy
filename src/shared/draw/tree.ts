// Walking the v2 scene tree: layers hold nodes, groups hold nodes. Every
// operation that has to see INSIDE groups goes through here, so "find this id"
// means the same thing everywhere and a group can never hide an object from a
// search, a hit-test or an export.

import type { DrawDoc, DrawDocVectorLayer, DrawGroupNode, DrawNode } from './model'

/** Deepest group nesting a document may have. Deeper input is cut off at load (see normalize). */
export const MAX_GROUP_DEPTH = 64

export function vectorLayersOf(doc: DrawDoc): DrawDocVectorLayer[] {
  return doc.layers.filter((l): l is DrawDocVectorLayer => l.kind === 'vector')
}

export function isGroup(n: DrawNode): n is DrawGroupNode {
  return n.type === 'group'
}

/** Visit every node depth-first in paint order; `parents` is the group chain above it. */
export function walkNodes(nodes: DrawNode[], visit: (n: DrawNode, parents: DrawGroupNode[]) => void, parents: DrawGroupNode[] = []): void {
  for (const n of nodes) {
    visit(n, parents)
    if (n.type === 'group') walkNodes(n.children, visit, [...parents, n])
  }
}

/** Every node in the document, groups and their contents included. */
export function allNodes(doc: DrawDoc): Array<{ layerId: string; node: DrawNode; parents: DrawGroupNode[] }> {
  const out: Array<{ layerId: string; node: DrawNode; parents: DrawGroupNode[] }> = []
  for (const l of vectorLayersOf(doc)) walkNodes(l.objects, (node, parents) => out.push({ layerId: l.id, node, parents }), [])
  return out
}

/** A node anywhere in the tree, with the layer and the groups above it. */
export function findNode(doc: DrawDoc, id: string): { layerId: string; node: DrawNode; parents: DrawGroupNode[] } | undefined {
  for (const l of vectorLayersOf(doc)) {
    let hit: { layerId: string; node: DrawNode; parents: DrawGroupNode[] } | undefined
    walkNodes(l.objects, (node, parents) => {
      if (!hit && node.id === id) hit = { layerId: l.id, node, parents }
    })
    if (hit) return hit
  }
  return undefined
}

/**
 * Replace nodes anywhere in the tree. `fn` returns the node unchanged (same
 * identity) to leave it alone; untouched branches keep their identity, so a
 * memoised renderer redraws only what changed.
 */
export function mapNodesDeep(nodes: DrawNode[], fn: (n: DrawNode) => DrawNode): DrawNode[] {
  let changed = false
  const out = nodes.map((n) => {
    let next = fn(n)
    if (next.type === 'group') {
      const children = mapNodesDeep(next.children, fn)
      if (children !== next.children) next = { ...next, children }
    }
    if (next !== n) changed = true
    return next
  })
  return changed ? out : nodes
}

/** Every id in the document, for minting fresh ones and checking uniqueness. */
export function allIds(doc: DrawDoc): Set<string> {
  const ids = new Set<string>()
  for (const l of doc.layers) ids.add(l.id)
  for (const { node } of allNodes(doc)) ids.add(node.id)
  for (const a of doc.artboards) ids.add(a.id)
  return ids
}

/** How deep the deepest group goes (0 for no groups). */
export function groupDepth(nodes: DrawNode[]): number {
  let max = 0
  for (const n of nodes) if (n.type === 'group') max = Math.max(max, 1 + groupDepth(n.children))
  return max
}
