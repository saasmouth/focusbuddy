// Object › Transform › Reflect… (and Alt-click, Enter or a double-click with
// the Reflect tool): reflect across a Horizontal axis (upside down), a
// Vertical axis (mirror), or an axis at an angle counter-clockwise from
// horizontal -- through the point the Reflect tool set or the selection's centre.

import { useState } from 'react'
import { uiReflect } from '@shared/draw/geometry/transform'
import type { DrawDialog } from '../editor/types'
import DialogFrame, { Radios, applyDialogMatrix, dialogOrigin, planDialogMatrix } from '../transform/DialogFrame'
import { NumField } from '../transform/fields'
import { rememberDialog, transformPrefs, type DialogMemory } from '../transform/prefs'

type Axis = DialogMemory['reflect']['axis']

const reflect: DrawDialog = {
  id: 'transform-reflect',
  title: 'Reflect',
  component: function ReflectDialog({ ctx, props, close }) {
    const [v, setV] = useState(transformPrefs.getState().dialogs.reflect)
    const [{ origin, record }] = useState(() => dialogOrigin(ctx, props, ctx.doc()))
    const axisAngle = v.axis === 'horizontal' ? 0 : v.axis === 'vertical' ? 90 : v.angle
    const m = uiReflect(axisAngle, origin)
    return (
      <DialogFrame
        ctx={ctx}
        close={close}
        label="Reflect"
        testId="draw-reflect-dialog"
        deps={[axisAngle]}
        plan={(from) => planDialogMatrix(ctx, m, from)}
        apply={(copy) => {
          rememberDialog('reflect', v)
          return applyDialogMatrix(ctx, m, record, copy ? 'Reflect copy' : 'Reflect', copy)
        }}
      >
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
            onChange={(axis) => setV({ ...v, axis, angle: axis === 'horizontal' ? 0 : axis === 'vertical' ? 90 : v.angle })}
            testId="draw-reflect-axis"
          />
          <NumField label="Axis angle" prefix="∠" kind="deg" value={axisAngle} onCommit={(angle) => setV({ axis: 'angle', angle })} testId="draw-reflect-angle" live />
        </fieldset>
      </DialogFrame>
    )
  }
}

export default reflect
