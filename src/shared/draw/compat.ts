// The forward-compatibility guard for a schema-2 reader, and the gate on
// WRITING schema 2.
//
// Reading: the same contract as v1's drawCompatibility (draw.ts), one version
// up -- anything newer than this build understands opens read-only and is
// never saved over.
//
// Writing: an app that can read v2 must still not WRITE v2 until the guard
// release (the first build that opens newer drawings read-only instead of
// silently dropping what it does not know) has been in people's hands long
// enough. Until DRAW_V2_WRITES is switched on, every drawing that uses nothing
// v1 lacks is written as v1 -- byte-compatible with every older app -- and a
// drawing that is already v2 stays v2 (writing it back as v1 would lose it).

import { DRAW_OBJECT_TYPES, drawBodyForStorage, type DrawBody, type DrawCompatibility, type DrawReadOnlyReason } from '../draw'
import { isV1Representable, v2ToV1 } from './migrate'
import { DRAW_DOC_VERSION, DRAW_EFFECT_KINDS, DRAW_NODE_TYPES, type DrawDoc } from './model'

/**
 * Whether this build WRITES schema 2 for drawings that could still be written
 * as v1. OFF until the guard release has shipped and had time to spread; see
 * documents/draw/README.md, "Turning on v2 writes".
 */
export const DRAW_V2_WRITES = false

type Raw = Record<string, unknown>

function declared(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : dflt
}

/**
 * Can a schema-2 build edit `raw`, or only show it? Read straight off the
 * untrusted JSON, before any normalising -- the step that would lose what a
 * newer app wrote. Recurses into groups, and treats an effect kind outside the
 * closed vocabulary as an unknown object.
 */
export function drawDocCompatibility(raw: unknown): DrawCompatibility {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Raw
  const schemaVersion = declared(r.schemaVersion, 1)
  const minWriterVersion = declared(r.minWriterVersion, schemaVersion)
  // A v1 body is judged by v1's object vocabulary; a v2 body by v2's.
  const known: readonly string[] = schemaVersion >= 2 || r.artboards !== undefined ? DRAW_NODE_TYPES : DRAW_OBJECT_TYPES
  const unknownTypes: string[] = []
  let unknownCount = 0
  let unknownLayers = false
  const note = (label: string): void => {
    unknownCount += 1
    if (!unknownTypes.includes(label)) unknownTypes.push(label)
  }
  const visit = (nodes: unknown, depth: number): void => {
    if (!Array.isArray(nodes) || depth > 64) return
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue
      const o = n as Raw
      const t = o.type
      if (!(t === undefined || (typeof t === 'string' && known.includes(t)))) {
        note(typeof t === 'string' ? t : String(t))
        continue
      }
      const effects = (o.appearance as Raw | undefined)?.effects
      if (Array.isArray(effects)) {
        for (const e of effects) {
          const kind = e && typeof e === 'object' ? (e as Raw).kind : undefined
          if (typeof kind === 'string' && !(DRAW_EFFECT_KINDS as readonly string[]).includes(kind)) note(`effect:${kind}`)
        }
      }
      if (t === 'group') visit(o.children, depth + 1)
    }
  }
  for (const layer of Array.isArray(r.layers) ? r.layers : []) {
    if (!layer || typeof layer !== 'object') continue
    const l = layer as Raw
    if (l.kind !== undefined && l.kind !== 'vector' && l.kind !== 'raster') unknownLayers = true
    visit(l.objects, 0)
  }
  const reasons: DrawReadOnlyReason[] = []
  if (schemaVersion > DRAW_DOC_VERSION || minWriterVersion > DRAW_DOC_VERSION) reasons.push('newer-schema')
  if (unknownCount > 0) reasons.push('unknown-objects')
  if (unknownLayers) reasons.push('unknown-layers')
  return { readOnly: reasons.length > 0, reasons, schemaVersion, minWriterVersion, unknownTypes, unknownCount }
}

/** Opaque nodes back to the JSON they arrived as, anywhere in the tree. */
function restoreOpaque<T>(nodes: T[]): T[] {
  let changed = false
  const out = nodes.map((n) => {
    const o = n as unknown as Raw
    if (o && o.type === 'opaque' && o.raw && typeof o.raw === 'object') {
      changed = true
      return o.raw as unknown as T
    }
    if (o && o.type === 'group' && Array.isArray(o.children)) {
      const children = restoreOpaque(o.children as unknown[])
      if (children !== o.children) {
        changed = true
        return { ...o, children } as unknown as T
      }
    }
    return n
  })
  return changed ? out : nodes
}

/** Every asset id a document still refers to. */
function referencedAssets(doc: DrawDoc): Set<string> {
  const used = new Set<string>()
  const visit = (nodes: unknown[]): void => {
    for (const n of nodes) {
      const o = n as Raw
      if (o.type === 'image' && typeof o.assetId === 'string') used.add(o.assetId)
      if (o.type === 'group' && Array.isArray(o.children)) visit(o.children)
    }
  }
  for (const l of doc.layers) {
    if (l.kind === 'raster' && l.assetId) used.add(l.assetId)
    if (l.kind === 'vector') visit(l.objects)
  }
  return used
}

/** The document with assets nothing refers to any more left out (undo history keeps its own copies in memory). */
export function pruneAssets(doc: DrawDoc): DrawDoc {
  const used = referencedAssets(doc)
  const ids = Object.keys(doc.assets)
  if (ids.every((id) => used.has(id))) return doc
  const assets: DrawDoc['assets'] = {}
  for (const id of ids) if (used.has(id)) assets[id] = doc.assets[id]
  return { ...doc, assets }
}

/**
 * The document as it should be written to storage or a co-editing peer.
 *
 *   - Opaque nodes go back out as the exact JSON they arrived as.
 *   - Unreferenced assets are dropped.
 *   - Written as v1 while v2 writes are gated off and the drawing has nothing
 *     v1 lacks; as v2 when writes are on, or when it already is a v2 drawing
 *     (`stored` = the schema it was loaded from), or when it holds something
 *     only v2 can carry.
 */
export function drawDocForStorage(doc: DrawDoc, opts: { stored?: number; allowV2?: boolean } = {}): DrawDoc | DrawBody {
  const allowV2 = opts.allowV2 ?? DRAW_V2_WRITES
  const pruned = pruneAssets(doc)
  if (!allowV2 && (opts.stored ?? 1) < 2 && isV1Representable(pruned)) return drawBodyForStorage(v2ToV1(pruned))
  const layers = pruned.layers.map((l) => {
    if (l.kind !== 'vector') return l
    const objects = restoreOpaque(l.objects)
    return objects === l.objects ? l : { ...l, objects }
  })
  return layers.some((l, i) => l !== pruned.layers[i]) ? { ...pruned, layers } : pruned
}
