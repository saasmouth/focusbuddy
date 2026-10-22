// PlexiiDraw's clipboard: Copy, Cut and the Paste family, inside one drawing,
// between drawings, and to and from other apps.
//
// What goes ON the system clipboard (one atomic write, src/main/drawClipboard.ts):
//   - native JSON under a custom MIME type -- the copied nodes exactly, plus the
//     assets and swatches they use, so a paste into another drawing keeps
//     styles, groups and images;
//   - the same art as SVG markup (as image/svg+xml and as text), so Figma,
//     Inkscape, a browser or a code editor gets vectors;
//   - a PNG picture of it, so Office, Keynote, Slack and the like get an image.
//
// What a paste READS, best first: native JSON; SVG (through the SVG importer,
// once WP-IMPORT registers one -- until then the paste says so); a PNG or JPEG
// picture, which becomes an image object through the asset store; plain text,
// which becomes a text object (Illustrator does the same).
//
// Everything that arrives is untrusted: native JSON goes through the same
// normaliser as a stored drawing, and gets fresh ids before it lands.
//
// The pure half (building and parsing payloads, inserting nodes) is exported
// for tests; the side effects go through a ClipboardBackend, which the tests
// replace with a fake (setDrawClipboardBackend).

import { drawId, solid } from '@shared/draw'
import { multiplyMatrix, transformPath, type Box, type Matrix, type Pt } from '@shared/drawGeometry'
import { assetIdFor, dataUrlMime } from '@shared/draw/assets'
import { DRAW_V2_WRITES } from '@shared/draw/compat'
import { v2BlockedReason } from './v2gate'
import { v1Obstacle } from '@shared/draw/migrate'
import type { DrawArtboard, DrawAsset, DrawDoc, DrawDocVectorLayer, DrawGroupNode, DrawImageNode, DrawNode, DrawSwatch, DrawTextNode } from '@shared/draw/model'
import { normalizeDrawDoc } from '@shared/draw/normalize'
import { addObject, editableIds, findLayer, getObjects, nodesBounds, primaryArtboard, targetLayerId, translateNode } from '@shared/draw/ops'
import { drawDocToSvg } from '@shared/draw/svg'
import { findNode, vectorLayersOf } from '@shared/draw/tree'
import type { EditorCtx } from './types'

// ── The payload ──────────────────────────────────────────────────────────────

export const DRAW_CLIPBOARD_KIND = 'plexiidraw/clipboard'
export const DRAW_CLIPBOARD_VERSION = 1

/** The native clipboard format: what a PlexiiDraw copy writes as JSON. */
export interface DrawClipboardPayload {
  kind: typeof DRAW_CLIPBOARD_KIND
  version: number
  /** Visible bounds of the copied art, document space. */
  bounds: Box
  /** The artboard the art was copied from (Paste in Place keeps the art where it sat on it). */
  artboard: { x: number; y: number; w: number; h: number }
  /** Top-level copied nodes, bottom first. Ids are the source's; a paste mints new ones. */
  nodes: DrawNode[]
  /** Exactly the assets the nodes use. */
  assets: Record<string, DrawAsset>
  /** Exactly the swatches the nodes reference. */
  swatches: DrawSwatch[]
}

/** Every swatch id a value references (paints anywhere inside it: fills, strokes, appearance). */
function swatchRefs(v: unknown, out: Set<string>, depth = 0): void {
  if (!v || typeof v !== 'object' || depth > 200) return
  if (Array.isArray(v)) {
    for (const x of v) swatchRefs(x, out, depth + 1)
    return
  }
  const o = v as Record<string, unknown>
  if (o.type === 'swatch' && typeof o.id === 'string') out.add(o.id)
  for (const k of Object.keys(o)) if (k !== 'raw') swatchRefs(o[k], out, depth + 1)
}

/** Every asset id the nodes use. */
function assetRefs(nodes: DrawNode[], out: Set<string> = new Set()): Set<string> {
  for (const n of nodes) {
    if (n.type === 'image') out.add(n.assetId)
    else if (n.type === 'group') assetRefs(n.children, out)
  }
  return out
}

