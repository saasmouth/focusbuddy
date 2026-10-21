// The frame every transform dialog shares, Illustrator's layout: the dialog's
// own fields, then Options (Transform Objects / Transform Patterns), Preview,
// and Copy / Cancel / OK.
//
// Preview is live and honest: it streams the transformed artwork onto the
// canvas without adding an undo step; Cancel (or closing the dialog) puts the
// drawing back exactly as it was; OK or Copy then applies the transform once,
// through the same path as everything else, as one labelled undo step.

import { useEffect, useRef, type ReactNode } from 'react'
import { useStore } from 'zustand'
import type { Matrix, Pt } from '@shared/drawGeometry'
import { refPointOf } from '@shared/draw/geometry/transform'
import type { DrawDoc } from '@shared/draw/model'
import type { EditorCtx, Txn } from '../editor/types'
import { applyTransform, editableBounds, planMatrix, type OriginSpec } from './apply'
import { Check } from './fields'
import { setTransformPrefs, transformPrefs } from './prefs'

export interface DialogPlan {
  /** The drawing the transform would produce from `from` (no copy). */
  doc: DrawDoc
  error?: string
}

export interface DialogFrameProps {
  ctx: EditorCtx
  close(): void
  /** Undo label while previewing. */
  label: string
  /** What the transform would do to `from`; recomputed whenever `deps` change. */
  plan(from: DrawDoc): DialogPlan
  /** Apply for real (once), with or without a copy. Return false to keep the dialog open. */
  apply(copy: boolean): boolean
  deps: unknown[]
  children: ReactNode
  /** Extra checkboxes in the Options group (Scale Strokes & Effects, Scale Corners...). */
  options?: ReactNode
  /** False hides the Copy button (Transform Each keeps it; every dialog in Illustrator has one). */
  allowCopy?: boolean
  testId: string
}

export default function DialogFrame({ ctx, close, label, plan, apply, deps, children, options, allowCopy = true, testId }: DialogFrameProps): JSX.Element {
  const prefs = useStore(transformPrefs)
  const before = useRef<DrawDoc>(ctx.doc())
  const txn = useRef<Txn | null>(null)
  const current = plan(before.current)
  const objects = prefs.transformObjects
  const blocked = !objects ? 'Nothing to transform: Transform Patterns has nothing to act on, because PlexiiDraw has no pattern fills yet.' : current.error

  function restore(): void {
    if (!txn.current) return
    ctx.history.replace(before.current)
    txn.current.cancel()
    txn.current = null
  }

  // Live preview: stream the planned drawing; take it back when Preview goes off.
  useEffect(() => {
    if (!prefs.preview || blocked) {
      restore()
      return
    }
    if (!txn.current) txn.current = ctx.history.begin(label)
    txn.current.preview(current.doc)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.preview, blocked, ...deps])

  // Closing the dialog any other way (the X, the scrim, Escape) is a Cancel.
  useEffect(() => () => restore(), []) // eslint-disable-line react-hooks/exhaustive-deps

  function finish(copy: boolean): void {
    if (blocked) return
    restore()
    if (apply(copy)) close()
  }

  return (
    <form
      className="space-y-3 text-[12px]"
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault()
        finish(false)
      }}
    >
      {children}
      <fieldset className="border-t border-[var(--edge-soft)] pt-2">
        <legend className="text-[11px] text-[var(--ink-50)] pr-1">Options</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <Check label="Transform Objects" checked={objects} onChange={(v) => setTransformPrefs({ transformObjects: v })} testId={`${testId}-objects`} />
          <Check
            label="Transform Patterns"
            checked={false}
            disabled
            onChange={() => {}}
            title="PlexiiDraw has no pattern fills yet, so there are no patterns to transform. Gradients always follow the art."
            testId={`${testId}-patterns`}
          />
          {options}
        </div>
      </fieldset>
      {blocked && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400" role="status" data-testid={`${testId}-error`}>
          {blocked}
        </p>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Check label="Preview" checked={prefs.preview} onChange={(v) => setTransformPrefs({ preview: v })} testId={`${testId}-preview`} />
        <div className="flex-1" />
        {allowCopy && (
          <button type="button" className="fb-btn-surface px-3 py-1.5" disabled={!!blocked} onClick={() => finish(true)} data-testid={`${testId}-copy`}>
            Copy
          </button>
        )}
        <button type="button" className="fb-btn-surface px-3 py-1.5" onClick={close} data-testid={`${testId}-cancel`}>
          Cancel
        </button>
        <button type="submit" className="btn-primary px-3 py-1.5" disabled={!!blocked} data-testid={`${testId}-ok`}>
          OK
        </button>
      </div>
    </form>
  )
}

/** A radio group row. */
export function Radios<T extends string>({ name, value, options, onChange, testId }: { name: string; value: T; options: Array<[T, string]>; onChange(v: T): void; testId: string }): JSX.Element {
  return (
    <div className="flex items-center gap-3" role="radiogroup" aria-label={name}>
      {options.map(([v, l]) => (
        <label key={v} className="flex items-center gap-1 text-[12px]">
          <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} data-testid={`${testId}-${v}`} />
          {l}
        </label>
      ))}
    </div>
  )
}

/**
 * Where a dialog's transform is centred: the point the user clicked with a
 * transform tool (Alt-click, Enter, double-click), or else the centre of the
 * selection -- and how Transform Again should replay it.
 */
export function dialogOrigin(ctx: EditorCtx, props: Record<string, unknown> | undefined, from: DrawDoc): { origin: Pt; record: OriginSpec } {
  const p = props?.origin as Pt | undefined
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { origin: p, record: { kind: 'absolute' } }
  const box = editableBounds(from, ctx.get().selection)
  return { origin: box ? refPointOf(box, 'c') : { x: 0, y: 0 }, record: { kind: 'ref', ref: 'c' } }
}

/** Apply a dialog's matrix: about a clicked point it is replayed there; about the centre, about the then-centre. */
export function applyDialogMatrix(ctx: EditorCtx, m: Matrix, record: OriginSpec, label: string, copy: boolean): boolean {
  const linear: Matrix = [m[0], m[1], m[2], m[3], 0, 0]
  return applyTransform(ctx, m, { label, copy, record, linear })
}

/** Plan a dialog's matrix against the drawing as it was when the dialog opened. */
export function planDialogMatrix(ctx: EditorCtx, m: Matrix, from: DrawDoc): DialogPlan {
  const p = planMatrix(ctx, m, false, from)
  return { doc: p.doc, error: p.error }
}
