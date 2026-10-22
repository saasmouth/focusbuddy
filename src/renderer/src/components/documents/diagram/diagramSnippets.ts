import { useEffect } from 'react'
import type { MapEdge, MapNode } from '@shared/types'
import type { DiagramSnippetBody, Snippet, SnippetLink, SnippetTarget } from '@shared/snippets'
import { boundsOf, nodeBox } from '@shared/diagram/geom'
import { normalizeBody } from '@shared/diagram/normalize'
import { copySelection, pasteClip, type Graph, type Sel } from '@shared/diagram/ops'
import { fresh } from '@shared/diagram/sharedRefs'
import { registerSnippetTarget } from '../../../stores/snippets'

// PlexiiDiagrams as a snippet surface: how a selection on the canvas becomes a
// saved diagram fragment, and how a saved fragment gets back onto a page.
//
// DUPLICATE ONLY, on purpose. A live diagram instance would be a node holding
// only { snippetId }, resolved from the local library on every render. Three
// things a diagram does cannot follow that reference, so it would be a Live
// option that silently froze or vanished:
//
//  - Co-editing. A shared diagram's body travels to collaborators, but snippets
//    do not sync (ORG_SNIPPETS_SYNC is false and 'snippet' is not a workspace
//    item type), so every peer would see the reference as missing.
//  - Export. Mermaid, draw.io, Visio, JSON, SVG and PNG are all written from the
//    MapBody alone (shared/diagram/mermaid.ts, drawio.ts, the main-process vsdx
//    writer). A reference node would either be dropped or have to be frozen
//    into a copy at export time, which is the duplicate under another name.
//  - Connectors. Edges join node ids on the page; the shapes inside a live
//    block would not be page nodes, so nothing could be connected to them and
//    routing, containers and layers would all treat the block as one opaque box.
//
// So the target declares `supports: ['duplicate']` and the library offers
// Duplicate alone. See docs/saved-snippets.md, "Why a diagram offers Duplicate
// only".

/**
 * Turn the canvas selection into a diagram snippet body.
 *
 * Reuses `copySelection`, so the fragment is exactly what Copy would put on the
 * clipboard: the selected shapes, every shape contained in a selected container
 * (swimlanes and frames carry their children), and only the connectors whose
 * BOTH ends are in the fragment. Positions are moved so the fragment's top-left
 * is 0,0; the destination decides where it lands.
 *
 * Returns null when no shape is selected (a connector on its own is not a
 * fragment: it has nothing to join once inserted). Pure: the graph and the
 * selection are never modified, and the body shares no object with the graph.
 */
export function diagramBodyFromSelection(g: Graph, sel: Sel): DiagramSnippetBody | null {
  const present = new Set(g.nodes.map((n) => n.id))
  const picked = new Set([...sel.nodes].filter((id) => present.has(id)))
  if (picked.size === 0) return null
  const clip = copySelection(g, { nodes: picked, edges: new Set() })
  if (clip.nodes.length === 0) return null
  const ids = new Set(clip.nodes.map((n) => n.id))
  const origin = boundsOf(clip.nodes.map(nodeBox))
  const ox = origin.x
  const oy = origin.y

  const nodes: MapNode[] = fresh(clip.nodes).map((n) => {
    const out: MapNode = { ...n, x: Math.round(n.x - ox), y: Math.round(n.y - oy) }
    // A child picked without its container keeps no pointer to a parent that is
    // not in the fragment.
    if (out.parentId && !ids.has(out.parentId)) delete out.parentId
    // A snippet is a template: a lock is about the shape where it sits, and a
    // paste drops it anyway.
    delete out.locked
    return out
  })
  const edges: MapEdge[] = fresh(clip.edges).map((e) =>
    e.waypoints ? { ...e, waypoints: e.waypoints.map((p) => ({ x: Math.round(p.x - ox), y: Math.round(p.y - oy) })) } : e
  )
  for (const e of edges) delete e.locked
  return { kind: 'diagram', nodes, edges }
}

/**
 * A default name for the save dialog: the fragment's first labelled shape, so
 * the dialog opens with something recognisable rather than empty.
 */
export function suggestedDiagramSnippetName(body: DiagramSnippetBody): string {
  for (const raw of body.nodes) {
    const label = typeof (raw as { label?: unknown }).label === 'string' ? ((raw as { label: string }).label).trim() : ''
    if (!label) continue
    const first = label.split('\n')[0]!.trim()
    const cut = first.length > 60 ? first.slice(0, 57).replace(/\s+\S*$/, '') : first
    const others = body.nodes.length - 1
    return others > 0 ? `${cut} and ${others} more` : cut
  }
  return 'Diagram fragment'
}