/** The widest stroke anywhere in the nodes, so a crop leaves room for it. */
function maxStroke(nodes: DrawNode[]): number {
  let w = 0
  for (const n of nodes) {
    if (n.type === 'group') w = Math.max(w, maxStroke(n.children))
    else if (n.type === 'path' || n.type === 'text') {
      if (n.stroke) w = Math.max(w, n.stroke.width)
      for (const s of n.appearance?.strokes ?? []) w = Math.max(w, s.stroke.width)
    }
  }
  return Number.isFinite(w) ? w : 0
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** A node with a matrix applied in document space (to bake a parent group's transform into a copied member). */
function applyMatrixToNode(n: DrawNode, m: Matrix): DrawNode {
  switch (n.type) {
    case 'path':
      return { ...n, path: transformPath(n.path, m) }
    case 'group':
      return { ...n, transform: multiplyMatrix(m, n.transform ?? IDENTITY) }
    case 'text':
    case 'image':
    case 'widget':
      return { ...n, transform: multiplyMatrix(m, n.transform ?? IDENTITY) }
    default:
      return n
  }
}

/**
 * The copyable nodes for `ids`, top-level in the copy, bottom first. A member
 * picked out of a transformed group carries that transform with it, so it
 * pastes where it was seen. Opaque nodes (made by a newer PlexiiDraw) are never
 * copied: this build cannot know what they look like.
 */
export function copiedNodes(doc: DrawDoc, ids: string[]): DrawNode[] {
  const out: DrawNode[] = []
  for (const n of getObjects(doc, ids)) {
    if (n.type === 'opaque') continue
    const hit = findNode(doc, n.id)
    const ms = (hit?.parents ?? []).map((g) => g.transform).filter((t): t is Matrix => !!t)
    out.push(ms.length ? applyMatrixToNode(n, ms.reduce((a, b) => multiplyMatrix(a, b))) : n)
  }
  return out
}

/** A throwaway document holding just `nodes` on an artboard that is their crop (for SVG and PNG). */
function cropDoc(doc: DrawDoc, nodes: DrawNode[], assets: Record<string, DrawAsset>, swatches: DrawSwatch[]): { doc: DrawDoc; box: Box } {
  const b = nodesBounds(nodes)
  const pad = Math.ceil(maxStroke(nodes) / 2)
  const box = { x: Math.floor(b.x) - pad, y: Math.floor(b.y) - pad, w: Math.ceil(b.x + b.w) - Math.floor(b.x) + 2 * pad, h: Math.ceil(b.y + b.h) - Math.floor(b.y) + 2 * pad }
  box.w = Math.max(1, box.w)
  box.h = Math.max(1, box.h)
  const board: DrawArtboard = { id: 'clipboard', name: 'Clipboard', ...box, background: { type: 'none' } }
  const layer: DrawDocVectorLayer = { id: 'clipboard', kind: 'vector', name: 'Clipboard', visible: true, locked: false, opacity: 1, blend: 'normal', objects: nodes }
  return { doc: { ...doc, artboards: [board], activeArtboardId: board.id, layers: [layer], assets, swatches, guides: [] }, box }
}

export interface BuiltClipboard {
  payload: DrawClipboardPayload
  json: string
  svg: string
  /** The SVG's pixel size (its crop). */
  size: { w: number; h: number }
}

/** Everything a copy of `ids` writes, or null when nothing copyable is selected. */
export function buildClipboard(doc: DrawDoc, ids: string[]): BuiltClipboard | null {
  const nodes = copiedNodes(doc, ids)
  if (!nodes.length) return null
  const assets: Record<string, DrawAsset> = {}
  for (const id of assetRefs(nodes)) if (Object.prototype.hasOwnProperty.call(doc.assets, id)) assets[id] = doc.assets[id]
  const refs = new Set<string>()
  swatchRefs(nodes, refs)
  const swatches = doc.swatches.filter((s) => refs.has(s.id))
  const board = primaryArtboard(doc)
  const payload: DrawClipboardPayload = {
    kind: DRAW_CLIPBOARD_KIND,
    version: DRAW_CLIPBOARD_VERSION,
    bounds: nodesBounds(nodes),
    artboard: { x: board.x, y: board.y, w: board.w, h: board.h },
    nodes,
    assets,
    swatches
  }
  const crop = cropDoc(doc, nodes, assets, swatches)
  return { payload, json: JSON.stringify(payload), svg: drawDocToSvg(crop.doc), size: { w: crop.box.w, h: crop.box.h } }
}

export interface ParsedClipboard {
  nodes: DrawNode[]
  assets: Record<string, DrawAsset>
  swatches: DrawSwatch[]
  bounds: Box
  artboard: { x: number; y: number; w: number; h: number }
  /** Objects left out because a newer PlexiiDraw made them. */
  dropped: number
}

function finiteBox(v: unknown, dflt: Box): Box {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const n = (k: string, d: number): number => (typeof o[k] === 'number' && Number.isFinite(o[k] as number) ? (o[k] as number) : d)
  return { x: n('x', dflt.x), y: n('y', dflt.y), w: n('w', dflt.w), h: n('h', dflt.h) }
}

/** Opaque nodes out, anywhere in the tree; counts what went. */
function dropOpaque(nodes: DrawNode[], count: { n: number }): DrawNode[] {
  const out: DrawNode[] = []
  for (const n of nodes) {
    if (n.type === 'opaque') {
      count.n += 1
      continue
    }
    out.push(n.type === 'group' ? ({ ...n, children: dropOpaque(n.children, count) } as DrawGroupNode) : n)
  }
  return out
}

/**
 * Native clipboard JSON, made safe: it went through another app's hands (or a
 * newer PlexiiDraw's), so it is normalised exactly like a stored drawing.
 * Returns null for anything that is not a PlexiiDraw payload.
 */
export function parseClipboardPayload(text: string): ParsedClipboard | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  return parseClipboardValue(raw)
}

/**
 * The same, for a payload already parsed from JSON (a saved snippet's body
 * arrives as an object, not as text, and is no more trusted than the clipboard).
 */
export function parseClipboardValue(raw: unknown): ParsedClipboard | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind !== DRAW_CLIPBOARD_KIND || !Array.isArray(r.nodes)) return null
  const board = finiteBox(r.artboard, { x: 0, y: 0, w: 1, h: 1 })
  const doc = normalizeDrawDoc({
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [{ id: 'clipboard', name: 'Clipboard', x: board.x, y: board.y, w: Math.max(1, board.w), h: Math.max(1, board.h), background: { type: 'none' } }],
    layers: [{ id: 'clipboard', kind: 'vector', name: 'Clipboard', visible: true, locked: false, opacity: 1, blend: 'normal', objects: r.nodes }],
    assets: r.assets && typeof r.assets === 'object' ? r.assets : {},
    swatches: Array.isArray(r.swatches) ? r.swatches : [],
    guides: [],
    settings: {}
  })
  const count = { n: 0 }
  const nodes = dropOpaque(vectorLayersOf(doc)[0]?.objects ?? [], count)
  if (!nodes.length) return { nodes, assets: {}, swatches: [], bounds: { x: 0, y: 0, w: 0, h: 0 }, artboard: board, dropped: count.n }
  return { nodes, assets: doc.assets, swatches: doc.swatches, bounds: nodesBounds(nodes), artboard: board, dropped: count.n }
}

