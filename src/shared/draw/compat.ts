// The forward-compatibility guard for a schema-2 reader, and the gate on
// WRITING schema 2.
//
// Reading: the same contract as v1's drawCompatibility (draw.ts), one version
// up -- anything newer than this build understands opens read-only and is
// never saved over.
//
// Writing: DRAW_V2_WRITES is on (4.3.39-local.8), so a v1 drawing becomes v2
// on its first edit. With writes off (allowV2: false -- a live session with
// someone on an older version), a drawing that uses nothing v1 lacks is written
// as v1, byte-compatible with every older app, and a drawing that is already
// v2 stays v2 (writing it back as v1 would lose it).

import { DRAW_OBJECT_TYPES, drawBodyForStorage, type DrawBody, type DrawCompatibility, type DrawReadOnlyReason } from '../draw'
import { isV1Representable, v2ToV1 } from './migrate'
import { DRAW_DOC_VERSION, DRAW_EFFECT_KINDS, DRAW_NODE_TYPES, type DrawDoc } from './model'

/**
 * Whether this build WRITES schema 2 for drawings that could still be written
 * as v1. ON from 4.3.39-local.8: a v1 drawing becomes v2 on its first edit and
 * save (opening one without editing never rewrites it). A live co-editing
 * session with someone who cannot read v2 keeps the drawing v1 for that session
 * (the editor's v2Writes; see documents/draw/editor/v2gate.ts). Builds from
 * 4.3.39-local.6 on open newer drawings read-only; 4.3.33 and earlier have no
 * guard. See documents/draw/README.md, "Writing v2".
 */
export const DRAW_V2_WRITES = true

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

/**
 * Must a save of `incoming` be refused because it would overwrite `stored`?
 * Yes when the stored drawing is one this build can only show and the
 * incoming body is one it could have produced -- a downgrade. (The schema-2
 * reader's twin of refusesDrawOverwrite in draw.ts.)
 */
export function refusesDrawDocOverwrite(stored: unknown, incoming: unknown): boolean {
  return drawDocCompatibility(stored).readOnly && !drawDocCompatibility(incoming).readOnly
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
  return unshareRefs(storageForm(doc, opts))
}

/**
 * The same tree with every object that is reached twice copied, so the result
 * is a strict tree. In-memory documents legitimately share objects (every
 * shape drawn with the current fill holds the SAME paint object), but
 * Electron's IPC rejects a value that reaches one object twice as "cyclic
 * data" -- the save then fails and the drawing is silently not stored. Only
 * the repeated parts (small paints, in practice) are copied; nothing is
 * mutated, and a body with no sharing comes back as the same object.
 */
export function unshareRefs<T>(value: T): T {
  const seen = new Set<object>()
  const walk = (v: unknown): unknown => {
    if (!v || typeof v !== 'object') return v
    if (seen.has(v)) return JSON.parse(JSON.stringify(v))
    seen.add(v)
    if (Array.isArray(v)) {
      let changed = false
      const out = v.map((x) => {
        const y = walk(x)
        if (y !== x) changed = true
        return y
      })
      return changed ? out : v
    }
    let copy: Record<string, unknown> | null = null
    for (const [k, x] of Object.entries(v)) {
      const y = walk(x)
      if (y !== x) {
        copy = copy ?? { ...(v as Record<string, unknown>) }
        copy[k] = y
      }
    }
    return copy ?? v
  }
  return walk(value) as T
}

function storageForm(doc: DrawDoc, opts: { stored?: number; allowV2?: boolean }): DrawDoc | DrawBody {
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
