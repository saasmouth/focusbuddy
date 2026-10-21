// Rotate (R): drag to turn the selection about the origin (Shift: 45° steps,
// Alt: turn a copy); click to move the origin; Alt-click, Enter or a
// double-click on the tool for the Rotate dialog. See transformTool.tsx.

import { uiRotate } from '@shared/draw/geometry/transform'
import { angleTo } from './helpers'
import { snap45, transformTool } from './transformTool'

export default transformTool({
  id: 'rotate',
  label: 'Rotate',
  icon: 'rotate_left',
  key: 'R',
  order: 112,
  dialog: 'rotate',
  undo: 'Rotate',
  matrix(o, start, p, shift) {
    if (Math.hypot(start.x - o.x, start.y - o.y) < 1e-6 || Math.hypot(p.x - o.x, p.y - o.y) < 1e-6) return null
    // Screen angles are clockwise-positive; the UI angle is counter-clockwise.
    let deg = -(angleTo(o, p) - angleTo(o, start))
    if (shift) deg = snap45(deg)
    return uiRotate(deg, o)
  }
})
