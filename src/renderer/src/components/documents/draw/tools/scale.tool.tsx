// Scale (S): drag away from or towards the origin to scale (Shift: uniform,
// Alt: scale a copy); click to move the origin; Alt-click, Enter or a
// double-click on the tool for the Scale dialog (uniform or non-uniform, with
// Scale Corners and Scale Strokes & Effects).

import { about, scaling } from '@shared/draw/geometry/transform'
import { transformTool } from './transformTool'

/** Under this many px from the origin an axis cannot be measured, and stays unscaled. */
const MIN = 1e-3

export default transformTool({
  id: 'scale',
  label: 'Scale',
  icon: 'open_in_full',
  key: 'S',
  order: 114,
  dialog: 'scale',
  undo: 'Scale',
  matrix(o, start, p, shift) {
    const ax = start.x - o.x
    const ay = start.y - o.y
    let sx = Math.abs(ax) > MIN ? (p.x - o.x) / ax : 1
    let sy = Math.abs(ay) > MIN ? (p.y - o.y) / ay : 1
    if (shift) {
      const len2 = ax * ax + ay * ay
      if (len2 < MIN * MIN) return null
      const u = ((p.x - o.x) * ax + (p.y - o.y) * ay) / len2
      sx = u
      sy = u
    }
    if (Math.abs(sx) < 1e-4 || Math.abs(sy) < 1e-4) return null
    return about(o, scaling(sx, sy))
  }
})
