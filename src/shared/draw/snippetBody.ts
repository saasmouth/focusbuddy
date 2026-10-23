// A saved Draw snippet opened as a drawing, and the edited drawing written
// back as a snippet: the two conversions an "Open original" edit session
// (components/snippets/SnippetEditSessionView.tsx) needs, since DrawStudio
// edits a DOCUMENT and a DrawSnippetBody (shared/snippets.ts) is not one.
//
// The snippet format is what "Save selection as snippet…" writes
// (renderer/.../draw/editor/drawSnippets.ts drawBodyFromSelection): Draw's
// clipboard nodes, moved so the top-left of their bounds (nodesBounds) is the
// origin, plus exactly the assets and swatches they use. It carries no size,
// no origin, no artboard and no layers. These functions are its exact inverse
// pair, and both are pure: nothing passed in is changed, nothing returned
// shares an object with what was passed in.
//
// drawBodyFromSnippet: snippet -> v2 drawing.
//   - One vector layer holding the objects, ids and coordinates untouched.
//   - One artboard around them: their visible box (nodesBounds, widened by
//     half the widest stroke, as Draw's own copy crops it) snapped out to
//     whole pixels, plus SNIPPET_ARTBOARD_MARGIN on every side, transparent.
//     The artboard moves to the art, never the art to the artboard: a
//     translation of a float coordinate and back is not always exact, and a
//     snippet opened and saved a hundred times must not creep. So the
//     artboard's top-left is usually negative (a snippet's art starts at 0).
//     An empty snippet gets SNIPPET_EMPTY_ARTBOARD at the origin.
//   - Through normalizeDrawDoc, Draw's own funnel for untrusted JSON, so a
//     damaged or hostile body opens as a valid drawing (or an honestly
//     read-only one, for objects a newer PlexiiDraw made) and nothing throws.
//
// snippetFromDrawBody: edited drawing -> snippet, plus what did not fit.
//   - Every object of every vector layer, bottom to top, groups, clipping
//     groups and every node kind intact; objects a newer PlexiiDraw made go
//     back as the JSON they arrived as, never dropped.
//   - Moved so their bounds start at the origin, as capture does; within
//     SNIPPET_ORIGIN_EPSILON of it already, they are not moved at all.
//   - Exactly the assets and swatches those objects use (capture's rule).
//   - `kind: 'draw'`, and every other field of `prev` kept verbatim.
//   - `lost`: one plain sentence per thing the snippet cannot hold as it was
//     in the drawing. NEVER silent. Content the format CAN hold another way is
//     kept that way and still listed (a paint layer becomes a picture object);
//     content it cannot hold is listed and left out. The host shows these
//     before it writes; an empty list means the snippet holds everything.

import type { DrawSnippetBody } from '../snippets'
import type { Box } from '../drawGeometry'
import type {
  DrawArtboard,
  DrawAsset,
  DrawDoc,
  DrawDocLayer,
  DrawDocVectorLayer,
  DrawImageNode,
  DrawNode,
  DrawSwatch
} from './model'
import { normalizeDrawDoc } from './normalize'
import { nodesBounds, rasterLayerFrame, translateNode } from './ops'
import { drawId } from '../draw'

/** Space around the art on the snippet's artboard, in px, on every side. */
export const SNIPPET_ARTBOARD_MARGIN = 32

/** The artboard of a snippet with nothing measurable in it. */
export const SNIPPET_EMPTY_ARTBOARD = { w: 400, h: 300 } as const

/** Bounds this close to the origin are AT the origin: the art is left exactly where it is. */
export const SNIPPET_ORIGIN_EPSILON = 1e-6

/** Ids of the layer and artboard a snippet opens on (the snippet holds no ids for them). */
export const SNIPPET_LAYER_ID = 'snippet-layer'
export const SNIPPET_ARTBOARD_ID = 'snippet-artboard'

