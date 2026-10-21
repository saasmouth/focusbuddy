// Curvature (⇧~), as in Illustrator: click to place points and the path flows
// smoothly through them; Alt-click (or double-click) places -- or toggles -- a
// corner point; drag a point to move it while the curve follows; click the
// first point to close; Enter or Escape finishes an open path.
//
// On an existing selected path: drag an anchor to move it (the curve re-flows
// through it and its smooth neighbours), double-click or Alt-click an anchor
// to toggle corner/smooth, click a segment to add a smooth anchor there.

import { drawId, solid } from '@shared/draw'
import type { DrawSubpath, Pt } from '@shared/drawGeometry'
import { pathToSvgD } from '@shared/drawGeometry'
import { curvatureHandlesAt, curvatureNodes, type CurvaturePoint } from '@shared/draw/geometry/fit'
import { isSmoothNode } from '@shared/draw/geometry/pathEdit'
import type { DrawDoc, DrawPathNode } from '@shared/draw/model'
import { addAnchor, addObject, convertAnchors, getObject, moveAnchors, setPathNode, targetLayerId, type AnchorRef } from '@shared/draw/ops'
import type { DrawTool, EditorCtx, Txn } from '../editor/types'
import { anchorHitAt, selectAnchors } from '../editor/anchorSelection'
import { AnchorOverlay } from './anchorOverlay'

type CurvatureGesture =
  | { kind: 'point'; index: number; last: Pt }
  | { kind: 'anchor'; ref: AnchorRef; start: Pt; base: DrawDoc; txn: Txn; moved: boolean; smooth: boolean[] }

function gesture(ctx: EditorCtx): CurvatureGesture | null {
  const g = ctx.get().gesture
  return g && g.toolId === 'curvature' ? (g.data as CurvatureGesture) : null
}

/** Finish the curvature path as one undo step (fewer than two points: nothing). */
export function finishCurvature(ctx: EditorCtx, close: boolean): void {
  const s = ctx.get()
  const pts = s.curvature?.points ?? []
  ctx.set({ curvature: null })
  if (pts.length < 2) return
  const closed = close && pts.length >= 3
  const obj: DrawPathNode = {
    id: drawId('obj'),
    type: 'path',
    shapeKind: 'path',
    path: { subpaths: [{ closed, nodes: curvatureNodes(pts, closed) }] },
    fill: closed ? s.fill : { type: 'none' },
    stroke: s.stroke ?? { paint: solid('#1c1917'), width: 2, cap: 'round', join: 'round' }
  }
  const doc = ctx.doc()
  ctx.history.commit(addObject(doc, obj, targetLayerId(doc)), 'Curvature')
  ctx.select([obj.id])
}

/** Re-flow an anchor of an existing path, and its smooth neighbours, by the curvature rule. */
function reflow(doc: DrawDoc, ref: AnchorRef, smooth: boolean[]): DrawDoc {
  const o = getObject(doc, ref.id)
  if (!o || o.type !== 'path') return doc
  const sp: DrawSubpath = o.path.subpaths[ref.si]
  const n = sp.nodes.length
  let next = doc
  for (const ni of [ref.ni - 1, ref.ni, ref.ni + 1]) {
    const i = sp.closed ? (ni + n) % n : ni
    if (i < 0 || i >= n || !smooth[i]) continue
    const cur = (getObject(next, ref.id) as DrawPathNode).path.subpaths[ref.si]
    next = setPathNode(next, { ...ref, ni: i }, curvatureHandlesAt(cur, i))
  }
  return next
}