// ── Landing the art in a document ────────────────────────────────────────────

/**
 * A deep copy with fresh ids for the node and every group member. Deep, so
 * the copy shares no object (a paint, a path) with its original: the save
 * path's IPC guard reads a value reachable twice as cyclic and refuses it.
 */
export function withFreshIds(n: DrawNode): DrawNode {
  return reId(structuredClone(n))
}

function reId(n: DrawNode): DrawNode {
  n.id = drawId('obj')
  if (n.type === 'group') n.children.forEach(reId)
  return n
}

function remapSwatchPaints<T>(v: T, map: Map<string, string>, depth = 0): T {
  if (!map.size || !v || typeof v !== 'object' || depth > 200) return v
  if (Array.isArray(v)) {
    let changed = false
    const out = v.map((x) => {
      const y = remapSwatchPaints(x, map, depth + 1)
      if (y !== x) changed = true
      return y
    })
    return (changed ? out : v) as T
  }
  const o = v as Record<string, unknown>
  let next: Record<string, unknown> | null = null
  if (o.type === 'swatch' && typeof o.id === 'string' && map.has(o.id)) next = { ...o, id: map.get(o.id) }
  for (const k of Object.keys(o)) {
    const y = remapSwatchPaints(o[k], map, depth + 1)
    if (y !== o[k]) (next ??= { ...o })[k] = y
  }
  return (next ?? o) as T
}

/**
 * The incoming art made ready for `doc`: fresh ids, its assets added to the
 * store (content-addressed, so a picture already there is not stored twice),
 * and its swatches merged -- a swatch the drawing already has (same id, or same
 * name and colour) is reused; a clash of id with a different colour gets a new
 * id, as Illustrator adds a conflicting swatch rather than recolouring.
 */
export function landPayload(doc: DrawDoc, parsed: Pick<ParsedClipboard, 'nodes' | 'assets' | 'swatches'>): { doc: DrawDoc; nodes: DrawNode[] } {
  let assets = doc.assets
  for (const [id, a] of Object.entries(parsed.assets)) {
    // The id is the hash of the bytes; a payload whose id does not match its bytes is re-keyed, never trusted.
    const real = assetIdFor(a.dataUrl)
    if (Object.prototype.hasOwnProperty.call(assets, real)) continue
    assets = { ...assets, [real]: a }
    if (real !== id) parsed = { ...parsed, nodes: parsed.nodes.map((n) => reAsset(n, id, real)) }
  }
  const map = new Map<string, string>()
  let swatches = doc.swatches
  for (const s of parsed.swatches) {
    const same = swatches.find((t) => t.id === s.id)
    if (same && same.color.toLowerCase() === s.color.toLowerCase()) continue
    const twin = swatches.find((t) => t.name === s.name && t.color.toLowerCase() === s.color.toLowerCase())
    if (twin) {
      map.set(s.id, twin.id)
      continue
    }
    const id = same ? drawId('swatch') : s.id
    if (id !== s.id) map.set(s.id, id)
    swatches = [...swatches, { ...s, id }]
  }
  const nodes = parsed.nodes.map((n) => withFreshIds(remapSwatchPaints(n, map)))
  return { doc: assets === doc.assets && swatches === doc.swatches ? doc : { ...doc, assets, swatches }, nodes }
}

function reAsset(n: DrawNode, from: string, to: string): DrawNode {
  if (n.type === 'image' && n.assetId === from) return { ...n, assetId: to }
  if (n.type === 'group') return { ...n, children: n.children.map((c) => reAsset(c, from, to)) }
  return n
}

