// Object > Path > Average… (⌥⌘J): line the selected anchors up on their mean
// position -- horizontally, vertically, or both (onto one point).

import { useState } from 'react'
import type { AverageAxis } from '@shared/draw/ops'
import type { DrawDialog } from '../editor/types'

const AXES: Array<{ id: AverageAxis; label: string }> = [
  { id: 'horizontal', label: 'Horizontal' },
  { id: 'vertical', label: 'Vertical' },
  { id: 'both', label: 'Both' }
]

const average: DrawDialog = {
  id: 'average',
  title: 'Average',
  component: function AverageDialog({ ctx, close }) {
    const [axis, setAxis] = useState<AverageAxis>('both')
    return (
      <div className="space-y-3 text-[13px]" data-testid="draw-average-dialog">
        <fieldset className="space-y-1.5">
          <legend className="text-[var(--ink-50)] mb-1">Axis</legend>
          {AXES.map((a) => (
            <label key={a.id} className="flex items-center gap-2">
              <input type="radio" name="draw-average-axis" checked={axis === a.id} onChange={() => setAxis(a.id)} data-testid={`draw-average-${a.id}`} />
              {a.label}
            </label>
          ))}
        </fieldset>
        <p className="text-[11px] text-[var(--ink-40)]">
          Horizontal puts the points on one horizontal line, Vertical on one vertical line, Both on a single point at their average position.
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={close} className="fb-btn-surface px-3 py-1.5">
            Cancel
          </button>
          <button
            onClick={() => {
              ctx.run('path.averageApply', axis)
              close()
            }}
            data-testid="draw-average-apply"
            className="btn-primary px-3 py-1.5"
          >
            OK
          </button>
        </div>
      </div>
    )
  }
}

export default average
