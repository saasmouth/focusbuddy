// The Transform panel (Illustrator's Window › Transform): X, Y, W and H of the
// selection measured at the 9-point reference point, in the document's units
// and relative to the artboard; Rotate and Shear; Constrain Width and Height
// Proportions; Scale Corners and Scale Strokes & Effects; and Flip Horizontal /
// Vertical. Every field takes expressions ("100+20", "50%", "2in", "*2") and
// commits one undo step on Enter or blur. Everything applies through
// transform/apply.ts, so Transform Again repeats a panel edit too.

import { useStore } from 'zustand'
import Icon from '../../../Icon'
import type { Box, Matrix } from '@shared/drawGeometry'
import { about, boxToBox, decompose, invertMatrix, recompose, refFractions, refPointOf, rotation, translation, type RefPoint } from '@shared/draw/geometry/transform'
import type { DrawDoc, DrawNode } from '@shared/draw/model'
import { editableIds, getObjects, nodeOrientation, nodesBounds, primaryArtboard } from '@shared/draw/ops'
import type { DrawPanel, EditorCtx } from '../editor/types'
import { applyTransform } from '../transform/apply'
import { Check, NumField, RefLocator } from '../transform/fields'
import { setTransformPrefs, transformPrefs } from '../transform/prefs'

/** The linear matrix a single node carries (frames: matrix × turn; groups: their matrix); identity for paths. */
function nodeLinear(n: DrawNode): Matrix {
  if (n.type === 'group') return n.transform ? [n.transform[0], n.transform[1], n.transform[2], n.transform[3], 0, 0] : [1, 0, 0, 1, 0, 0]
  if (n.type === 'text' || n.type === 'image' || n.type === 'widget') {
    const r = rotation(n.rotation ?? 0)
    if (!n.transform) return r
    const t = n.transform
    return [t[0] * r[0] + t[2] * r[1], t[1] * r[0] + t[3] * r[1], t[0] * r[2] + t[2] * r[3], t[1] * r[2] + t[3] * r[3], 0, 0]
  }
  return [1, 0, 0, 1, 0, 0]
}

export interface TransformReadout {
  ids: string[]
  box: Box
  /** The node whose own turn and shear the panel shows, when exactly one is selected. */
  single: DrawNode | null
  /** UI degrees: counter-clockwise turn, clockwise-positive shear. */
  rotate: number
  shear: number
}

/** What the panel shows for the editable selection, or null when nothing editable is selected. */
export function transformReadout(doc: DrawDoc, selection: string[]): TransformReadout | null {
  const ids = editableIds(doc, selection)
  const objs = getObjects(doc, ids)
  if (!objs.length) return null
  const single = objs.length === 1 ? objs[0] : null
  const o = single ? nodeOrientation(single) : { rotation: 0, skew: 0 }
  const clean = (v: number): number => (Math.abs(v) < 1e-9 ? 0 : v)
  return { ids, box: nodesBounds(objs), single, rotate: clean(-o.rotation), shear: clean(-o.skew) }
}

/** The box with its reference point kept where it is and a new width and height. */
function resizedAt(b: Box, ref: RefPoint, w: number, h: number): Box {
  const p = refPointOf(b, ref)
  const { fx, fy } = refFractions(ref)
  return { x: p.x - fx * w, y: p.y - fy * h, w, h }
}

/** The change that turns a node's current turn/shear into the typed one (identity part kept). */
export function orientationDelta(single: DrawNode | null, want: { rotate?: number; shear?: number }): Matrix | null {
  const cur = single ? nodeLinear(single) : ([1, 0, 0, 1, 0, 0] as Matrix)
  const d = decompose(cur)
  const next = recompose({
    ...d,
    translateX: 0,
    translateY: 0,
    rotation: want.rotate !== undefined ? -want.rotate : d.rotation,
    skew: want.shear !== undefined ? -want.shear : d.skew
  })
  const inv = invertMatrix(cur)
  if (!inv) return null
  const m = [
    next[0] * inv[0] + next[2] * inv[1],
    next[1] * inv[0] + next[3] * inv[1],
    next[0] * inv[2] + next[2] * inv[3],
    next[1] * inv[2] + next[3] * inv[3],
    0,
    0
  ] as Matrix
  return m
}

