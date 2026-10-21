// The shared behaviour of Illustrator's Rotate (R), Reflect (O), Scale (S)
// and Shear tools -- each tool file supplies only its matrix:
//
//   - The transform happens about an ORIGIN, shown as a crosshair. It starts
//     at the centre of the selection; click anywhere to move it there, or drag
//     the crosshair itself. It resets when the selection changes.
//   - Drag anywhere else to transform, with a live preview; Shift constrains
//     (45° steps, a uniform scale), and holding Alt (Option) as you drag
//     transforms a COPY instead.
//   - Alt-click sets the origin there and opens the tool's dialog for exact
//     values; so do Enter and a double-click on the tool's toolbox button
//     (about the current origin).
//   - The result is one undo step and is remembered for Transform Again (⌘D):
//     about the same clicked point, or about the centre of whatever is
//     selected then.

import type { Matrix, Pt } from '@shared/drawGeometry'
import { refPointOf } from '@shared/draw/geometry/transform'
import type { DrawDoc } from '@shared/draw/model'
import type { DrawTool, EditorCtx, EditorState, Txn } from '../editor/types'
import { applyTransform, editableBounds, editableSelection, planMatrix } from '../transform/apply'
import { openTransformDialog } from '../commands/transform.commands'

const ORIGIN = 'transform.origin'

interface OriginState {
  p: Pt
  /** The selection it was set for; a different selection resets it. */
  sel: string
}

const selKey = (ids: string[]): string => ids.slice().sort().join('|')

/** The transform origin in force and whether the user placed it, or null with nothing editable selected. */
export function transformOrigin(s: Pick<EditorState, 'doc' | 'selection' | 'toolState'>): { p: Pt; user: boolean } | null {
  const box = editableBounds(s.doc, s.selection)
  if (!box) return null
  const o = s.toolState[ORIGIN] as OriginState | undefined
  if (o && o.sel === selKey(editableSelection(s))) return { p: o.p, user: true }
  return { p: refPointOf(box, 'c'), user: false }
}

export function setTransformOrigin(ctx: EditorCtx, p: Pt | null): void {
  ctx.set((s) => ({ toolState: { ...s.toolState, [ORIGIN]: p ? ({ p, sel: selKey(editableSelection(s)) } satisfies OriginState) : undefined } }))
}

export interface TransformToolSpec {
  id: string
  label: string
  icon: string
  key?: string
  order: number
  dialog: 'rotate' | 'reflect' | 'scale' | 'shear'
  /** Undo label; " copy" is added for an Alt-drag. */
  undo: string
  /** The matrix for a drag from `start` to `p` about origin `o`, or null when it is degenerate. */
  matrix(o: Pt, start: Pt, p: Pt, shift: boolean): Matrix | null
  /** What a plain click does once the user has placed the origin (Reflect: reflect across the axis to the click). */
  clickWithOrigin?: 'transform'
}

type Gesture =
  | { kind: 'origin' }
  | { kind: 'pending'; start: Pt; alt: boolean }
  | { kind: 'drag'; start: Pt; before: DrawDoc; txn: Txn; m: Matrix | null; copy: boolean; error: string | null; origin: Pt; user: boolean }

