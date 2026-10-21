// Object › Transform › Scale… (and Alt-click, Enter or a double-click with the
// Scale tool): Uniform, or Non-Uniform Horizontal and Vertical, in percent,
// with Scale Corners and Scale Strokes & Effects (the same preferences the
// Transform panel and the selection handles use).

import { useState } from 'react'
import { uiScale } from '@shared/draw/geometry/transform'
import { useStore } from 'zustand'
import type { DrawDialog } from '../editor/types'
import DialogFrame, { Radios, applyDialogMatrix, dialogOrigin, planDialogMatrix } from '../transform/DialogFrame'
import { Check, NumField } from '../transform/fields'
import { rememberDialog, setTransformPrefs, transformPrefs } from '../transform/prefs'

const scale: DrawDialog = {
  id: 'transform-scale',
  title: 'Scale',
  component: function ScaleDialog({ ctx, props, close }) {
    const prefs = useStore(transformPrefs)
    const [v, setV] = useState(prefs.dialogs.scale)
    const [{ origin, record }] = useState(() => dialogOrigin(ctx, props, ctx.doc()))
    const sx = v.uniform ? v.percent : v.h
    const sy = v.uniform ? v.percent : v.v
    const zero = sx === 0 || sy === 0
    const m = uiScale(sx, sy, origin)
    return (
      <DialogFrame
        ctx={ctx}
        close={close}
        label="Scale"
        testId="draw-scale-dialog"
        deps={[sx, sy, prefs.scaleStrokes, prefs.scaleCorners]}
        plan={(from) => (zero ? { doc: from, error: 'A scale of 0% would flatten the artwork to nothing.' } : planDialogMatrix(ctx, m, from))}
        apply={(copy) => {
          rememberDialog('scale', v)
          return applyDialogMatrix(ctx, m, record, copy ? 'Scale copy' : 'Scale', copy)
        }}
        options={
          <>
            <Check label="Scale Corners" checked={prefs.scaleCorners} onChange={(b) => setTransformPrefs({ scaleCorners: b })} testId="draw-scale-corners" />
            <Check label="Scale Strokes & Effects" checked={prefs.scaleStrokes} onChange={(b) => setTransformPrefs({ scaleStrokes: b })} testId="draw-scale-strokes" />
          </>
        }
      >
        <Radios<'u' | 'n'>
          name="Scale"
          value={v.uniform ? 'u' : 'n'}
          options={[
            ['u', 'Uniform'],
            ['n', 'Non-Uniform']
          ]}
          onChange={(k) => setV({ ...v, uniform: k === 'u' })}
          testId="draw-scale-mode"
        />
        {v.uniform ? (
          <NumField label="Scale" prefix="%" kind="pct" value={v.percent} onCommit={(percent) => setV({ ...v, percent })} testId="draw-scale-uniform" live />
        ) : (
          <div className="space-y-1.5">
            <NumField label="Horizontal" prefix="H" kind="pct" value={v.h} onCommit={(h) => setV({ ...v, h })} testId="draw-scale-h" live />
            <NumField label="Vertical" prefix="V" kind="pct" value={v.v} onCommit={(y) => setV({ ...v, v: y })} testId="draw-scale-v" live />
          </div>
        )}
      </DialogFrame>
    )
  }
}

export default scale
