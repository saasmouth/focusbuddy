// PlexiiDraw as a saved-snippet surface: how a selection becomes a snippet,
// and how a saved snippet comes back into a drawing.
//
// Both halves are Draw's own clipboard with a different store at the end of
// it, on purpose. Capture takes exactly what Copy takes (copiedNodes: a member
// picked out of a transformed group carries that transform, objects a newer
// PlexiiDraw made are left out) plus exactly the assets and swatches those
// objects use, so an image or a swatch colour survives the trip. Insertion is a
// Paste: the body goes through the same normaliser as anything arriving on the
// clipboard (a snippet row is no more trusted than another app's JSON), gets
// fresh ids for every node and group member (landPayload), and lands where
// Edit › Paste would put it: centred in the window, at the front of the active
// layer, selected, as one undo step.
//
// DUPLICATE ONLY, on purpose. A live Draw snippet would need a new node type
// holding only { snippetId }, resolved on every render. That cannot be done
// honestly today, for three reasons:
//   1. File compatibility. An unknown node type makes the drawing read-only in
//      every build that predates it (shared/draw/compat.ts) and has to raise
//      minWriterVersion; 4.3.33 and earlier have no guard at all and would drop
//      it on save. Inserting a snippet would silently lock the drawing for
//      anyone on an older version.
//   2. Export. The SVG serialiser (shared/draw/svg.ts) is pure and synchronous
//      over the document; it draws on screen, on copy, and on PNG/SVG/PDF
//      export alike. A reference to a row in the snippet library cannot be
//      resolved there, so an exported file would carry a hole or a stale copy
//      -- exactly what a live instance must never be.
//   3. Draw already has a place for live reuse reserved: Illustrator's Symbols
//      (WP-SYMBOLS, F8 and ⇧⌘F11 in commands/keymap.ts), which live inside the
//      drawing and so export and sync with it. A live snippet would be a second,
//      competing mechanism for the same want, the same reason a desk offers
//      Duplicate only (docs/saved-snippets.md).
// So the target declares supports: ['duplicate'] and the library offers
// Duplicate alone.

import { useEffect } from 'react'
import type { DrawSnippetBody, Snippet, SnippetLink, SnippetTarget } from '@shared/snippets'
import type { DrawAsset, DrawDoc, DrawNode, DrawSwatch } from '@shared/draw/model'
import { nodesBounds } from '@shared/draw/ops'
import { drawAssetIdsIn, drawSwatchIdsIn } from '@shared/draw/snippetBody'
import { registerSnippetTarget } from '../../../../stores/snippets'
import { insertIntoOffice, officeAccepts } from '../../../../lib/officeSnippets'
import { v2BlockedReason } from './v2gate'
import { DRAW_CLIPBOARD_KIND, DRAW_CLIPBOARD_VERSION, copiedNodes, landPayload, parseClipboardValue, pasteStorageObstacle, placeIncoming, translateAll } from './clipboard'
import type { EditorCtx } from './types'

/** The link modes a drawing can honour. See the note at the top for why live is not one. */
export const DRAW_SNIPPET_LINKS: SnippetLink[] = ['duplicate']

// ── Capture ──────────────────────────────────────────────────────────────────

// The asset and swatch rules are shared with the edit session's inverse
// (shared/draw/snippetBody.ts snippetFromDrawBody), so a snippet saved from a
// selection and one saved from an edit session carry exactly the same things.

/**
 * Turn the selected objects of a drawing into a draw snippet body.
 *
 * Pure: the document is read, never changed, and the body shares no object
 * with it. `ids` are the objects to save (the studio passes what Copy would
 * take). Positions are made relative to the selection's top-left, so the
 * destination decides where the block lands.
 *
 * Returns null when nothing savable is selected, rather than an empty body:
 * the caller needs to tell "nothing to save" from "saved something empty".
 */
export function drawBodyFromSelection(doc: DrawDoc, ids: string[]): DrawSnippetBody | null {
  const nodes = copiedNodes(doc, ids)
  if (!nodes.length) return null
  const box = nodesBounds(nodes)
  const objects = structuredClone(translateAll(nodes, -box.x, -box.y))
  const assets: Record<string, DrawAsset> = {}
  for (const id of drawAssetIdsIn(objects)) if (Object.prototype.hasOwnProperty.call(doc.assets, id)) assets[id] = structuredClone(doc.assets[id])
  const refs = drawSwatchIdsIn(objects)
  const swatches: DrawSwatch[] = doc.swatches.filter((s) => refs.has(s.id)).map((s) => structuredClone(s))
  return { kind: 'draw', objects, assets, swatches }
}

/** The empty body the save dialog is opened with when nothing is selected, so it can say so. */
export function emptyDrawBody(): DrawSnippetBody {
  return { kind: 'draw', objects: [], assets: {}, swatches: [] }
}

/**
 * A default name for the save dialog: what the person called an object, or the
 * words of a text object. Empty when the selection carries neither, rather than
 * an invented name; the dialog asks for one.
 */
