// Path Eraser: drag along a SELECTED path to erase the part of it under the
// eraser. A closed path that loses anything opens; what is left of an open
// one falls into separate paths. The reach is the "Brush size" in the
// Anchor points panel.

import type { Pt } from '@shared/drawGeometry'
import type { DrawDoc } from '@shared/draw/model'
import { erasePaths } from '@shared/draw/ops'
import type { DrawTool, EditorCtx, Txn } from '../editor/types'
import { AnchorOverlay } from './anchorOverlay'
import { setShellPrefs } from '../editor/shellPrefs'

interface TrailGesture {
  trail: Pt[]
  base: DrawDoc
  ids: string[]
  txn: Txn
  result: string[]
}

function gesture(ctx: EditorCtx, id: string): TrailGesture | null {
  const g = ctx.get().gesture
  return g && g.toolId === id ? (g.data as TrailGesture) : null
}

const pathEraser: DrawTool = {
  id: 'pathEraser',
  label: 'Path Eraser',
  icon: 'ink_eraser',
  group: 1,
  order: 42,
  flyout: 'pencil',
  // Illustrator: double-click the tool (or Enter) for its options -- here
  // its Fidelity and Size on the top bar's Anchors tab, brought into view.
  onOptions() {
    setShellPrefs({ tab: 'anchors', collapsed: false })
  },
  cursor: 'crosshair',
  overlayOrder: 50,
  anchorTool: true,
  onPointerDown(ctx, e) {
    const s = ctx.get()
    if (!s.selection.length) {
      ctx.status('Select the path to erase from first.')
      return
    }
    const txn = ctx.history.begin('Path Eraser')
    ctx.set({ gesture: { toolId: 'pathEraser', data: { trail: [e.p], base: s.doc, ids: [...s.selection], txn, result: [...s.selection] } satisfies TrailGesture } })
  },
  onPointerMove(ctx, e) {
    const d = gesture(ctx, 'pathEraser')
    if (!d) return
    const s = ctx.get()
    const trail = [...d.trail, e.p]
    const radius = s.pathPrefs.brushSize / 2 / s.zoom
    const r = erasePaths(d.base, d.ids, trail, radius)
    d.txn.preview(r.doc)
    ctx.set({ gesture: { toolId: 'pathEraser', data: { ...d, trail, result: r.ids } } })
  },
  onPointerUp(ctx) {
    const d = gesture(ctx, 'pathEraser')
    if (!d) return
    if (ctx.doc() === d.base) {
      d.txn.cancel()
      return
    }
    d.txn.commit()
    ctx.select(d.result)
  },
  Overlay({ state, k }) {
    if (state.tool !== 'pathEraser') return null
    const c = state.cursorPt
    return (
      <>
        <AnchorOverlay state={state} k={k} hover={false} />
        {c && <circle cx={c.x} cy={c.y} r={(state.pathPrefs.brushSize / 2) * k} fill="none" stroke="#6d5dfc" strokeWidth={k} />}
      </>
    )
  }
}

export default pathEraser