const curvature: DrawTool = {
  id: 'curvature',
  label: 'Curvature',
  icon: 'timeline',
  group: 1,
  order: 31,
  shortcutLabel: '⇧~',
  cursor: 'crosshair',
  overlayOrder: 41,
  anchorTool: true,

  onPointerDown(ctx, e) {
    const s = ctx.get()
    const p = e.p
    const r = 8 / s.zoom
    const draft = s.curvature
    if (draft) {
      const pts = draft.points
      if (pts.length >= 3 && Math.hypot(pts[0].x - p.x, pts[0].y - p.y) < r && !e.altKey && e.detail < 2) {
        finishCurvature(ctx, true)
        return
      }
      const at = pts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < r)
      if (at >= 0) {
        if (e.altKey || e.detail >= 2) {
          const next = pts.map((q, i) => (i === at ? { ...q, corner: !q.corner } : q))
          ctx.set({ curvature: { points: next } })
          return
        }
        ctx.set({ gesture: { toolId: 'curvature', data: { kind: 'point', index: at, last: p } satisfies CurvatureGesture } })
        return
      }
      const next: CurvaturePoint[] = [...pts, { x: p.x, y: p.y, ...(e.altKey ? { corner: true } : {}) }]
      ctx.set({ curvature: { points: next }, gesture: { toolId: 'curvature', data: { kind: 'point', index: next.length - 1, last: p } satisfies CurvatureGesture } })
      return
    }
    // Editing an existing path.
    const hit = anchorHitAt(s, p, { handles: false })
    if (hit?.kind === 'anchor') {
      if (e.altKey || e.detail >= 2) {
        const o = getObject(s.doc, hit.ref.id)
        const node = o && o.type === 'path' ? o.path.subpaths[hit.ref.si].nodes[hit.ref.ni] : null
        const to = node && (node.inX != null || node.outX != null) ? 'corner' : 'smooth'
        ctx.history.commit(convertAnchors(s.doc, [hit.ref], to), to === 'corner' ? 'Corner point' : 'Smooth point')
        selectAnchors(ctx, [hit.ref])
        return
      }
      selectAnchors(ctx, [hit.ref])
      const o = getObject(s.doc, hit.ref.id) as DrawPathNode
      const smooth = o.path.subpaths[hit.ref.si].nodes.map((n) => isSmoothNode(n))
      const txn = ctx.history.begin('Move anchor point')
      ctx.set({ gesture: { toolId: 'curvature', data: { kind: 'anchor', ref: hit.ref, start: p, base: s.doc, txn, moved: false, smooth } satisfies CurvatureGesture } })
      return
    }
    if (hit?.kind === 'segment' && s.selection.includes(hit.id)) {
      const res = addAnchor(s.doc, hit.id, hit.si, hit.seg, hit.t)
      if (!res.ref) return
      ctx.history.commit(res.doc, 'Add anchor point')
      selectAnchors(ctx, [res.ref])
      return
    }
    ctx.set({ curvature: { points: [{ x: p.x, y: p.y, ...(e.altKey ? { corner: true } : {}) }] }, gesture: { toolId: 'curvature', data: { kind: 'point', index: 0, last: p } satisfies CurvatureGesture } })
  },

  onPointerMove(ctx, e) {
    const d = gesture(ctx)
    if (!d) return
    if (d.kind === 'point') {
      const pts = ctx.get().curvature?.points
      if (!pts) return
      const next = pts.map((q, i) => (i === d.index ? { ...q, x: e.p.x, y: e.p.y } : q))
      ctx.set({ curvature: { points: next } })
      return
    }
    const moved = moveAnchors(d.base, [d.ref], e.p.x - d.start.x, e.p.y - d.start.y)
    d.txn.preview(reflow(moved, d.ref, d.smooth))
    ctx.set({ gesture: { toolId: 'curvature', data: { ...d, moved: true } } })
  },

  onPointerUp(ctx) {
    const d = gesture(ctx)
    if (!d || d.kind !== 'anchor') return
    if (d.moved) d.txn.commit()
    else d.txn.cancel()
  },

  Overlay({ state, k }) {
    if (state.tool !== 'curvature') return null
    const draft = state.curvature
    const c = state.cursorPt
    let preview: string | null = null
    if (draft && draft.points.length) {
      const pts = c && !state.gesture ? [...draft.points, { x: c.x, y: c.y }] : draft.points
      preview = pathToSvgD({ subpaths: [{ closed: false, nodes: curvatureNodes(pts, false) }] })
    }
    return (
      <g>
        <AnchorOverlay state={state} k={k} />
        {preview && <path d={preview} fill="none" stroke="#6d5dfc" strokeWidth={1.5 * k} data-testid="draw-curvature-draft" />}
        {draft?.points.map((q, i) =>
          q.corner ? (
            <rect key={i} x={q.x - 3 * k} y={q.y - 3 * k} width={6 * k} height={6 * k} fill="#ffffff" stroke="#6d5dfc" strokeWidth={k} />
          ) : (
            <circle key={i} cx={q.x} cy={q.y} r={3.5 * k} fill="#ffffff" stroke="#6d5dfc" strokeWidth={k} />
          )
        )}
      </g>
    )
  }
}

export default curvature