function insertIntoList(list: DrawNode[], anchorId: string, nodes: DrawNode[], where: 'above' | 'below'): DrawNode[] | null {
  const i = list.findIndex((n) => n.id === anchorId)
  if (i >= 0) {
    const out = list.slice()
    out.splice(where === 'above' ? i + 1 : i, 0, ...nodes)
    return out
  }
  for (let j = 0; j < list.length; j++) {
    const n = list[j]
    if (n.type !== 'group') continue
    const children = insertIntoList(n.children, anchorId, nodes, where)
    if (children) {
      const out = list.slice()
      out[j] = { ...n, children }
      return out
    }
  }
  return null
}

/**
 * `nodes` (bottom first) placed directly above or below the node `anchorId`,
 * in the same layer or group -- Paste in Front and Paste in Back. Null when the
 * anchor is not in the document.
 */
export function insertBeside(doc: DrawDoc, anchorId: string, nodes: DrawNode[], where: 'above' | 'below'): DrawDoc | null {
  for (const l of doc.layers) {
    if (l.kind !== 'vector') continue
    const objects = insertIntoList(l.objects, anchorId, nodes, where)
    if (objects) return { ...doc, activeLayerId: l.id, layers: doc.layers.map((x) => (x.id === l.id ? { ...l, objects } : x)) }
  }
  return null
}

/** `nodes` at the top or the bottom of a vector layer (or wherever addObject sends new art). */
export function insertInLayer(doc: DrawDoc, layerId: string, nodes: DrawNode[], where: 'top' | 'bottom'): DrawDoc {
  const layer = findLayer(doc, layerId)
  if (where === 'bottom' && layer && layer.kind === 'vector' && !layer.locked) {
    return { ...doc, activeLayerId: layer.id, layers: doc.layers.map((l) => (l.id === layer.id ? { ...layer, objects: [...nodes, ...layer.objects] } : l)) }
  }
  let next = doc
  for (const n of nodes) next = addObject(next, n, layerId)
  return next
}

/**
 * Alt-drag duplicate (Illustrator): the originals go back where they started
 * and copies take their place at the drop point, each copy directly above its
 * original. `doc` is the document as the drag left it (originals moved by
 * dx, dy); `before` is the document from before the drag, when known.
 * Returns the new document and the copies' ids, in the order given.
 */
export function altDragDuplicate(doc: DrawDoc, ids: string[], dx: number, dy: number, before?: DrawDoc): { doc: DrawDoc; newIds: string[] } {
  let next = doc
  const newIds: string[] = []
  for (const n of getObjects(doc, ids)) {
    if (n.type === 'opaque') continue
    const copy = withFreshIds(n)
    // The original exactly as it was before the drag when that is known; moving
    // it back by -dx would leave floating-point noise in its coordinates.
    const back = (before && findNode(before, n.id)?.node) || translateNode(n, -dx, -dy)
    const placed = insertBeside(next, n.id, [copy], 'above')
    if (!placed) continue
    next = mapNodeShallow(placed, n.id, back)
    newIds.push(copy.id)
  }
  return { doc: next, newIds }
}

function mapNodeShallow(doc: DrawDoc, id: string, replacement: DrawNode): DrawDoc {
  const swap = (list: DrawNode[]): DrawNode[] | null => {
    const i = list.findIndex((n) => n.id === id)
    if (i >= 0) {
      const out = list.slice()
      out[i] = replacement
      return out
    }
    for (let j = 0; j < list.length; j++) {
      const n = list[j]
      if (n.type !== 'group') continue
      const children = swap(n.children)
      if (children) {
        const out = list.slice()
        out[j] = { ...n, children }
        return out
      }
    }
    return null
  }
  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.kind !== 'vector') return l
      const objects = swap(l.objects)
      return objects ? { ...l, objects } : l
    })
  }
}

/** Move a set of nodes by one delta. */
export function translateAll(nodes: DrawNode[], dx: number, dy: number): DrawNode[] {
  return dx === 0 && dy === 0 ? nodes : nodes.map((n) => translateNode(n, dx, dy))
}

/** The delta that centres a box on a point, in whole pixels (so pasted art keeps whole-pixel edges). */
export function centreDelta(box: Box, at: Pt): { dx: number; dy: number } {
  return { dx: Math.round(at.x - (box.x + box.w / 2)), dy: Math.round(at.y - (box.y + box.h / 2)) }
}

/**
 * Why a document can no longer be written the way it is stored, after a paste:
 * a drawing that must stay v1 (v2 writes off, as in a live session with someone
 * on an older version) cannot take content only v2 can hold. Null when fine.
 */
export function pasteStorageObstacle(before: DrawDoc, after: DrawDoc, storedSchema: number, v2Writes: boolean = DRAW_V2_WRITES): string | null {
  if (v2Writes || storedSchema >= 2) return null
  if (v1Obstacle(before) !== null) return null
  return v1Obstacle(after)
}

// ── Images and text from other apps ──────────────────────────────────────────

