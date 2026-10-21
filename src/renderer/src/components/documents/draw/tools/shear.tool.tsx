// Shear: drag sideways to slant the selection along the horizontal axis
// through the origin, or up and down to slant it along the vertical axis (the
// axis follows the drag's main direction); Alt shears a copy; click to move
// the origin; Alt-click, Enter or a double-click on the tool for the Shear
// dialog (any angle, any axis).

import { about, skewing } from '@shared/draw/geometry/transform'
import { transformTool } from './transformTool'

const MIN = 1e-3

export default transformTool({
  id: 'shear',
  label: 'Shear',
  icon: 'format_italic',
  order: 115,
  dialog: 'shear',
  undo: 'Shear',
  matrix(o, start, p) {
    const dx = p.x - start.x
    const dy = p.y - start.y
    if (Math.abs(dx) >= Math.abs(dy)) {
      const arm = start.y - o.y
      if (Math.abs(arm) < MIN) return null
      return about(o, skewing(dx / arm, 0))
    }
    const arm = start.x - o.x
    if (Math.abs(arm) < MIN) return null
    return about(o, skewing(0, dy / arm))
  }
})
