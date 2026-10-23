// Applying transforms through the editor: the one path every transform takes
// (panel fields, tools, dialogs, Free Transform, the selection handles,
// arrow-key nudges), so they all honour the same preferences, refuse the same
// things honestly, land as one labelled undo step, and are remembered for
// Object › Transform › Transform Again (⌘D).

import type { Box, Matrix } from '@shared/drawGeometry'
import { keyIncrementPx } from '@shared/draw/fieldExpr'
import { about, isTranslation, refPointOf, translation, type RefPoint } from '@shared/draw/geometry/transform'
import { v2BlockedReason, v2Writable } from '../editor/v2gate'
import type { DrawDoc, DrawNode } from '@shared/draw/model'
import {
  editableIds,
  getObjects,
  mapObjects,
  nodesBounds,
  selectionNeedsFrameMatrix,
  transformEach,
  transformEachMatrix,
  transformObjects,
  transformObjectsBy,
  type TransformEachParams,
  type TransformOptions
} from '@shared/draw/ops'
import type { EditorCtx, EditorState, KeyInput } from '../editor/types'
import { transformPrefs } from './prefs'

/** Where a recorded transform's origin comes from when Transform Again replays it. */
export type OriginSpec =
  /** The matrix is complete in document space (a move; a turn about a point the user clicked). */
  | { kind: 'absolute' }
  /** The matrix is linear, about this reference point of whatever is selected at the time. */
  | { kind: 'ref'; ref: RefPoint }

export type TransformRecord =
  | { kind: 'matrix'; label: string; m: Matrix; origin: OriginSpec; copy: boolean }
  | { kind: 'each'; params: TransformEachParams; copy: boolean }

const LAST = 'transform.last'

/** Is this drawing allowed to hold v2-only content (a frame matrix)? */
export function v2Allowed(s: Pick<EditorState, 'doc' | 'storedSchema' | 'v2Writes'>): boolean {
  return v2Writable(s)
}

export function frameMatrixRefusal(s: Pick<EditorState, 'v2Blocked'>): string {
  return `Reflecting, shearing or skewing text, images and work widgets needs the newer drawing format: ${v2BlockedReason(s)}. Paths and shapes can be transformed any way.`
}

/** The selection's editable ids (locked, hidden and opaque nodes left out). */
export function editableSelection(s: Pick<EditorState, 'doc' | 'selection'>): string[] {
  return editableIds(s.doc, s.selection)
}

/** The visible bounds of the editable selection, or null when nothing editable is selected. */
export function editableBounds(doc: DrawDoc, ids: string[]): Box | null {
  const objs = getObjects(doc, editableIds(doc, ids))
  return objs.length ? nodesBounds(objs) : null
}

/** The transform options in force: the preferences, plus whether this drawing may hold frame matrices. */
export function transformOptions(s: Pick<EditorState, 'doc' | 'storedSchema' | 'v2Writes'>, override: Partial<TransformOptions> = {}): TransformOptions {
  const p = transformPrefs.getState()
  return { scaleStrokes: p.scaleStrokes, scaleCorners: p.scaleCorners, frameMatrix: v2Allowed(s), ...override }
}

/** Text whose box changed gets its line breaks measured again with the real font. */
function remeasure(ctx: EditorCtx, before: DrawDoc, after: DrawDoc, ids: string[]): DrawDoc {
  const prev = new Map(getObjects(before, ids).map((n) => [n.id, n]))
  const text = getObjects(after, ids).filter((n) => n.type === 'text' && prev.get(n.id) !== n)
  if (!text.length) return after
  return mapObjects(
    after,
    text.map((t) => t.id),
    (n: DrawNode) => (n.type === 'text' ? ctx.text.measure(n) : n)
  )
}

export interface Plan {
  doc: DrawDoc
  newIds: string[]
  /** Set when the transform cannot be made, with the honest reason. */
  error?: string
}

/** What a transform WOULD do, without doing it (dialog previews use this). */
export function planMatrix(ctx: EditorCtx, m: Matrix | ((n: DrawNode) => Matrix), copy: boolean, from: DrawDoc = ctx.doc(), optsOverride: Partial<TransformOptions> = {}): Plan {
  const s = ctx.get()
  const ids = editableIds(from, s.selection)
  if (!ids.length) return { doc: from, newIds: [], error: 'Select something that is not locked or hidden first.' }
  const opts = transformOptions({ doc: from, storedSchema: s.storedSchema, v2Writes: s.v2Writes }, optsOverride)
  if (!opts.frameMatrix && selectionNeedsFrameMatrix(from, ids, m)) return { doc: from, newIds: [], error: frameMatrixRefusal(s) }
  const res = typeof m === 'function' ? transformObjectsBy(from, ids, m, opts, copy) : transformObjects(from, ids, m, opts, copy)
  const doc = remeasure(ctx, from, res.doc, copy ? res.newIds : ids)
  return { doc, newIds: res.newIds }
}

