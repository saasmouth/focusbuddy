// Smooth: drag along a SELECTED path to smooth the stretch under the pointer
// (fewer anchors, gentler curves). Fidelity (Accurate .. Smooth) and the reach
// are set in the Anchor points panel while the tool is active.

import type { Pt } from '@shared/drawGeometry'
import type { DrawDoc } from '@shared/draw/model'
import { smoothPaths } from '@shared/draw/ops'
import type { DrawTool, EditorCtx, Txn } from '../editor/types'
import { AnchorOverlay } from './anchorOverlay'

interface SmoothGesture {
  trail: Pt[]
  base: DrawDoc
  ids: string[]
  txn: Txn
}

function gesture(ctx: EditorCtx): SmoothGesture | null {
  const g = ctx.get().gesture
  return g && g.toolId === 'smooth' ? (g.data as SmoothGesture) : null
}

const smooth: DrawTool = {
  id: 'smooth',
  label: 'Smooth',
  icon: 'blur_linear',
  group: 1,
  order: 41,
  cursor: 'crosshair',
  overlayOrder: 50,
  anchorTool: true,
  onPointerDown(ctx, e) {
    const s = ctx.get()
    if (!s.selection.length) {
      ctx.status('Select the path to smooth first.')
      return
    }
    const txn = ctx.history.begin('Smooth')
    ctx.set({ gesture: { toolId: 'smooth', data: { trail: [e.p], base: s.doc, ids: [...s.selection], txn } satisfies SmoothGesture } })
  },
  onPointerMove(ctx, e) {
    const d = gesture(ctx)
    if (!d) return
    const s = ctx.get()
    const trail = [...d.trail, e.p]
    // Always from the path as it was: one smoothing per stroke, however long.
    d.txn.preview(smoothPaths(d.base, d.ids, trail, Math.max(4, s.pathPrefs.brushSize) / s.zoom, s.pathPrefs.smoothFidelity))
    ctx.set({ gesture: { toolId: 'smooth', data: { ...d, trail } } })
  },
  onPointerUp(ctx) {
    const d = gesture(ctx)
    if (!d) return
    if (ctx.doc() === d.base) d.txn.cancel()
    else {
      d.txn.commit()
      ctx.set({ anchors: {} })
    }
  },
  Overlay({ state, k }) {
    return state.tool === 'smooth' ? <AnchorOverlay state={state} k={k} hover={false} /> : null
  }
}

export default smooth