export function transformTool(spec: TransformToolSpec): DrawTool {
  const gesture = (ctx: EditorCtx): Gesture | null => {
    const g = ctx.get().gesture
    return g && g.toolId === spec.id ? (g.data as Gesture) : null
  }
  const setGesture = (ctx: EditorCtx, data: Gesture): void => ctx.set({ gesture: { toolId: spec.id, data } })

  function finish(ctx: EditorCtx, m: Matrix, origin: Pt, user: boolean, copy: boolean): void {
    const label = copy ? `${spec.undo} copy` : spec.undo
    const linear: Matrix = [m[0], m[1], m[2], m[3], 0, 0]
    if (!applyTransform(ctx, m, { label, copy, record: user ? { kind: 'absolute' } : { kind: 'ref', ref: 'c' }, linear })) return
    // A copy becomes the selection; keep the origin the user placed with it.
    if (user) setTransformOrigin(ctx, origin)
  }

  return {
    id: spec.id,
    label: spec.label,
    icon: spec.icon,
    group: 6,
    order: spec.order,
    key: spec.key,
    cursor: 'crosshair',
    overlayOrder: 40,

    onOptions(ctx) {
      const o = transformOrigin(ctx.get())
      openTransformDialog(ctx, spec.dialog, o?.user ? o.p : undefined)
    },

    onPointerDown(ctx, e) {
      const s = ctx.get()
      if (!editableSelection(s).length) {
        // Nothing to transform yet: a click on an object selects it, as a convenience.
        const hit = ctx.hitTest(e.p)
        if (hit) ctx.select([hit.id])
        else ctx.status(`Select something to ${spec.undo.toLowerCase()} first.`)
        return
      }
      const o = transformOrigin(s)!
      if (!e.altKey && Math.hypot(e.p.x - o.p.x, e.p.y - o.p.y) <= 7 / s.zoom) {
        setGesture(ctx, { kind: 'origin' })
        return
      }
      setGesture(ctx, { kind: 'pending', start: e.p, alt: e.altKey })
    },

    onPointerMove(ctx, e) {
      const g = gesture(ctx)
      if (!g) return
      const s = ctx.get()
      if (g.kind === 'origin') {
        setTransformOrigin(ctx, e.p)
        return
      }
      let d = g
      if (d.kind === 'pending') {
        if (Math.hypot(e.p.x - d.start.x, e.p.y - d.start.y) < 3 / s.zoom) return
        const o = transformOrigin(s)!
        d = { kind: 'drag', start: d.start, before: s.doc, txn: ctx.history.begin(spec.undo), m: null, copy: false, error: null, origin: o.p, user: o.user }
      }
      const m = spec.matrix(d.origin, d.start, e.p, e.shiftKey)
      const copy = e.altKey
      if (!m) {
        d.txn.preview(d.before)
        setGesture(ctx, { ...d, m: null, copy, error: null })
        return
      }
      const plan = planMatrix(ctx, m, copy, d.before)
      d.txn.preview(plan.error ? d.before : plan.doc)
      if (plan.error) ctx.status(plan.error)
      setGesture(ctx, { ...d, m, copy, error: plan.error ?? null })
    },

    onPointerUp(ctx, e) {
      const g = gesture(ctx)
      if (!g) return
      if (g.kind === 'origin') return
      if (g.kind === 'pending') {
        if (g.alt) {
          // Alt-click: the origin goes here, and the dialog asks for exact values.
          setTransformOrigin(ctx, e.p)
          openTransformDialog(ctx, spec.dialog, e.p)
          return
        }
        const o = transformOrigin(ctx.get())
        if (spec.clickWithOrigin === 'transform' && o?.user) {
          const m = spec.matrix(o.p, o.p, e.p, e.shiftKey)
          if (m) finish(ctx, m, o.p, true, false)
          return
        }
        setTransformOrigin(ctx, e.p)
        return
      }
      // drag: put the drawing back, then apply once through the shared path.
      ctx.history.replace(g.before)
      g.txn.cancel()
      if (!g.m || g.error) return
      finish(ctx, g.m, g.origin, g.user, g.copy)
    },

    Overlay({ state, k }) {
      if (state.tool !== spec.id) return null
      const o = transformOrigin(state)
      if (!o) return null
      const r = 5 * k
      return (
        <g data-testid={`draw-${spec.id}-origin`} pointerEvents="none">
          <circle cx={o.p.x} cy={o.p.y} r={r} fill="none" stroke="#0ea5e9" strokeWidth={1.5 * k} />
          <line x1={o.p.x - 2 * r} y1={o.p.y} x2={o.p.x + 2 * r} y2={o.p.y} stroke="#0ea5e9" strokeWidth={k} />
          <line x1={o.p.x} y1={o.p.y - 2 * r} x2={o.p.x} y2={o.p.y + 2 * r} stroke="#0ea5e9" strokeWidth={k} />
        </g>
      )
    }
  }
}

/** Snap a UI angle to 45° steps (Shift). */
export function snap45(deg: number): number {
  return Math.round(deg / 45) * 45
}