/** What the snippet will hold, and every way that differs from the drawing. */
export interface DrawSnippetFromBody {
  body: DrawSnippetBody
  /** One sentence each, for the person, before anything is written. Empty when nothing differs. */
  lost: string[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>

function isObj(v: unknown): v is Raw {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** A deep copy, or undefined when the value cannot be copied (functions, getters that throw). */
function safeClone<T>(v: T): T | undefined {
  try {
    return structuredClone(v)
  } catch {
    try {
      return JSON.parse(JSON.stringify(v)) as T
    } catch {
      return undefined
    }
  }
}

/** Every asset id the nodes use, anywhere in the tree (capture's rule). */
export function drawAssetIdsIn(
  nodes: readonly DrawNode[],
  out: Set<string> = new Set()
): Set<string> {
  for (const n of nodes) {
    if (n.type === 'image') out.add(n.assetId)
    else if (n.type === 'group') drawAssetIdsIn(n.children, out)
  }
  return out
}

/** Every swatch id a value's paints reference: fills, strokes, appearance stacks, gradients (capture's rule). */
export function drawSwatchIdsIn(v: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (!v || typeof v !== 'object' || depth > 200) return out
  if (Array.isArray(v)) {
    for (const x of v) drawSwatchIdsIn(x, out, depth + 1)
    return out
  }
  const o = v as Raw
  if (o.type === 'swatch' && typeof o.id === 'string') out.add(o.id)
  for (const k of Object.keys(o)) if (k !== 'raw') drawSwatchIdsIn(o[k], out, depth + 1)
  return out
}

/** The widest stroke anywhere in the nodes, so the artboard leaves room for it (as Draw's copy crop does). */
function maxStroke(nodes: readonly DrawNode[]): number {
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

/**
 * The artboard a snippet's objects open on: their visible box snapped out to
 * whole pixels, plus the margin. Exported so a host or a test can state it.
 */
export function snippetArtboardBox(nodes: readonly DrawNode[]): Box {
  const measurable = nodes.filter((n) => n.type !== 'opaque')
  const b = nodesBounds(measurable as DrawNode[])
  if (!measurable.length || !(b.w > 0 || b.h > 0) || ![b.x, b.y, b.w, b.h].every(Number.isFinite)) {
    return { x: 0, y: 0, w: SNIPPET_EMPTY_ARTBOARD.w, h: SNIPPET_EMPTY_ARTBOARD.h }
  }
  const pad = Math.ceil(maxStroke(measurable) / 2) + SNIPPET_ARTBOARD_MARGIN
  const x = Math.floor(b.x) - pad
  const y = Math.floor(b.y) - pad
  return { x, y, w: Math.ceil(b.x + b.w) + pad - x, h: Math.ceil(b.y + b.h) + pad - y }
}

/** Give every node after the first holder of an id a fresh one (a hostile body can repeat ids). */
function dedupeIds(nodes: DrawNode[], seen: Set<string>): void {
  for (const n of nodes) {
    if (seen.has(n.id)) n.id = drawId('obj')
    seen.add(n.id)
    if (n.type === 'group') dedupeIds(n.children, seen)
  }
}

/** How many nodes a raw object list holds, nested ones included (up to Draw's group depth). */
function countRaw(list: unknown, depth = 0): number {
  if (!Array.isArray(list) || depth > 64) return 0
  let c = 0
  for (const v of list) {
    if (!isObj(v)) continue
    c += 1
    if (v.type === 'group') c += countRaw(v.children, depth + 1)
  }
  return c
}

function countNodes(nodes: readonly DrawNode[]): number {
  let c = 0
  for (const n of nodes) c += 1 + (n.type === 'group' ? countNodes(n.children) : 0)
  return c
}

function emptyDoc(): DrawDoc {
  return snippetDoc([], {}, [])
}

function snippetDoc(objects: unknown[], assets: unknown, swatches: unknown): DrawDoc {
  return normalizeDrawDoc({
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [
      {
        id: SNIPPET_ARTBOARD_ID,
        name: 'Snippet',
        x: 0,
        y: 0,
        w: SNIPPET_EMPTY_ARTBOARD.w,
        h: SNIPPET_EMPTY_ARTBOARD.h,
        background: { type: 'none' }
      }
    ],
    activeArtboardId: SNIPPET_ARTBOARD_ID,
    layers: [
      {
        id: SNIPPET_LAYER_ID,
        kind: 'vector',
        name: 'Snippet',
        visible: true,
        locked: false,
        opacity: 1,
        blend: 'normal',
        objects
      }
    ],
    activeLayerId: SNIPPET_LAYER_ID,
    assets,
    swatches,
    guides: [],
    settings: {}
  })
}

// ── Snippet -> drawing ───────────────────────────────────────────────────────

/**
 * A saved Draw snippet as a v2 drawing DrawStudio can open (its `content`).
 * Never throws: a body that cannot be read at all opens as an empty drawing.
 */
export function drawBodyFromSnippet(snip: DrawSnippetBody): DrawDoc {
  try {
    const copy = safeClone(snip as unknown)
    if (!isObj(copy)) return emptyDoc()
    const objects = Array.isArray(copy.objects) ? copy.objects : []
    const assets = isObj(copy.assets) ? copy.assets : {}
    const swatches = Array.isArray(copy.swatches) ? copy.swatches : []
    const doc = snippetDoc(objects, assets, swatches)
    const layer = doc.layers[0] as DrawDocVectorLayer
    dedupeIds(layer.objects, new Set())
    const box = snippetArtboardBox(layer.objects)
    const board: DrawArtboard = { ...doc.artboards[0], ...box }
    // Through normalize once more, for the artboard (a body with absurd
    // coordinates gets an artboard clamped to what Draw can hold, not NaN).
    return normalizeDrawDoc({ ...doc, artboards: [board] })
  } catch {
    return emptyDoc()
  }
}

// ── Drawing -> snippet ───────────────────────────────────────────────────────

const quote = (s: string): string => `“${s}”`

/** Opaque nodes back to the JSON they arrived as (a newer PlexiiDraw's objects travel untouched). */
function restoreOpaque(nodes: DrawNode[]): unknown[] {
  return nodes.map((n) => {
    if (n.type === 'opaque') return n.raw
    if (n.type === 'group') return { ...n, children: restoreOpaque(n.children) }
    return n
  })
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** A paint layer's pixels as one picture object, where they lay. */
function paintAsImage(
  doc: DrawDoc,
  l: Extract<DrawDocLayer, { kind: 'raster' }>,
  id: string
): DrawImageNode {
  const f = rasterLayerFrame(doc, l)
  return {
    id,
    type: 'image',
    name: l.name,
    x: f.x,
    y: f.y,
    w: f.w,
    h: f.h,
    assetId: l.assetId!,
    ...(l.opacity !== 1 ? { opacity: l.opacity } : {}),
    ...(l.blend !== 'normal' ? { blend: l.blend } : {}),
    ...(!l.visible ? { hidden: true } : {})
  }
}

/**
 * The edited drawing (DrawStudio's onChange body: a v2 document, or anything
 * else, which is normalised first) as a snippet body, with every way it
 * differs from the drawing in `lost`.
 *
 * `prev` is the snippet the session opened: its fields other than kind,
 * objects, assets and swatches are kept, and objects in it that could not be
 * opened (damaged data) are reported rather than quietly left behind.
 *
 * Never throws. A body that cannot be read at all gives `prev` back unchanged
 * with one line saying so, so a Save writes nothing new.
 */
export function snippetFromDrawBody(body: unknown, prev?: DrawSnippetBody): DrawSnippetFromBody {
  const prevExtras: Raw = {}
  const prevCopy = prev !== undefined ? safeClone(prev as unknown) : undefined
  if (isObj(prevCopy)) {
    for (const [k, v] of Object.entries(prevCopy))
      if (k !== 'kind' && k !== 'objects' && k !== 'assets' && k !== 'swatches') prevExtras[k] = v
  }
  const unchanged = (why: string): DrawSnippetFromBody => {
    const p = isObj(prevCopy) ? prevCopy : {}
    return {
      body: {
        ...prevExtras,
        kind: 'draw',
        objects: Array.isArray(p.objects) ? p.objects : [],
        assets: isObj(p.assets) ? p.assets : {},
        swatches: Array.isArray(p.swatches) ? p.swatches : []
      },
      lost: [why]
    }
  }
  const unreadable = 'The edited drawing could not be read, so the snippet is left as it was.'
  // A drawing has a layer list (v1 and v2 alike); anything else is not one.
  if (!isObj(body) || !Array.isArray(body.layers)) return unchanged(unreadable)
  try {
    const copy = safeClone(body)
    if (!isObj(copy)) return unchanged(unreadable)
    const doc = normalizeDrawDoc(copy)
    const lost: string[] = []

    // Objects, bottom to top, layer by layer.
    const objects: DrawNode[] = []
    const used = new Set<string>()
    const collectIds = (ns: DrawNode[]): void => {
      for (const n of ns) {
        used.add(n.id)
        if (n.type === 'group') collectIds(n.children)
      }
    }
    for (const l of doc.layers) if (l.kind === 'vector' && !l.template) collectIds(l.objects)

    // Layers that put something into the snippet (an empty layer loses nothing).
    let contributing = 0
    for (const l of doc.layers) {
      if (l.kind === 'vector') {
        if (l.template) {
          if (l.objects.length)
            lost.push(
              `Template layer ${quote(l.name)} is left out: a template is a tracing guide, not part of the art.`
            )
          continue
        }
        if (!l.objects.length) continue
        if (!l.visible)
          lost.push(`Layer ${quote(l.name)} is hidden, so its objects are kept hidden.`)
        if (l.opacity !== 1 || l.blend !== 'normal')
          lost.push(
            `Layer ${quote(l.name)}'s opacity and blending are not kept: a snippet holds objects, not layers.`
          )
        for (const n of l.objects)
          objects.push(l.visible || n.hidden ? n : ({ ...n, hidden: true } as DrawNode))
        contributing += 1
        continue
      }
      // A paint layer: its pixels become a picture object where they lay.
      if (!l.assetId) continue
      if (!Object.prototype.hasOwnProperty.call(doc.assets, l.assetId)) {
        lost.push(`Paint layer ${quote(l.name)} could not be read, so it is left out.`)
        continue
      }
      let id = l.id
      if (used.has(id)) id = drawId('obj')
      used.add(id)
      objects.push(paintAsImage(doc, l, id))
      contributing += 1
      lost.push(
        `Paint layer ${quote(l.name)} is kept as a picture: a snippet holds objects, so it can't be painted on as a layer.`
      )
    }
    if (contributing > 1)
      lost.push(
        `The drawing's ${contributing} layers are flattened into one stack of objects, in the same order.`
      )

    // Artboards: a snippet has none; the art on them is all kept.
    if (doc.artboards.length > 1) {
      lost.push(
        `${plural(doc.artboards.length - 1, 'more artboard is', 'more artboards are')} not kept: a snippet has no artboards. The art on them is kept.`
      )
    }
    if (doc.artboards.some((a) => a.background.type !== 'none'))
      lost.push('The artboard background is not kept: a snippet has no page of its own.')

    // Moved so their bounds start at the origin, as capture leaves them.
    const box = nodesBounds(objects.filter((n) => n.type !== 'opaque'))
    const dx = Number.isFinite(box.x) && Math.abs(box.x) > SNIPPET_ORIGIN_EPSILON ? -box.x : 0
    const dy = Number.isFinite(box.y) && Math.abs(box.y) > SNIPPET_ORIGIN_EPSILON ? -box.y : 0
    const placed = dx === 0 && dy === 0 ? objects : objects.map((n) => translateNode(n, dx, dy))

    // Exactly the assets and swatches the objects use.
    const assets: Record<string, DrawAsset> = {}
    for (const id of drawAssetIdsIn(placed))
      if (Object.prototype.hasOwnProperty.call(doc.assets, id)) assets[id] = doc.assets[id]
    const refs = drawSwatchIdsIn(placed)
    const swatches: DrawSwatch[] = doc.swatches.filter((s) => refs.has(s.id))
    const unusedSwatches = doc.swatches.length - swatches.length
    if (unusedSwatches > 0)
      lost.push(
        `${plural(unusedSwatches, 'swatch', 'swatches')} no object uses ${unusedSwatches === 1 ? 'is' : 'are'} not kept: a snippet keeps the swatches its objects use.`
      )

    // Objects in the saved snippet that never opened (damaged data).
    if (isObj(prevCopy)) {
      const raw = countRaw(prevCopy.objects)
      const opened = countNodes(
        (drawBodyFromSnippet(prev!).layers[0] as DrawDocVectorLayer | undefined)?.objects ?? []
      )
      if (raw > opened)
        lost.push(
          `${plural(raw - opened, 'object', 'objects')} in the saved snippet could not be read (damaged data, or a picture with no image) and ${raw - opened === 1 ? 'is' : 'are'} not kept.`
        )
    }

    // `copy` was cloned from `body` before anything read it, and `prevExtras`
    // from `prev`, so nothing here is shared with either.
    return {
      body: { ...prevExtras, kind: 'draw', objects: restoreOpaque(placed), assets, swatches },
      lost
    }
  } catch {
    return unchanged(unreadable)
  }
}