export function suggestedDrawSnippetName(body: DrawSnippetBody): string {
  const nodes = body.objects as DrawNode[]
  const pick = (list: DrawNode[]): string => {
    for (const n of list) {
      if (n.name?.trim()) return n.name.trim()
      if (n.type === 'text' && n.text.trim()) return n.text.trim().split('\n')[0].trim()
      if (n.type === 'group') {
        const inner = pick(n.children)
        if (inner) return inner
      }
    }
    return ''
  }
  const first = pick(nodes)
  return first.length > 60 ? first.slice(0, 57).replace(/\s+\S*$/, '') : first
}

// ── Insertion ────────────────────────────────────────────────────────────────

/**
 * Insert a draw snippet into the drawing as an independent copy.
 *
 * Returns false when it declined, and says why on the status line: a
 * read-only drawing, a link mode a drawing cannot honour, a body that is not a
 * drawing's, a hidden target layer, a drawing kept in the older format that
 * cannot hold what the snippet contains. The store then reports a refusal
 * instead of counting a use that did not happen.
 *
 * The snippet is never changed: its body is copied before anything reads it.
 */
export function insertSnippetIntoDrawing(ctx: EditorCtx, snippet: Snippet, link: SnippetLink): boolean {
  if (!DRAW_SNIPPET_LINKS.includes(link)) return false
  if (snippet.body.kind !== 'draw') return false
  if (ctx.get().readOnly) {
    ctx.status("Can't insert a snippet: this drawing is read-only.")
    return false
  }
  const body = structuredClone(snippet.body)
  // Through the clipboard's own parser: normalised exactly like a stored
  // drawing, with anything a newer PlexiiDraw made left out and counted.
  const parsed = parseClipboardValue({
    kind: DRAW_CLIPBOARD_KIND,
    version: DRAW_CLIPBOARD_VERSION,
    artboard: { x: 0, y: 0, w: 1, h: 1 },
    nodes: Array.isArray(body.objects) ? body.objects : [],
    assets: body.assets && typeof body.assets === 'object' ? body.assets : {},
    swatches: Array.isArray(body.swatches) ? body.swatches : []
  })
  if (!parsed || !parsed.nodes.length) {
    ctx.status(
      parsed?.dropped
        ? `Can't insert "${snippet.name}": everything in it was made in a newer PlexiiDraw.`
        : `Can't insert "${snippet.name}": it holds nothing this drawing can show.`
    )
    return false
  }
  const landed = landPayload(ctx.doc(), parsed)
  const note = parsed.dropped
    ? `${parsed.dropped} object${parsed.dropped === 1 ? '' : 's'} made in a newer PlexiiDraw ${parsed.dropped === 1 ? 'was' : 'were'} left out.`
    : null
  const placed = placeIncoming(ctx, { doc: landed.doc, nodes: landed.nodes, origin: null, note }, 'paste')
  if ('error' in placed) {
    ctx.status(placed.error)
    return false
  }
  const st = ctx.get()
  const why = pasteStorageObstacle(ctx.doc(), placed.doc, st.storedSchema, st.v2Writes)
  if (why) {
    ctx.status(`Can't insert into this drawing yet: it is saved in the older format, which can't hold ${why} (${v2BlockedReason(st)}).`)
    return false
  }
  ctx.history.commit(placed.doc, 'Insert snippet')
  ctx.select(placed.ids)
  ctx.status(note ?? `Inserted "${snippet.name}".`)
  return true
}

// ── The registration ─────────────────────────────────────────────────────────

const targetIds = new WeakMap<EditorCtx, string>()
let nextTarget = 1

/**
 * The registry id for a mounted studio. One place, so the host that registers
 * and the menu that opens the library agree. It identifies the MOUNTED EDITOR,
 * not the document: the same drawing open twice is two destinations, and a
 * closed one is none.
 */
export function drawSnippetTargetId(ctx: EditorCtx): string {
  let id = targetIds.get(ctx)
  if (!id) {
    id = `draw:${nextTarget++}`
    targetIds.set(ctx, id)
  }
  return id
}

/** The target a studio registers. Exported so tests can assert exactly what it claims. */
export function drawSnippetTarget(ctx: EditorCtx, title: string): SnippetTarget {
  return {
    id: drawSnippetTargetId(ctx),
    label: title?.trim() ? `“${title.trim()}”` : 'This drawing',
    // Every kind with a conversion into Draw objects (a diagram as editable
    // vectors, a page as a picture, text as a text object), converted and then
    // landed through the same paste as a draw snippet.
    accepts: officeAccepts('draw'),
    host: 'draw',
    supports: DRAW_SNIPPET_LINKS,
    insert: (snippet, link) => insertIntoOffice(snippet, link, 'draw', (s, l) => insertSnippetIntoDrawing(ctx, s, l))
  }
}

/**
 * Register the open drawing as an insertion target while it is mounted. The
 * effect depends on everything `insert` closes over, so the registry never
 * holds a closure writing into an editor that has been replaced.
 */
export function useDrawSnippetTarget(ctx: EditorCtx, title: string): void {
  useEffect(() => registerSnippetTarget(drawSnippetTarget(ctx, title)), [ctx, title])
}
