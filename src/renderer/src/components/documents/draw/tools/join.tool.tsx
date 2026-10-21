// Join (scrub to join): scrub across the gap between two open ends and they
// are joined -- the end nearest where the scrub starts to the end nearest
// where it stops (both ends of one path close it). Ends that touch merge into
// one anchor; otherwise a straight segment bridges the gap.

import type { Pt } from '@shared/drawGeometry'
import { anchorPoint, endpointAnchor, joinEndpoints, openEndpoints, type EndpointRef } from '@shared/draw/ops'
import type { DrawTool, EditorCtx } from '../editor/types'
import { editablePaths } from '../editor/anchorSelection'
import { AnchorOverlay } from './anchorOverlay'

interface JoinGesture {
  trail: Pt[]
}

function gesture(ctx: EditorCtx): JoinGesture | null {
  const g = ctx.get().gesture
  return g && g.toolId === 'join' ? (g.data as JoinGesture) : null
}

/** The open end nearest `p` within `r`, skipping `not`. */
function nearestEnd(ctx: EditorCtx, p: Pt, r: number, not?: EndpointRef): EndpointRef | null {
  const doc = ctx.doc()
  let best: { e: EndpointRef; d: number } | null = null
  for (const e of openEndpoints(doc, editablePaths(doc).map((o) => o.id))) {
    if (not && e.id === not.id && e.si === not.si && e.end === not.end) continue
    const a = anchorPoint(doc, endpointAnchor(doc, e)!)
    if (!a) continue
    const d = Math.hypot(a.x - p.x, a.y - p.y)
    if (d <= r && (!best || d < best.d)) best = { e, d }
  }
  return best?.e ?? null
}

const join: DrawTool = {
  id: 'join',
  label: 'Join',
  icon: 'link',
  group: 1,
  order: 43,
  cursor: 'crosshair',
  overlayOrder: 50,
  anchorTool: true,
  onPointerDown(ctx, e) {
    ctx.set({ gesture: { toolId: 'join', data: { trail: [e.p] } satisfies JoinGesture } })
  },
  onPointerMove(ctx, e) {
    const d = gesture(ctx)
    if (d) ctx.set({ gesture: { toolId: 'join', data: { trail: [...d.trail, e.p] } } })
  },
  onPointerUp(ctx) {
    const d = gesture(ctx)
    if (!d || d.trail.length < 2) return
    const r = 24 / ctx.get().zoom
    const a = nearestEnd(ctx, d.trail[0], r)
    const b = a ? nearestEnd(ctx, d.trail[d.trail.length - 1], r, a) : null
    if (!a || !b) {
      ctx.status('Scrub from one open end to another to join them.')
      return
    }
    const res = joinEndpoints(ctx.doc(), a, b)
    if (!res) {
      ctx.status('Those ends cannot be joined.')
      return
    }
    ctx.history.commit(res.doc, 'Join')
    ctx.select([res.id])
  },
  Overlay({ state, k }) {
    if (state.tool !== 'join') return null
    const g = state.gesture
    const d = g && g.toolId === 'join' ? (g.data as JoinGesture) : null
    return (
      <>
        <AnchorOverlay state={state} k={k} />
        {d && <polyline points={d.trail.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#6d5dfc" strokeWidth={1.5 * k} />}
      </>
    )
  }
}

export default join