/** Remember a transform for Transform Again. */
export function recordTransform(ctx: EditorCtx, rec: TransformRecord): void {
  ctx.set((s) => ({ toolState: { ...s.toolState, [LAST]: rec } }))
}

export function lastTransform(s: Pick<EditorState, 'toolState'>): TransformRecord | null {
  return (s.toolState[LAST] as TransformRecord | undefined) ?? null
}

export interface ApplyOptions {
  label: string
  copy?: boolean
  /** How Transform Again should replay it; false = do not remember it. */
  record?: OriginSpec | false
  /** The linear part about a reference point, when `record` is a 'ref' origin (else the matrix itself is stored). */
  linear?: Matrix
}

/**
 * Transform the editable selection by `m` as ONE undo step. With `copy`, the
 * copies are transformed and selected. Returns false (with an honest status)
 * when nothing could be transformed.
 */
export function applyTransform(ctx: EditorCtx, m: Matrix, o: ApplyOptions): boolean {
  const s = ctx.get()
  if (s.readOnly) return false
  const plan = planMatrix(ctx, m, !!o.copy)
  if (plan.error) {
    ctx.status(plan.error)
    return false
  }
  if (plan.doc !== s.doc) ctx.history.commit(plan.doc, o.label)
  if (o.copy && plan.newIds.length) ctx.select(plan.newIds)
  if (o.record !== false) {
    const origin = o.record ?? { kind: 'absolute' }
    recordTransform(ctx, { kind: 'matrix', label: o.label, m: origin.kind === 'ref' && o.linear ? o.linear : m, origin, copy: !!o.copy })
  }
  return true
}

/** Transform the selection by a linear map about reference point `ref` of its bounds (dialogs, flips, the panel). */
export function applyAboutRef(ctx: EditorCtx, linear: Matrix, ref: RefPoint, o: Omit<ApplyOptions, 'record' | 'linear'> & { record?: boolean }): boolean {
  const s = ctx.get()
  const box = editableBounds(s.doc, s.selection)
  if (!box) {
    ctx.status('Select something that is not locked or hidden first.')
    return false
  }
  const m = about(refPointOf(box, ref), linear)
  return applyTransform(ctx, m, { ...o, record: o.record === false ? false : { kind: 'ref', ref }, linear })
}

/** Object › Transform › Transform Each…, as one undo step. */
export function applyEach(ctx: EditorCtx, params: TransformEachParams, copy: boolean, rand: () => number = Math.random): boolean {
  const s = ctx.get()
  if (s.readOnly) return false
  const ids = editableSelection(s)
  if (!ids.length) {
    ctx.status('Select something that is not locked or hidden first.')
    return false
  }
  const opts = transformOptions(s)
  if (!opts.frameMatrix && selectionNeedsFrameMatrix(s.doc, ids, (n) => transformEachMatrix(nodesBounds([n]), params, () => 1))) {
    ctx.status(frameMatrixRefusal(s))
    return false
  }
  const res = transformEach(s.doc, ids, params, opts, copy, rand)
  const doc = remeasure(ctx, s.doc, res.doc, copy ? res.newIds : ids)
  if (doc !== s.doc) ctx.history.commit(doc, 'Transform Each')
  if (copy && res.newIds.length) ctx.select(res.newIds)
  recordTransform(ctx, { kind: 'each', params, copy })
  return true
}

// Whether Transform Again can act now (and why not) is its command's gate:
// commands/transform.commands.ts againWhy.

/** Object › Transform › Transform Again (⌘D): the last transform, on what is selected now, copies included. */
export function transformAgain(ctx: EditorCtx): boolean {
  const s = ctx.get()
  const rec = lastTransform(s)
  if (!rec) {
    ctx.status('There is no transform to repeat yet.')
    return false
  }
  if (rec.kind === 'each') return applyEach(ctx, rec.params, rec.copy)
  if (rec.origin.kind === 'absolute') return applyTransform(ctx, rec.m, { label: 'Transform Again', copy: rec.copy, record: false })
  const box = editableBounds(s.doc, s.selection)
  if (!box) return false
  return applyTransform(ctx, about(refPointOf(box, rec.origin.ref), rec.m), { label: 'Transform Again', copy: rec.copy, record: false })
}

/**
 * An arrow-key nudge: the document's Keyboard Increment (×10 with Shift), and
 * Alt nudges a copy, as in Illustrator. Remembered for Transform Again.
 */
export function nudgeSelection(ctx: EditorCtx, dx: number, dy: number, key?: Pick<KeyInput, 'shiftKey' | 'altKey'>): void {
  const s = ctx.get()
  const step = keyIncrementPx(s.doc.settings) * (key?.shiftKey ? 10 : 1)
  const m = translation(dx * step, dy * step)
  if (!editableSelection(s).length) return
  applyTransform(ctx, m, { label: key?.altKey ? 'Nudge copy' : 'Nudge', copy: !!key?.altKey })
}

/** Is `m` only a move (so frames never need a matrix for it)? Re-exported for tools. */
export { isTranslation }
