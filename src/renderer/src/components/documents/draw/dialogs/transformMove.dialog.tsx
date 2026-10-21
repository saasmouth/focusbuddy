// Object › Transform › Move… (⇧⌘M; also Enter or a double-click on the
// Selection tool): Horizontal and Vertical, or Distance and Angle -- the two
// pairs are linked, editing either updates the other. Lengths are in the
// document's units and take expressions; a positive Vertical moves down the
// page, a 90° angle moves straight up.

import { useState } from 'react'
import { moveToPolar, polarMove, translation } from '@shared/draw/geometry/transform'
import type { DrawDialog } from '../editor/types'
import DialogFrame, { planDialogMatrix } from '../transform/DialogFrame'
import { applyTransform } from '../transform/apply'
import { NumField } from '../transform/fields'
import { rememberDialog, transformPrefs } from '../transform/prefs'

const move: DrawDialog = {
  id: 'transform-move',
  title: 'Move',
  component: function MoveDialog({ ctx, close }) {
    const settings = ctx.doc().settings
    const [v, setV] = useState(transformPrefs.getState().dialogs.move)
    const polar = moveToPolar(v.h, v.v)
    const m = translation(v.h, v.v)
    return (
      <DialogFrame
        ctx={ctx}
        close={close}
        label="Move"
        testId="draw-move-dialog"
        deps={[v.h, v.v]}
        plan={(from) => planDialogMatrix(ctx, m, from)}
        apply={(copy) => {
          rememberDialog('move', v)
          return applyTransform(ctx, m, { label: copy ? 'Move copy' : 'Move', copy, record: { kind: 'absolute' } })
        }}
      >
        <fieldset className="space-y-1.5">
          <legend className="text-[11px] text-[var(--ink-50)]">Position</legend>
          <NumField label="Horizontal" prefix="H" kind="length" settings={settings} value={v.h} onCommit={(h) => setV({ ...v, h })} testId="draw-move-h" live />
          <NumField label="Vertical" prefix="V" kind="length" settings={settings} value={v.v} onCommit={(y) => setV({ ...v, v: y })} testId="draw-move-v" live />
          <NumField
            label="Distance"
            prefix="D"
            kind="length"
            settings={settings}
            value={polar.distance}
            onCommit={(d) => {
              const p = polarMove(d, polar.angle)
              setV({ h: p.dx, v: p.dy })
            }}
            testId="draw-move-distance"
            live
          />
          <NumField
            label="Angle"
            prefix="∠"
            kind="deg"
            value={polar.angle}
            onCommit={(a) => {
              const p = polarMove(polar.distance, a)
              setV({ h: p.dx, v: p.dy })
            }}
            testId="draw-move-angle"
            live
          />
        </fieldset>
      </DialogFrame>
    )
  }
}

export default move
