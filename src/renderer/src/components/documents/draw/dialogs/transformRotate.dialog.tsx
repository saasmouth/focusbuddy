// Object › Transform › Rotate… (and Alt-click, Enter or a double-click with
// the Rotate tool): an angle, counter-clockwise for positive values as in
// Illustrator, about the point the Rotate tool set or the selection's centre.

import { useState } from 'react'
import { uiRotate } from '@shared/draw/geometry/transform'
import type { DrawDialog } from '../editor/types'
import DialogFrame, { applyDialogMatrix, dialogOrigin, planDialogMatrix } from '../transform/DialogFrame'
import { NumField } from '../transform/fields'
import { rememberDialog, transformPrefs } from '../transform/prefs'

const rotate: DrawDialog = {
  id: 'transform-rotate',
  title: 'Rotate',
  component: function RotateDialog({ ctx, props, close }) {
    const [angle, setAngle] = useState(transformPrefs.getState().dialogs.rotate.angle)
    const [{ origin, record }] = useState(() => dialogOrigin(ctx, props, ctx.doc()))
    const m = uiRotate(angle, origin)
    return (
      <DialogFrame
        ctx={ctx}
        close={close}
        label="Rotate"
        testId="draw-rotate-dialog"
        deps={[angle]}
        plan={(from) => planDialogMatrix(ctx, m, from)}
        apply={(copy) => {
          rememberDialog('rotate', { angle })
          return applyDialogMatrix(ctx, m, record, copy ? 'Rotate copy' : 'Rotate', copy)
        }}
      >
        <NumField label="Angle" prefix="∠" kind="deg" value={angle} onCommit={setAngle} testId="draw-rotate-angle" live />
      </DialogFrame>
    )
  }
}

export default rotate