/** An image object for pasted picture bytes, at its natural size (scaled down to fit `fit` when larger). */
export function imageNodeFor(doc: DrawDoc, dataUrl: string, size: { w: number; h: number }, fit: Box): { doc: DrawDoc; node: DrawImageNode } {
  const id = assetIdFor(dataUrl)
  const assets = Object.prototype.hasOwnProperty.call(doc.assets, id) ? doc.assets : { ...doc.assets, [id]: { mime: dataUrlMime(dataUrl), dataUrl, w: size.w, h: size.h } }
  const k = Math.min(1, fit.w / Math.max(1, size.w), fit.h / Math.max(1, size.h))
  const w = Math.max(1, Math.round(size.w * k))
  const h = Math.max(1, Math.round(size.h * k))
  const node: DrawImageNode = { id: drawId('obj'), type: 'image', x: 0, y: 0, w, h, assetId: id }
  return { doc: assets === doc.assets ? doc : { ...doc, assets }, node }
}

/** A text object for pasted plain text. */
export function textNodeFor(text: string): DrawTextNode {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const longest = Math.max(1, ...lines.map((l) => l.length))
  const fontSize = 24
  return { id: drawId('obj'), type: 'text', x: 0, y: 0, w: Math.min(1200, Math.max(40, Math.ceil(longest * fontSize * 0.6))), text: text.replace(/\r\n?/g, '\n'), fontSize, fill: solid('#000000') }
}

/** Does this text look like an SVG document (Figma's Copy as SVG, a code editor)? */
export function looksLikeSvg(text: string): boolean {
  return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text.slice(0, 4096))
}

// ── SVG import seam (WP-IMPORT) ──────────────────────────────────────────────

/**
 * How SVG paste turns markup into nodes. WP-IMPORT owns the SVG parser and
 * registers it here from its own module (commands/import.commands.ts), so SVG
 * on the clipboard -- Figma's Copy as SVG, a code editor, a browser -- pastes as
 * editable vectors through the same importer as File › Import SVG. `info`
 * carries what decides whether the art may use v2-only structure (groups).
 */
export type SvgPasteResult = { nodes: DrawNode[]; assets: Record<string, DrawAsset>; swatches?: DrawSwatch[]; report?: string } | { error: string }
export type SvgPasteImporter = (svg: string, target: DrawDoc, info: { storedSchema: number; v2Writes: boolean }) => SvgPasteResult | Promise<SvgPasteResult>

let svgImporter: SvgPasteImporter | null = null

export function registerSvgPasteImporter(fn: SvgPasteImporter | null): void {
  svgImporter = fn
}

export function svgPasteImporter(): SvgPasteImporter | null {
  return svgImporter
}

// ── File paste seam (WP-IMPORT) ──────────────────────────────────────────────

/** A file copied in Finder, as the main process read it from disk. */
export interface ClipboardFile {
  name: string
  bytes: Uint8Array
}

/**
 * How files copied in Finder paste: exactly what File › Place makes of them
 * (an image, an SVG as editable art, a PDF page as an image), registered by
 * commands/import.commands.ts. The nodes come back at their actual size, laid
 * out from (0, 0); the paste centres them in the window.
 */
export type FilePasteImporter = (files: ClipboardFile[], target: DrawDoc, info: { storedSchema: number; v2Writes: boolean }) => Promise<{ nodes: DrawNode[]; assets: Record<string, DrawAsset>; note: string | null } | { error: string }>

let fileImporter: FilePasteImporter | null = null

export function registerFilePasteImporter(fn: FilePasteImporter | null): void {
  fileImporter = fn
}

/** Said only if no SVG importer is registered (a build without WP-IMPORT): never a silent failure. */
export const SVG_PASTE_UNAVAILABLE = "This build can't read SVG from the clipboard."

// ── The system clipboard ─────────────────────────────────────────────────────

export interface ClipboardWriteInput {
  json: string
  svg: string
  /** Copy As › SVG Code: put only the markup on the clipboard, as text. */
  svgAsText?: boolean
  /** A PNG data URL rendered at `pngScale` x the art's size, when one could be made. */
  png?: string
  pngScale: number
}

export interface ClipboardReadResult {
  /** Files copied in Finder, read from disk (their names and icons on the clipboard are ignored). */
  files?: ClipboardFile[]
  /** Copied files that could not be read, and why. */
  skippedFiles?: Array<{ name: string; reason: string }>
  /** PlexiiDraw's own JSON. */
  native?: string
  /** SVG markup (from an SVG flavour, or text that is an SVG document). */
  svg?: string
  /** A picture (PNG or JPEG bytes) with its pixel size. */
  image?: { dataUrl: string; w: number; h: number }
  /** Plain text. */
  text?: string
  error?: string
}

export interface DrawClipboardBackend {
  write(input: ClipboardWriteInput): Promise<{ ok: boolean; error?: string }>
  read(): Promise<ClipboardReadResult>
  /** SVG to a PNG data URL at `scale`; null when it cannot be drawn (the copy then carries no picture). */
  rasterize(svg: string, w: number, h: number, scale: number): Promise<string | null>
}

/** Longest side of the PNG written on copy, in pixels. */
export const MAX_PNG_SIDE = 8192

