// The editor's side of several artboards (WP-ARTBOARD): which one is active,
// whether this drawing may change its artboards, and the work behind the
// Artboard tool, Object › Artboards and the Artboards panel. The document
// operations themselves are pure, in @shared/draw/ops (artboards.ts).

import { drawId } from '@shared/draw'
import type { Box } from '@shared/drawGeometry'
import type { DrawDoc, DrawNode } from '@shared/draw/model'
import { artboardAt, artboardById, primaryArtboard, setActiveArtboard } from '@shared/draw/ops'
import { withFreshIds } from './clipboard'
import { v2BlockedReason, v2Writable } from './v2gate'
import type { EditorCtx, EditorState } from './types'

/**
 * Make an artboard the active one. Not an edit: no undo step and nothing is
 * saved for it (the active artboard is written with the next real edit), so
 * clicking about a read-only drawing or a live session changes nobody's file.
 */
export function activateArtboard(ctx: Pick<EditorCtx, 'get' | 'set'>, id: string): void {
  const doc = ctx.get().doc
  const next = setActiveArtboard(doc, id)
  if (next !== doc) ctx.set({ doc: next })
}

/** Activate the artboard under a point, if there is one (a click anywhere on a page makes it active, as in Illustrator). */
export function activateArtboardAt(ctx: Pick<EditorCtx, 'get' | 'set'>, p: { x: number; y: number }): void {
  const a = artboardAt(ctx.get().doc, p)
  if (a && a.id !== primaryArtboard(ctx.get().doc).id) activateArtboard(ctx, a.id)
}

/**
 * May the artboards change now? Several artboards, named or moved ones are
 * v2-only content, so a drawing that must stay v1 for a live session cannot
 * take them; a read-only drawing takes nothing.
 */
export function artboardsEditable(s: Pick<EditorState, 'readOnly' | 'doc' | 'storedSchema' | 'v2Writes'>): boolean {
  return !s.readOnly && v2Writable(s)
}

/** Why the artboards cannot change, as a sentence; null when they can. */
export function artboardsBlockedReason(s: EditorState): string | null {
  if (s.readOnly) return 'This artwork is read-only.'
  if (!v2Writable(s)) return `Artboards can't be added or changed in this drawing yet: ${v2BlockedReason(s)}.`
  return null
}

/** Refuse with a status line when the artboards may not change; true when they may. */
export function guardArtboards(ctx: EditorCtx): boolean {
  const why = artboardsBlockedReason(ctx.get())
  if (why) ctx.status(why)
  return !why
}

/** A fresh id for a new artboard. */
export function newArtboardId(): string {
  return drawId('artboard')
}

/** Copies of art with fresh ids throughout (for duplicating an artboard with its art). */
export function copyNode(n: DrawNode): DrawNode {
  return withFreshIds(n)
}

/** Move/Copy Artwork with Artboard (Illustrator's option): on unless turned off for this session. */
export function moveArtWithArtboard(s: Pick<EditorState, 'toolState'>): boolean {
  return (s.toolState.artboard as { withArt?: boolean } | undefined)?.withArt !== false
}

/** The document box to fit when showing every artboard (View › Fit All in Window). */
export function allArtboardsBox(doc: DrawDoc): Box {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const a of doc.artboards) {
    x0 = Math.min(x0, a.x)
    y0 = Math.min(y0, a.y)
    x1 = Math.max(x1, a.x + a.w)
    y1 = Math.max(y1, a.y + a.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** The artboard `step` places from the active one in panel order (wrapping), for Next / Previous Artboard. */
export function steppedArtboard(doc: DrawDoc, step: number): string | null {
  if (doc.artboards.length < 2) return null
  const i = doc.artboards.findIndex((a) => a.id === primaryArtboard(doc).id)
  const n = doc.artboards.length
  return doc.artboards[(((i + step) % n) + n) % n].id
}

/** Is `id` an artboard of this drawing? */
export function hasArtboard(doc: DrawDoc, id: unknown): id is string {
  return typeof id === 'string' && !!artboardById(doc, id)
}
