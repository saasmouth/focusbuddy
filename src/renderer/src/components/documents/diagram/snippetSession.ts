import type { MapBody, MapEdge, MapNode } from '@shared/types'
import type { DiagramSnippetBody } from '@shared/snippets'
import { boundsOf, nodeBox } from '@shared/diagram/geom'
import { normalizeMapBody } from '@shared/mapGraph'

// A diagram snippet opened in PlexiiDiagrams (SnippetEditSessionView's
// registry, "Open original"). A DiagramSnippetBody {nodes, edges} IS a
// MapBody's first page, so wrapping invents no container: the graph goes in
// as page one, the editor runs with singlePage (a snippet is one graph, so a
// second page would have nowhere to go), and unwrapping reads page one back.
//
// Unwrapping keeps the snippet's own contract, the one capture
// (diagramBodyFromSelection) sets: positions relative to the fragment's
// top-left, so a placement lands where it is dropped. Ids are kept, so saving
// an unchanged session writes back the same body.

/** {nodes, edges} → a one-page MapBody for DiagramEditor. */
export function wrapDiagramSnippet(body: DiagramSnippetBody): MapBody {
  return normalizeMapBody({ version: 1, nodes: body.nodes, edges: body.edges })
}

/** DiagramEditor's body → the snippet: page one, moved to the fragment's top-left. */
export function unwrapDiagramSnippet(doc: MapBody): DiagramSnippetBody {
  const nodes = (doc.nodes ?? []) as MapNode[]
  const edges = (doc.edges ?? []) as MapEdge[]
  if (nodes.length === 0) return { kind: 'diagram', nodes: [], edges: [] }
  const origin = boundsOf(nodes.map(nodeBox))
  const ox = origin.x
  const oy = origin.y
  if (ox === 0 && oy === 0) return { kind: 'diagram', nodes, edges }
  return {
    kind: 'diagram',
    nodes: nodes.map((n) => ({ ...n, x: Math.round(n.x - ox), y: Math.round(n.y - oy) })),
    edges: edges.map((e) =>
      e.waypoints ? { ...e, waypoints: e.waypoints.map((p) => ({ x: Math.round(p.x - ox), y: Math.round(p.y - oy) })) } : e
    )
  }
}