function TransformPanel({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const doc = useStore(ctx.store, (s) => s.doc)
  const selection = useStore(ctx.store, (s) => s.selection)
  const readOnly = useStore(ctx.store, (s) => s.readOnly)
  const prefs = useStore(transformPrefs)
  const r = transformReadout(doc, selection)
  const board = primaryArtboard(doc)
  const settings = doc.settings
  const ref = prefs.refPoint
  const off = readOnly || !r

  const rp = r ? refPointOf(r.box, ref) : null
  const apply = (m: Matrix, label: string, linear?: Matrix): void => {
    applyTransform(ctx, m, linear ? { label, record: { kind: 'ref', ref }, linear } : { label, record: { kind: 'absolute' } })
  }

  function setPos(axis: 'x' | 'y', v: number): void {
    if (!r || !rp) return
    const now = axis === 'x' ? rp.x - board.x : rp.y - board.y
    if (Math.abs(v - now) < 1e-9) return
    apply(axis === 'x' ? translation(v - now, 0) : translation(0, v - now), 'Move')
  }

  function setSize(axis: 'w' | 'h', v: number): void {
    if (!r) return
    const b = r.box
    if (v <= 0) {
      ctx.status('Width and height have to be more than 0.')
      return
    }
    let w = axis === 'w' ? v : b.w
    let h = axis === 'h' ? v : b.h
    if (prefs.constrain) {
      if (axis === 'w' && b.w > 0) h = b.h * (v / b.w)
      if (axis === 'h' && b.h > 0) w = b.w * (v / b.h)
    }
    if (Math.abs(w - b.w) < 1e-9 && Math.abs(h - b.h) < 1e-9) return
    const m = boxToBox(b, resizedAt(b, ref, w, h), ref)
    apply(m, 'Scale', [m[0], 0, 0, m[3], 0, 0])
  }

  function setOrientation(want: { rotate?: number; shear?: number }, label: string): void {
    if (!r || !rp) return
    if (want.shear !== undefined && Math.abs(Math.cos((want.shear * Math.PI) / 180)) < 1e-3) {
      ctx.status('A shear of 90° would flatten the artwork into a line.')
      return
    }
    const d = orientationDelta(r.single, want)
    if (!d) return
    apply(about(rp, d), label, d)
  }

  const zeroW = !!r && r.box.w < 1e-9
  const zeroH = !!r && r.box.h < 1e-9

  return (
    <div className="h-full overflow-y-auto px-2 py-1.5 space-y-1.5" data-testid="draw-transform-panel">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-[var(--ink-60)]">Transform</span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="icon-btn !h-5 !w-5"
            title="Flip Horizontal (about the reference point)"
            aria-label="Flip Horizontal"
            disabled={off}
            onClick={() => ctx.run('object.flipHorizontal')}
            data-testid="draw-transform-flip-h"
          >
            <Icon name="flip" size={13} />
          </button>
          <button
            type="button"
            className="icon-btn !h-5 !w-5"
            title="Flip Vertical (about the reference point)"
            aria-label="Flip Vertical"
            disabled={off}
            onClick={() => ctx.run('object.flipVertical')}
            data-testid="draw-transform-flip-v"
          >
            <Icon name="flip" size={13} className="rotate-90" />
          </button>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <RefLocator value={ref} onChange={(refPoint) => setTransformPrefs({ refPoint })} />
        <div className="flex-1 min-w-0 grid grid-cols-[1fr_auto_1fr] gap-x-1 gap-y-1 items-center">
          <NumField label="X" prefix="X" kind="length" settings={settings} value={rp ? rp.x - board.x : null} onCommit={(v) => setPos('x', v)} disabled={off} testId="draw-transform-x" />
          <span />
          <NumField label="Width" prefix="W" kind="length" settings={settings} value={r ? r.box.w : null} onCommit={(v) => setSize('w', v)} disabled={off || zeroW} title={zeroW ? 'Width — this selection has no width to scale' : 'Width'} testId="draw-transform-w" />
          <NumField label="Y" prefix="Y" kind="length" settings={settings} value={rp ? rp.y - board.y : null} onCommit={(v) => setPos('y', v)} disabled={off} testId="draw-transform-y" />
          <span />
          <NumField label="Height" prefix="H" kind="length" settings={settings} value={r ? r.box.h : null} onCommit={(v) => setSize('h', v)} disabled={off || zeroH} title={zeroH ? 'Height — this selection has no height to scale' : 'Height'} testId="draw-transform-h" />
        </div>
        <button
          type="button"
          className={`icon-btn !h-5 !w-5 self-center ${prefs.constrain ? 'bg-accent/15 text-accent' : ''}`}
          title="Constrain Width and Height Proportions"
          aria-label="Constrain Width and Height Proportions"
          aria-pressed={prefs.constrain}
          onClick={() => setTransformPrefs({ constrain: !prefs.constrain })}
          data-testid="draw-transform-constrain"
        >
          <Icon name={prefs.constrain ? 'link' : 'link_off'} size={13} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1">
        <NumField
          label="Rotate"
          prefix="⟲"
          kind="deg"
          value={r ? r.rotate : null}
          onCommit={(v) => setOrientation({ rotate: v }, 'Rotate')}
          disabled={off}
          title="Rotate (counter-clockwise). Paths keep their geometry baked, so a path reads 0° after turning."
          testId="draw-transform-rotate"
        />
        <NumField label="Shear" prefix="⫽" kind="deg" value={r ? r.shear : null} onCommit={(v) => setOrientation({ shear: v }, 'Shear')} disabled={off} title="Shear (a positive angle slants clockwise)" testId="draw-transform-shear" />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        <Check label="Scale Corners" checked={prefs.scaleCorners} onChange={(b) => setTransformPrefs({ scaleCorners: b })} testId="draw-transform-scale-corners" />
        <Check label="Scale Strokes & Effects" checked={prefs.scaleStrokes} onChange={(b) => setTransformPrefs({ scaleStrokes: b })} testId="draw-transform-scale-strokes" />
      </div>
    </div>
  )
}

const transform: DrawPanel = {
  id: 'transform',
  title: 'Transform',
  dock: 'right',
  order: 15,
  height: 168,
  when: (s) => s.selection.length > 0,
  component: TransformPanel
}

export default transform
