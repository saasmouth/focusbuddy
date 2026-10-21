// Pan (H): drag to scroll the canvas. Holding Space, or dragging with the
// middle button, pans from any tool (the dispatcher routes those here).

import type { DrawTool } from '../editor/types'

interface PanGesture {
  fromClient: { x: number; y: number }
  scroll: { left: number; top: number }
}

const hand: DrawTool = {
  id: 'hand',
  label: 'Pan',
  icon: 'pan_tool',
  group: 5,
  order: 160,
  key: 'H',
  cursor: 'grab',
  readOnlySafe: true,

  onPointerDown(ctx, e) {
    ctx.set({ gesture: { toolId: 'hand', data: { fromClient: { x: e.clientX, y: e.clientY }, scroll: ctx.viewport.getScroll() } satisfies PanGesture } })
  },

  onPointerMove(ctx, e) {
    const g = ctx.get().gesture
    if (!g || g.toolId !== 'hand') return
    const d = g.data as PanGesture
    ctx.viewport.setScroll(d.scroll.left - (e.clientX - d.fromClient.x), d.scroll.top - (e.clientY - d.fromClient.y))
  }
}

export default hand
