// Reflect (O): drag to reflect the selection across an axis through the
// origin and the pointer (Shift: 45° steps, Alt: reflect a copy); click once
// to place the origin, then click again to reflect across the axis to that
// point; Alt-click, Enter or a double-click on the tool for the Reflect dialog.

import { uiReflect } from '@shared/draw/geometry/transform'
import { angleTo } from './helpers'
import { snap45, transformTool } from './transformTool'

export default transformTool({
  id: 'reflect',
  label: 'Reflect',
  icon: 'flip',
  key: 'O',
  order: 113,
  flyout: 'rotate',
  dialog: 'reflect',
  undo: 'Reflect',
  clickWithOrigin: 'transform',
  matrix(o, _start, p, shift) {
    if (Math.hypot(p.x - o.x, p.y - o.y) < 1e-6) return null
    let axis = -angleTo(o, p)
    if (shift) axis = snap45(axis)
    return uiReflect(axis, o)
  }
})
