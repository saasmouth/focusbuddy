// Multi-page helpers. The first page is the body's own nodes/edges/layers (so
// every existing reader of body.nodes keeps working); pages 2..n live in
// body.pages. These read and write one page without disturbing the others.

import type { MapBody, MapPage } from '../types'
import type { Graph } from './ops'

export interface PageInfo {
  id: string
  name: string
}

export const FIRST_PAGE_ID = 'page-1'

export function pageList(b: MapBody): PageInfo[] {
  return [{ id: FIRST_PAGE_ID, name: b.pageName || 'Page 1' }, ...(b.pages ?? []).map((p) => ({ id: p.id, name: p.name }))]
}

export function getPage(b: MapBody, idx: number): Graph & { viewport?: MapBody['viewport'] } {
  if (idx <= 0 || !b.pages?.[idx - 1]) return { nodes: b.nodes, edges: b.edges, layers: b.layers, viewport: b.viewport }
  const p = b.pages[idx - 1]!
  return { nodes: p.nodes, edges: p.edges, layers: p.layers, viewport: p.viewport }
}

export function withPage(b: MapBody, idx: number, g: Graph & { viewport?: MapBody['viewport'] }): MapBody {
  if (idx <= 0 || !b.pages?.[idx - 1]) {
    const out: MapBody = { ...b, nodes: g.nodes, edges: g.edges }
    if (g.layers?.length) out.layers = g.layers
    else delete out.layers
    if (g.viewport) out.viewport = g.viewport
    return out
  }
  const pages = [...b.pages]
  const cur = pages[idx - 1]!
  const next: MapPage = { ...cur, nodes: g.nodes, edges: g.edges }
  if (g.layers?.length) next.layers = g.layers
  else delete next.layers
  if (g.viewport) next.viewport = g.viewport
  pages[idx - 1] = next
  return { ...b, pages }
}

export function addPage(b: MapBody, name: string, id: string, graph?: Graph): { body: MapBody; index: number } {
  const page: MapPage = { id, name, nodes: graph?.nodes ?? [], edges: graph?.edges ?? [], ...(graph?.layers?.length ? { layers: graph.layers } : {}) }
  const pages = [...(b.pages ?? []), page]
  return { body: { ...b, pages }, index: pages.length }
}

export function renamePage(b: MapBody, idx: number, name: string): MapBody {
  const clean = name.trim().slice(0, 120) || (idx === 0 ? 'Page 1' : `Page ${idx + 1}`)
  if (idx <= 0) return { ...b, pageName: clean }
  const pages = [...(b.pages ?? [])]
  if (!pages[idx - 1]) return b
  pages[idx - 1] = { ...pages[idx - 1]!, name: clean }
  return { ...b, pages }
}

// Removing page 1 promotes page 2 into the body's own slot.
export function deletePage(b: MapBody, idx: number): MapBody {
  const pages = [...(b.pages ?? [])]
  if (!pages.length) return b // never delete the only page
  if (idx <= 0) {
    const [next, ...rest] = pages
    const out: MapBody = { ...b, nodes: next!.nodes, edges: next!.edges, pageName: next!.name, pages: rest.length ? rest : undefined }
    if (next!.layers?.length) out.layers = next!.layers
    else delete out.layers
    if (next!.viewport) out.viewport = next!.viewport
    if (!out.pages) delete out.pages
    return out
  }
  pages.splice(idx - 1, 1)
  const out: MapBody = { ...b, pages: pages.length ? pages : undefined }
  if (!out.pages) delete out.pages
  return out
}

// Move a page from one index to another (0 = first). Implemented by
// flattening to a list, reordering, and writing back.
export function movePage(b: MapBody, from: number, to: number): MapBody {
  const all: MapPage[] = [
    { id: FIRST_PAGE_ID, name: b.pageName || 'Page 1', nodes: b.nodes, edges: b.edges, layers: b.layers, viewport: b.viewport },
    ...(b.pages ?? [])
  ]
  if (from < 0 || from >= all.length || to < 0 || to >= all.length || from === to) return b
  const [p] = all.splice(from, 1)
  all.splice(to, 0, p!)
  const [first, ...rest] = all
  const out: MapBody = { ...b, nodes: first!.nodes, edges: first!.edges, pageName: first!.name, viewport: first!.viewport ?? b.viewport }
  if (first!.layers?.length) out.layers = first!.layers
  else delete out.layers
  // The page that left slot 0 needs a real id now.
  const restPages = rest.map((p2) => (p2.id === FIRST_PAGE_ID ? { ...p2, id: `page-${Date.now().toString(36)}` } : p2))
  if (restPages.length) out.pages = restPages
  else delete out.pages
  return out
}