/** Draw an SVG on a canvas and encode it as PNG -- the browser's own rasteriser, no round trip. */
export async function rasterizeSvgInDom(svg: string, w: number, h: number, scale: number): Promise<string | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null
  const k = Math.min(scale, MAX_PNG_SIDE / Math.max(w, h))
  const pw = Math.max(1, Math.round(w * k))
  const ph = Math.max(1, Math.round(h * k))
  // A data: URL, not a blob: one -- the app's CSP allows data: images only.
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  try {
    const img = new Image()
    img.decoding = 'async'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('the artwork could not be drawn as a picture'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = pw
    canvas.height = ph
    const g = canvas.getContext('2d')
    if (!g) return null
    g.drawImage(img, 0, 0, pw, ph)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

type DrawApi = {
  clipboardWrite?: (input: ClipboardWriteInput) => Promise<{ ok: boolean; error?: string }>
  clipboardRead?: () => Promise<ClipboardReadResult>
}

function drawApi(): DrawApi | undefined {
  const w = globalThis as unknown as { api?: { draw?: DrawApi } }
  return w.api?.draw
}

/** The real backend: the main process's clipboard, through the preload. */
export const electronClipboardBackend: DrawClipboardBackend = {
  async write(input) {
    const api = drawApi()
    if (!api?.clipboardWrite) return { ok: false, error: 'The clipboard is not available here.' }
    try {
      return await api.clipboardWrite(input)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
  async read() {
    const api = drawApi()
    if (!api?.clipboardRead) return { error: 'The clipboard is not available here.' }
    try {
      return await api.clipboardRead()
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
  rasterize: rasterizeSvgInDom
}

let backend: DrawClipboardBackend = electronClipboardBackend

/** Replace the clipboard backend (tests); null restores the real one. */
export function setDrawClipboardBackend(b: DrawClipboardBackend | null): void {
  backend = b ?? electronClipboardBackend
}

export function drawClipboardBackend(): DrawClipboardBackend {
  return backend
}

// ── The commands' work ───────────────────────────────────────────────────────

/** What a copy may take: on a writable drawing, what may be edited; on a read-only one, whatever is selected and visible. */
export function copyableIds(ctx: EditorCtx): string[] {
  const s = ctx.get()
  if (!s.readOnly) return editableIds(s.doc, s.selection)
  return getObjects(s.doc, s.selection)
    .filter((n) => n.type !== 'opaque' && !n.hidden)
    .map((n) => n.id)
}

/**
 * The copy still being written to the system clipboard, if any. A copy first
 * draws the art as a picture for other apps (slow with photos, or on a busy
 * machine) and only then writes; a ⌘V pressed in that gap used to read the
 * clipboard as it was BEFORE the copy and paste the old contents -- or, with
 * nothing usable there, nothing at all. Paste waits for it first.
 */
let copyInFlight: Promise<unknown> | null = null

/** Run a clipboard write so a paste started meanwhile waits for it. */
function trackCopy<T>(work: Promise<T>): Promise<T> {
  const p = work.finally(() => {
    if (copyInFlight === p) copyInFlight = null
  })
  copyInFlight = p
  return p
}

/** Copy the selection to the system clipboard. True when it was written. */
export function copySelection(ctx: EditorCtx): Promise<boolean> {
  return trackCopy(copySelectionNow(ctx))
}

async function copySelectionNow(ctx: EditorCtx): Promise<boolean> {
  const built = buildClipboard(ctx.doc(), copyableIds(ctx))
  if (!built) {
    ctx.status('Select something to copy.')
    return false
  }
  const b = drawClipboardBackend()
  const n = built.payload.nodes.length
  // Art holding photos takes a moment to draw as a picture: say so, so a
  // paste into another app is not tried before the clipboard has it.
  ctx.busy('Copying…')
  try {
    const png = await b.rasterize(built.svg, built.size.w, built.size.h, 2)
    const res = await b.write({ json: built.json, svg: built.svg, png: png ?? undefined, pngScale: 2 })
    if (!res.ok) {
      ctx.status(`Couldn't copy: ${res.error ?? 'the clipboard refused the write.'}`)
      return false
    }
    ctx.status(png ? `Copied ${n} object${n === 1 ? '' : 's'}.` : `Copied ${n} object${n === 1 ? '' : 's'} as vectors only: the picture other apps paste could not be drawn.`)
    return true
  } finally {
    ctx.busy(null)
  }
}

/** Edit › Copy As › SVG Code: the selection's SVG markup on the clipboard as plain text (code editors, Figma's paste, chat). */
export function copySvgCode(ctx: EditorCtx): Promise<boolean> {
  return trackCopy(copySvgCodeNow(ctx))
}

async function copySvgCodeNow(ctx: EditorCtx): Promise<boolean> {
  const built = buildClipboard(ctx.doc(), copyableIds(ctx))
  if (!built) {
    ctx.status('Select something to copy.')
    return false
  }
  const res = await drawClipboardBackend().write({ json: built.json, svg: built.svg, pngScale: 1, svgAsText: true })
  if (!res.ok) {
    ctx.status(`Couldn't copy: ${res.error ?? 'the clipboard refused the write.'}`)
    return false
  }
  ctx.status('Copied the SVG code.')
  return true
}

export type PasteMode = 'paste' | 'front' | 'back' | 'inPlace' | 'allArtboards'

const PASTE_LABEL: Record<PasteMode, string> = {
  paste: 'Paste',
  front: 'Paste in Front',
  back: 'Paste in Back',
  inPlace: 'Paste in Place',
  allArtboards: 'Paste on All Artboards'
}

/** Centre of what the window shows, in document space (the artboard's centre when unknown). */
function viewCentre(ctx: EditorCtx): Pt {
  const r = ctx.viewport.visibleRect?.()
  if (r && r.w > 0 && r.h > 0) return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
  const b = primaryArtboard(ctx.doc())
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

/** The box new pictures are fitted into: the visible area, else the artboard. */
function fitBox(ctx: EditorCtx): Box {
  const r = ctx.viewport.visibleRect?.()
  if (r && r.w > 0 && r.h > 0) return r
  const b = primaryArtboard(ctx.doc())
  return { x: b.x, y: b.y, w: b.w, h: b.h }
}

interface Incoming {
  /** The document with any assets and swatches the art needs already added. */
  doc: DrawDoc
  nodes: DrawNode[]
  /** Where the art sat when copied (null for art from other apps, which always lands in view). */
  origin: { bounds: Box; artboard: { x: number; y: number } } | null
  note: string | null
}

/** Turn what the clipboard holds into nodes for `doc`, or a reason why not. */
export async function incomingFrom(ctx: EditorCtx, read: ClipboardReadResult): Promise<Incoming | { error: string }> {
  const doc = ctx.doc()
  const skipped = (read.skippedFiles ?? []).map((f) => `${f.name} was not read: ${f.reason}.`)
  if (read.files?.length || skipped.length) {
    if (!read.files?.length) return { error: skipped.join(' ') }
    if (!fileImporter) return { error: "This build can't paste files; use File › Place." }
    const res = await fileImporter(read.files, doc, { storedSchema: ctx.get().storedSchema, v2Writes: ctx.get().v2Writes })
    if ('error' in res) return { error: [res.error, ...skipped].join(' ') }
    const landed = landPayload(ctx.doc(), { nodes: res.nodes, assets: res.assets, swatches: [] })
    const note = [res.note, ...skipped].filter(Boolean).join(' ') || null
    return { doc: landed.doc, nodes: landed.nodes, origin: null, note }
  }
  if (read.native) {
    const parsed = parseClipboardPayload(read.native)
    if (parsed && parsed.nodes.length) {
      const landed = landPayload(doc, parsed)
      const note = parsed.dropped ? `${parsed.dropped} object${parsed.dropped === 1 ? '' : 's'} made in a newer PlexiiDraw ${parsed.dropped === 1 ? 'was' : 'were'} left out.` : null
      return { doc: landed.doc, nodes: landed.nodes, origin: { bounds: parsed.bounds, artboard: parsed.artboard }, note }
    }
    if (parsed && parsed.dropped) return { error: 'Everything on the clipboard was made in a newer PlexiiDraw; update to paste it.' }
  }
  const svg = read.svg ?? (read.text && looksLikeSvg(read.text) ? read.text : undefined)
  let pending: string | null = null
  if (svg) {
    const importer = svgPasteImporter()
    if (importer) {
      let res: SvgPasteResult
      try {
        res = await importer(svg, doc, { storedSchema: ctx.get().storedSchema, v2Writes: ctx.get().v2Writes })
      } catch (e) {
        res = { error: e instanceof Error ? e.message : String(e) }
      }
      if ('error' in res) {
        if (!read.image) return { error: `Couldn't paste the SVG: ${res.error}` }
        pending = `The SVG couldn't be read (${res.error}), so it was pasted as a picture.`
      } else if (res.nodes.length) {
        // The import awaited: land on the drawing as it is now.
        const landed = landPayload(ctx.doc(), { nodes: res.nodes, assets: res.assets, swatches: res.swatches ?? [] })
        return { doc: landed.doc, nodes: landed.nodes, origin: null, note: res.report ?? null }
      }
    } else {
      if (!read.image) return { error: SVG_PASTE_UNAVAILABLE }
      pending = `Pasted as a picture. ${SVG_PASTE_UNAVAILABLE}`
    }
  }
  if (read.image) {
    const { doc: next, node } = imageNodeFor(doc, read.image.dataUrl, read.image, fitBox(ctx))
    return { doc: next, nodes: [node], origin: null, note: pending }
  }
  if (read.text && read.text.trim() && !svg) {
    return { doc, nodes: [ctx.text.measure(textNodeFor(read.text))], origin: null, note: null }
  }
  if (read.error) return { error: `Couldn't read the clipboard: ${read.error}` }
  return { error: 'Nothing on the clipboard can be pasted into a drawing.' }
}

/**
 * Place incoming art for a paste mode and return the document, or a reason it
 * cannot. Illustrator's rules:
 *   - Paste: front of the active layer, centred in the window.
 *   - Paste in Front / Back: directly above the frontmost / below the
 *     backmost selected object, in its layer or group, at the copied
 *     position; with nothing selected, the top / bottom of the active layer.
 *   - Paste in Place: front of the active layer, at the position it had on
 *     the artboard it was copied from, on the active artboard.
 *   - Paste on All Artboards: Paste in Place on every artboard.
 * Art from another app has no position, so it is centred in the window.
 */
export function placeIncoming(ctx: EditorCtx, inc: Incoming, mode: PasteMode): { doc: DrawDoc; ids: string[] } | { error: string } {
  const s = ctx.get()
  const base = inc.doc
  const box = nodesBounds(inc.nodes)
  const centred = (): DrawNode[] => {
    const d = centreDelta(box, viewCentre(ctx))
    return translateAll(inc.nodes, d.dx, d.dy)
  }
  const onBoard = (board: { x: number; y: number }, nodes: DrawNode[]): DrawNode[] =>
    inc.origin ? translateAll(nodes, board.x - inc.origin.artboard.x, board.y - inc.origin.artboard.y) : centred()

  const layerId = targetLayerId(base)
  const layer = findLayer(base, layerId)
  const hiddenTarget = layer && layer.kind === 'vector' && !layer.visible

  if (mode === 'front' || mode === 'back') {
    const sel = getObjects(base, editableIds(base, s.selection))
    const nodes = inc.origin ? inc.nodes : centred()
    if (sel.length) {
      const anchor = mode === 'front' ? sel[sel.length - 1] : sel[0]
      const doc = insertBeside(base, anchor.id, nodes, mode === 'front' ? 'above' : 'below')
      if (doc) return { doc, ids: nodes.map((n) => n.id) }
    }
    if (hiddenTarget) return { error: `Can't paste into "${layer.name}": the layer is hidden.` }
    return { doc: insertInLayer(base, layerId, nodes, mode === 'front' ? 'top' : 'bottom'), ids: nodes.map((n) => n.id) }
  }

  if (hiddenTarget) return { error: `Can't paste into "${layer.name}": the layer is hidden.` }

  if (mode === 'paste') {
    const nodes = centred()
    return { doc: insertInLayer(base, layerId, nodes, 'top'), ids: nodes.map((n) => n.id) }
  }

  const active = (base.activeArtboardId ? base.artboards.find((a) => a.id === base.activeArtboardId) : undefined) ?? primaryArtboard(base)
  if (mode === 'inPlace') {
    const nodes = onBoard(active, inc.nodes)
    return { doc: insertInLayer(base, layerId, nodes, 'top'), ids: nodes.map((n) => n.id) }
  }

  // All artboards: one copy per artboard, each with its own ids.
  let doc = base
  const ids: string[] = []
  base.artboards.forEach((board, i) => {
    const copies = i === 0 ? inc.nodes : inc.nodes.map(withFreshIds)
    const nodes = onBoard(board, copies)
    doc = insertInLayer(doc, layerId, nodes, 'top')
    ids.push(...nodes.map((n) => n.id))
  })
  return { doc, ids }
}

/** Read the system clipboard and paste with `mode`; one undo step. */
export async function pasteFromClipboard(ctx: EditorCtx, mode: PasteMode): Promise<boolean> {
  if (ctx.get().readOnly) return false
  // A copy made a moment ago must be on the clipboard before it is read.
  if (copyInFlight) await copyInFlight.catch(() => undefined)
  const read = await drawClipboardBackend().read()
  const inc = await incomingFrom(ctx, read)
  if ('error' in inc) {
    ctx.status(inc.error)
    return false
  }
  const placed = placeIncoming(ctx, inc, mode)
  if ('error' in placed) {
    ctx.status(placed.error)
    return false
  }
  const st = ctx.get()
  const why = pasteStorageObstacle(ctx.doc(), placed.doc, st.storedSchema, st.v2Writes)
  if (why) {
    ctx.status(`Can't paste into this drawing yet: it is saved in the older format, which can't hold ${why} (${v2BlockedReason(st)}).`)
    return false
  }
  ctx.history.commit(placed.doc, PASTE_LABEL[mode])
  ctx.select(placed.ids)
  ctx.status(inc.note)
  return true
}

/** Cut: copy, and only once the clipboard really has it, delete (one undo step, "Cut"). */
export async function cutSelection(ctx: EditorCtx, remove: (doc: DrawDoc, ids: string[]) => DrawDoc): Promise<boolean> {
  if (ctx.get().readOnly) return false
  const ids = copyableIds(ctx)
  if (!ids.length) return false
  if (!(await copySelection(ctx))) return false
  const doc = ctx.doc()
  ctx.history.commit(remove(doc, editableIds(doc, ids)), 'Cut')
  ctx.select([])
  return true
}

/** Rename the newest undo step (a streamed gesture whose meaning was only known at its end). */
export function relabelLastStep(ctx: EditorCtx, label: string): void {
  ctx.set((s) => (s.past.length ? { past: [...s.past.slice(0, -1), { ...s.past[s.past.length - 1], label }] } : {}))
}
