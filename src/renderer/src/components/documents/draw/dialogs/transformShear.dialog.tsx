// Object › Transform › Shear… (and Alt-click, Enter or a double-click with the
// Shear tool): a shear angle (a positive angle slants clockwise) along a
// Horizontal, Vertical or angled axis, about the point the Shear tool set or
// the selection's centre.

import { useState } from 'react'
import { uiShear } from '@shared/draw/geometry/transform'
import type { DrawDialog } from '../editor/types'
import DialogFrame, { Radios, applyDialogMatrix, dialogOrigin, planDialogMatrix } from '../transform/DialogFrame'
import { NumField } from '../transform/fields'
import { rememberDialog, transformPrefs, type DialogMemory } from '../transform/prefs'

type Axis = DialogMemory['shear']['axis']

const shear: DrawDialog = {
  id: 'transform-shear',
  title: 'Shear',
  component: function ShearDialog({ ctx, props, close }) {
    const [v, setV] = useState(transformPrefs.getState().dialogs.shear)
    const [{ origin, record }] = useState(() => dialogOrigin(ctx, props, ctx.doc()))
    const axisAngle = v.axis === 'horizontal' ? 0 : v.axis === 'vertical' ? 90 : v.axisAngle
    const tooSteep = Math.abs(Math.cos((v.angle * Math.PI) / 180)) < 1e-3
    const m = uiShear(v.angle, axisAngle, origin)
    return (
      <DialogFrame
        ctx={ctx}
        close={close}
        label="Shear"
        testId="draw-shear-dialog"
        deps={[v.angle, axisAngle]}
        plan={(from) => (tooSteep ? { doc: from, error: 'A shear of 90° would flatten the artwork into a line.' } : planDialogMatrix(ctx, m, from))}
        apply={(copy) => {
          rememberDialog('shear', v)
          return applyDialogMatrix(ctx, m, record, copy ? 'Shear copy' : 'Shear', copy)
        }}
      >
        <NumField label="Shear angle" prefix="∠" kind="deg" value={v.angle} onCommit={(angle) => setV({ ...v, angle })} testId="draw-shear-angle" live />
        <fieldset className="space-y-1.5">
          <legend className="text-[11px] text-[var(--ink-50)]">Axis</legend>
          <Radios<Axis>
            name="Axis"
            value={v.axis}
            options={[
              ['horizontal', 'Horizontal'],
              ['vertical', 'Vertical'],
              ['angle', 'Angle']
            ]}
            onChange={(axis) => setV({ ...v, axis })}
            testId="draw-shear-axis"
          />
          <NumField label="Axis angle" prefix="∠" kind="deg" value={axisAngle} onCommit={(axisAngle) => setV({ ...v, axis: 'angle', axisAngle })} testId="draw-shear-axis-angle" live />
        </fieldset>
      </DialogFrame>
    )
  }
}

export default shear
