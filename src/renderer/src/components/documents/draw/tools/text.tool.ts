// Type (T): click to drop a text box, or drag to size one, then type.

import { drawId, solid } from '@shared/draw'
import type { Pt } from '@shared/drawGeometry'
import type { DrawTextNode } from '@shared/draw/model'
import { addObject, primaryArtboard, targetLayerId } from '@shared/draw/ops'
import type { DrawTool } from '../editor/types'
import { normBox } from './helpers'

interface TextGesture {
  from: Pt
  to: Pt
}

const text: DrawTool = {
  id: 'text',
  label: 'Type',
  icon: 'title',
  group: 3,
  order: 110,
  key: 'T',
  cursor: 'text',

  onPointerDown(ctx, e) {
    // A click drops a default box; a drag sizes one. Both are what a type tool
    // is expected to do.
    ctx.set({ gesture: { toolId: 'text', data: { from: e.p, to: e.p } satisfies TextGesture } })
  },

  onPointerMove(ctx, e) {
    const g = ctx.get().gesture
    if (!g || g.toolId !== 'text') return
    ctx.set({ gesture: { toolId: 'text', data: { ...(g.data as TextGesture), to: e.p } } })
  },

  onPointerUp(ctx) {
    const s = ctx.get()
    const g = s.gesture
    if (!g || g.toolId !== 'text') return
    const d = g.data as TextGesture
    const box = normBox(d.from, d.to)
    const wide = box.w > 8
    const size = wide ? Math.max(8, Math.min(200, box.h > 12 ? box.h * 0.5 : 48)) : 48
    const doc = ctx.doc()
    const obj: DrawTextNode = ctx.text.measure({
      id: drawId('obj'),
      type: 'text',
      x: wide ? box.x : d.from.x,
      y: wide ? box.y : d.from.y,
      w: wide ? box.w : Math.min(320, Math.max(80, primaryArtboard(doc).w - d.from.x - 8)),
      text: '',
      fontSize: size,
      fill: s.fill.type === 'none' ? solid('#1c1917') : s.fill
    })
    ctx.history.commit(addObject(doc, obj, targetLayerId(doc)), 'Type')
    ctx.select([obj.id])
    ctx.set({ editingText: obj.id })
    ctx.setTool('select')
  }
}

export default text