/**
 * Place a diagram snippet on a page as new, independent shapes.
 *
 * The body is treated as untrusted stored data and normalised first, exactly as
 * a loaded diagram is. Then it goes through `pasteClip`, so an insert is a paste
 * in every respect that matters: fresh node, edge and group ids; connectors,
 * container parents and groups remapped onto the new ids; deep copies, so the
 * page never shares an object with the snippet; and the new shapes come back as
 * the selection.
 *
 * The block is centred on `center` (snapped to `grid`) and nudged diagonally
 * while it would sit exactly on top of shapes already there, so inserting the
 * same snippet twice gives two visible copies.
 *
 * A layer is page-local: a shape whose layer does not exist on this page goes to
 * the Base layer rather than pointing at nothing. Data bindings, widget links,
 * images and custom fields are kept, because they name things outside the
 * diagram (a table, a widget) that are just as valid here.
 *
 * Returns null when the body holds no usable shape.
 */
export function placeDiagramSnippet(
  g: Graph,
  body: DiagramSnippetBody,
  center: { x: number; y: number },
  grid = 1
): { graph: Graph; sel: Sel } | null {
  const norm = normalizeBody({ nodes: body.nodes, edges: body.edges })
  if (norm.nodes.length === 0) return null
  const layers = new Set((g.layers ?? []).map((l) => l.id))
  const keepLayer = <T extends { layerId?: string }>(x: T): T => {
    if (x.layerId && !layers.has(x.layerId)) delete x.layerId
    return x
  }
  const nodes = norm.nodes.map(keepLayer)
  const edges = norm.edges.map(keepLayer)

  const b = boundsOf(nodes.map(nodeBox))
  const step = Math.max(1, grid)
  const snap = (v: number): number => Math.round(v / step) * step
  let dx = snap(center.x - b.w / 2) - b.x
  let dy = snap(center.y - b.h / 2) - b.y
  const taken = new Set(g.nodes.map((n) => `${Math.round(n.x)},${Math.round(n.y)}`))
  for (let i = 0; i < 20 && nodes.some((n) => taken.has(`${Math.round(n.x + dx)},${Math.round(n.y + dy)}`)); i++) {
    dx += 24
    dy += 24
  }
  return pasteClip(g, { marker: 'plexii-diagram/v1', nodes, edges }, { x: dx, y: dy })
}

/** What a diagram surface hands the target: how to insert, and whether it may. */
export interface DiagramSnippetHost {
  readOnly: boolean
  /** Insert the body as one undoable step and select it. False = nothing placed. */
  insertBody: (body: DiagramSnippetBody) => boolean
}

/**
 * Insert a snippet into a diagram. Returns false when it declined, which the
 * store reports rather than counting a use: a read-only (viewer) diagram, a
 * snippet that is not a diagram fragment, a mode other than duplicate, or a body
 * with nothing placeable in it.
 */
export function insertSnippetIntoDiagram(host: DiagramSnippetHost, snippet: Snippet, link: SnippetLink): boolean {
  if (host.readOnly) return false
  if (link !== 'duplicate') return false
  if (snippet.body.kind !== 'diagram') return false
  return host.insertBody(snippet.body)
}

/** The registry id for a diagram surface. One place, so host and picker agree. */
export function diagramSnippetTargetId(instanceId: string): string {
  return `diagram:${instanceId}`
}

/** The target a mounted diagram registers. Pure, so its contract is unit-testable. */
export function diagramSnippetTarget(instanceId: string, title: string | undefined, host: DiagramSnippetHost): SnippetTarget {
  const t = title?.trim()
  return {
    id: diagramSnippetTargetId(instanceId),
    label: t ? `“${t}”` : 'This diagram',
    accepts: ['diagram'],
    // See the note at the top: a diagram cannot carry a reference through
    // co-editing, export or connectors, so it honours Duplicate and says so.
    supports: ['duplicate'],
    insert: (snippet, link) => insertSnippetIntoDiagram(host, snippet, link)
  }
}

/**
 * Register the mounted diagram as an insertion target while it is editable.
 *
 * `instanceId` identifies the MOUNTED SURFACE, not the document: DiagramEditor
 * passes its React `useId`, so a diagram open in the document view and another
 * in a work widget are two destinations, and a closed one is none. A read-only
 * diagram registers nothing, so the picker never offers a viewer as a place to
 * insert (and `insert` still refuses, should the flag change underneath it).
 */
export function useDiagramSnippetTarget(
  instanceId: string,
  title: string | undefined,
  readOnly: boolean,
  insertBody: (body: DiagramSnippetBody) => boolean
): void {
  useEffect(() => {
    if (readOnly) return
    return registerSnippetTarget(diagramSnippetTarget(instanceId, title, { readOnly, insertBody }))
  }, [instanceId, title, readOnly, insertBody])
}
