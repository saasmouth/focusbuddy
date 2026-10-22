// Pen (P), as in Illustrator:
//  - click for a corner point, drag for a smooth point (the drag pulls out a
//    mirrored pair of handles); Shift keeps the new point, and a dragged
//    handle, at 45° steps; Alt while dragging moves only the outgoing handle
//    (a corner with a curve leaving it); holding Space while the mouse is down
//    repositions the point being placed;
//  - click the last point again to retract its outgoing handle (Alt-drag from
//    it pulls a new one out on its own);
//  - click the first point to close the path (drag there to shape the closing
//    curve); Enter, Escape or a double-click finishes it open;
//  - click an END of an open path to continue that path; finishing on another
//    open path's end joins the two;
//  - over a SELECTED path the pen adds an anchor on a segment and deletes one
//    on an anchor (Illustrator's automatic add/delete); Alt over an anchor
//    converts it instead (the Anchor Point tool);
//  - ⌘ (Ctrl) borrows Direct Selection; ⌘Z inside the pen removes the last
//    point. The path in progress is not in the document (and not on the undo
//    stack) until it is finished.

import { drawId, solid } from '@shared/draw'
import type { DrawNode as PathPoint, Pt } from '@shared/drawGeometry'
import { pathToSvgD } from '@shared/drawGeometry'
import { reverseNodes, withHandle } from '@shared/draw/geometry/pathEdit'
import type { DrawPathNode } from '@shared/draw/model'
import {
  addAnchor,
  addObject,
  extendSubpath,
  getObject,
  joinEndpoints,
  removeAnchorsJoined,
  targetLayerId,
  toDoc,
  type EndpointRef
} from '@shared/draw/ops'
import type { DrawTool, EditorCtx, EditorState } from '../editor/types'
import { anchorHitAt, isOpenEnd, selectAnchors } from '../editor/anchorSelection'
import { AnchorOverlay } from './anchorOverlay'
import { constrain45, directPointerDown } from './direct.tool'
import { convertPointerDown } from './anchorConvert.tool'

type PenMode = 'place' | 'outOnly' | 'close' | 'connect'

interface PenGesture {
  mode: PenMode
  index: number
  last: Pt
  connect?: EndpointRef
}

/** What a pen click at `p` would do: shown under the cursor, and done on click. */
export type PenIntent =
  | { kind: 'new' }
  | { kind: 'continue'; end: EndpointRef }
  | { kind: 'add'; id: string; si: number; seg: number; t: number }
  | { kind: 'delete'; id: string; si: number; ni: number }
  | { kind: 'convert'; id: string; si: number; ni: number }
  | { kind: 'close' }
  | { kind: 'connect'; end: EndpointRef }
  | { kind: 'lastAnchor' }
  | { kind: 'point' }

export function penIntent(s: EditorState, p: Pt, alt: boolean): PenIntent {
  const nodes = s.pen
  const r = 8 / s.zoom
  if (!nodes || nodes.length === 0) {
    const hit = anchorHitAt(s, p, { handles: false })
    if (hit?.kind === 'anchor') {
      const selected = s.selection.includes(hit.ref.id)
      if (alt && selected) return { kind: 'convert', ...hit.ref }
      const end = isOpenEnd(s.doc, hit.ref)
      if (end) return { kind: 'continue', end: { id: hit.ref.id, si: hit.ref.si, end } }
      if (selected) return { kind: 'delete', ...hit.ref }
    }
    if (hit?.kind === 'segment' && s.selection.includes(hit.id)) return { kind: 'add', id: hit.id, si: hit.si, seg: hit.seg, t: hit.t }
    return { kind: 'new' }
  }
  const last = nodes[nodes.length - 1]
  const target = s.penTarget
  // Closing: the first point of a new path, or the far end of the path being continued.
  if (!target && nodes.length >= 2 && Math.hypot(nodes[0].x - p.x, nodes[0].y - p.y) < r) return { kind: 'close' }
  if (target) {
    const o = getObject(s.doc, target.id)
    const sp = o && o.type === 'path' ? o.path.subpaths[target.si] : undefined
    if (sp && sp.nodes.length >= 1) {
      const farLocal = target.end === 'end' ? sp.nodes[0] : sp.nodes[sp.nodes.length - 1]
      const far = toDoc(s.doc, target.id, farLocal)
      if ((sp.nodes.length + nodes.length - 1 >= 3 || nodes.length >= 2) && Math.hypot(far.x - p.x, far.y - p.y) < r) return { kind: 'close' }
    }
  }
  if (nodes.length >= 1 && Math.hypot(last.x - p.x, last.y - p.y) < r && !(nodes.length === 1 && !target)) return { kind: 'lastAnchor' }
  const hit = anchorHitAt(s, p, { handles: false, segments: false })
  if (hit?.kind === 'anchor') {
    const end = isOpenEnd(s.doc, hit.ref)
    const own = target && hit.ref.id === target.id && hit.ref.si === target.si
    if (end && !own) return { kind: 'connect', end: { id: hit.ref.id, si: hit.ref.si, end } }
  }
  return { kind: 'point' }
}

/**
 * Finish the pen path: a new path object, or the continued path, as ONE undo
 * step; `connect` joins the finished end onto another open path's end.
 */
export function finishPen(ctx: EditorCtx, close: boolean, connect?: EndpointRef): void {
  const s = ctx.get()
  const nodes = s.pen
  const target = s.penTarget
  ctx.set({ pen: null, penTarget: null })
  if (!nodes || !nodes.length) return
  let doc = ctx.doc()
  if (target) {
    if (nodes.length < 2 && !close && !connect) return
    doc = extendSubpath(doc, target, nodes, close)
    let id = target.id
    if (connect && !close) {
      const r = joinEndpoints(doc, connect, { id: target.id, si: target.si, end: 'end' })
      if (r) {
        doc = r.doc
        id = r.id
      }
    }
    ctx.history.commit(doc, 'Pen')
    ctx.select([id])
    return
  }
  if (nodes.length < 2 && !connect) return
  const obj: DrawPathNode = {
    id: drawId('obj'),
    type: 'path',
    shapeKind: 'pen',
    path: { subpaths: [{ closed: close, nodes }] },
    fill: close ? s.fill : { type: 'none' },
    stroke: s.stroke ?? { paint: solid('#1c1917'), width: 2, cap: 'round', join: 'round' }
  }
  doc = addObject(doc, obj, targetLayerId(doc))
  let id = obj.id
  if (connect) {
    // The existing path absorbs the new stroke and keeps its own appearance.
    const r = joinEndpoints(doc, connect, { id: obj.id, si: 0, end: 'end' })
    if (r) {
      doc = r.doc
      id = r.id
    }
  }
  ctx.history.commit(doc, 'Pen')
  ctx.select([id])
}

/** ⌘Z inside the pen: take back the last point (the session ends with its first). */
export function popPenAnchor(ctx: EditorCtx): void {
  const s = ctx.get()
  const nodes = s.pen
  if (!nodes) return
  const next = nodes.slice(0, -1)
  if (!next.length) ctx.set({ pen: null, penTarget: null })
  else ctx.set({ pen: next })
}

function setPenGesture(ctx: EditorCtx, data: PenGesture): void {
  ctx.set({ gesture: { toolId: 'pen', data } })
}

/** The end node of an open subpath, in document space, oriented so the pen continues out of it. */
function endAsDraft(ctx: EditorCtx, end: EndpointRef): PathPoint | null {
  const o = getObject(ctx.doc(), end.id)
  const sp = o && o.type === 'path' ? o.path.subpaths[end.si] : undefined
  if (!sp || !sp.nodes.length) return null
  const nodes = end.end === 'end' ? sp.nodes : reverseNodes(sp.nodes)
  const n = nodes[nodes.length - 1]
  const map = (q: Pt): Pt => toDoc(ctx.doc(), end.id, q)
  const a = map(n)
  let out: PathPoint = { x: a.x, y: a.y }
  if (n.inX != null) {
    const h = map({ x: n.inX, y: n.inY ?? n.y })
    out = withHandle(out, 'in', h)
  }
  // Continuing starts with no outgoing handle unless the user drags one out.
  return out
}

const pen: DrawTool = {
  id: 'pen',
  label: 'Pen',
  icon: 'draw',
  group: 1,
  order: 30,
  flyout: 'pen',
  key: 'P',
  cursor: 'crosshair',
  overlayOrder: 40,
  anchorTool: true,

  onPointerDown(ctx, e) {
    const s = ctx.get()
    // ⌘ borrows Direct Selection; ⌘-click on empty canvas ends the path.
    if (e.metaKey || e.ctrlKey) {
      if (s.pen && !anchorHitAt(s, e.p)) finishPen(ctx, false)
      else directPointerDown(ctx, e)
      return
    }
    const intent = penIntent(s, e.p, e.altKey)
    const nodes = s.pen ?? []
    switch (intent.kind) {
      case 'convert':
        convertPointerDown(ctx, e)
        return
      case 'delete': {
        ctx.history.commit(removeAnchorsJoined(s.doc, [{ id: intent.id, si: intent.si, ni: intent.ni }]), 'Delete anchor point')
        if (getObject(ctx.doc(), intent.id)) selectAnchors(ctx, [], { keepEmpty: [intent.id] })
        else ctx.select([])
        return
      }
      case 'add': {
        const r = addAnchor(s.doc, intent.id, intent.si, intent.seg, intent.t)
        if (r.ref) {
          ctx.history.commit(r.doc, 'Add anchor point')
          selectAnchors(ctx, [r.ref])
        }
        return
      }
      case 'continue': {
        const first = endAsDraft(ctx, intent.end)
        if (!first) return
        ctx.set({ pen: [first], penTarget: intent.end })
        setPenGesture(ctx, { mode: 'place', index: 0, last: e.p })
        return
      }
      case 'close': {
        setPenGesture(ctx, { mode: 'close', index: 0, last: e.p })
        return
      }
      case 'connect': {
        setPenGesture(ctx, { mode: 'connect', index: nodes.length - 1, last: e.p, connect: intent.end })
        return
      }
      case 'lastAnchor': {
        // Retract the outgoing handle; a drag from here pulls a new one out alone.
        const i = nodes.length - 1
        const next = nodes.slice()
        next[i] = withHandle(next[i], 'out', null)
        ctx.set({ pen: next })
        setPenGesture(ctx, { mode: 'outOnly', index: i, last: e.p })
        return
      }
      default: {
        let p = e.p
        if (e.shiftKey && nodes.length) {
          const prev = nodes[nodes.length - 1]
          const c = constrain45({ x: p.x - prev.x, y: p.y - prev.y })
          p = { x: prev.x + c.x, y: prev.y + c.y }
        }
        const next = [...nodes, { x: p.x, y: p.y }]
        if (!nodes.length) ctx.set({ penTarget: null })
        ctx.set({ pen: next })
        setPenGesture(ctx, { mode: 'place', index: next.length - 1, last: p })
      }
    }
  },

  onPointerMove(ctx, e) {
    const s = ctx.get()
    const g = s.gesture
    if (!g || g.toolId !== 'pen') return
    const d = g.data as PenGesture
    const nodes = s.pen
    if (!nodes) return
    const p = e.p
    const next = nodes.slice()
    // Space: move the point being placed (its handles come along).
    if (s.spaceDown && (d.mode === 'place' || d.mode === 'outOnly')) {
      const n = next[d.index]
      const dx = p.x - d.last.x
      const dy = p.y - d.last.y
      next[d.index] = {
        x: n.x + dx,
        y: n.y + dy,
        ...(n.inX != null ? { inX: n.inX + dx, inY: (n.inY ?? n.y) + dy } : {}),
        ...(n.outX != null ? { outX: n.outX + dx, outY: (n.outY ?? n.y) + dy } : {})
      }
      ctx.set({ pen: next })
      setPenGesture(ctx, { ...d, last: p })
      return
    }
    const idx = d.mode === 'close' ? 0 : d.index
    const n = next[idx]
    let h = p
    if (e.shiftKey) {
      const c = constrain45({ x: p.x - n.x, y: p.y - n.y })
      h = { x: n.x + c.x, y: n.y + c.y }
    }
    const mirror = { x: 2 * n.x - h.x, y: 2 * n.y - h.y }
    if (d.mode === 'place') {
      next[idx] = e.altKey ? withHandle(n, 'out', h) : withHandle(withHandle(n, 'out', h), 'in', mirror)
    } else if (d.mode === 'outOnly') {
      next[idx] = withHandle(n, 'out', h)
    } else if (d.mode === 'close') {
      // The closing drag shapes the curve INTO the first point.
      if (s.penTarget) {
        setPenGesture(ctx, { ...d, last: p })
        return
      }
      next[0] = e.altKey ? withHandle(n, 'in', mirror) : withHandle(withHandle(n, 'in', mirror), 'out', h)
    } else return
    ctx.set({ pen: next })
    setPenGesture(ctx, { ...d, last: p })
  },

  onPointerUp(ctx) {
    const g = ctx.get().gesture
    if (!g || g.toolId !== 'pen') return
    const d = g.data as PenGesture
    if (d.mode === 'close') finishPen(ctx, true)
    else if (d.mode === 'connect') finishPen(ctx, false, d.connect)
  },

  Overlay({ state, k }) {
    if (state.tool !== 'pen') return null
    const penNodes = state.pen
    const cursor = state.cursorPt
    const intent = cursor && !state.gesture ? penIntent(state, cursor, false) : null
    const glyph =
      intent?.kind === 'add' ? '+' : intent?.kind === 'delete' ? '−' : intent?.kind === 'continue' || intent?.kind === 'connect' ? '/' : intent?.kind === 'close' ? '○' : intent?.kind === 'lastAnchor' ? '^' : null
    const last = penNodes?.length ? penNodes[penNodes.length - 1] : null
    return (
      <g>
        <AnchorOverlay state={state} k={k} hover={false} />
        {penNodes && penNodes.length > 0 && (
          <g data-testid="draw-pen-draft">
            <path d={pathToSvgD({ subpaths: [{ closed: false, nodes: penNodes }] })} fill="none" stroke="#6d5dfc" strokeWidth={1.5 * k} />
            {last && cursor && !state.gesture && (
              // The rubber band: the segment the next click would make.
              <path
                d={`M ${last.x} ${last.y} C ${last.outX ?? last.x} ${last.outY ?? last.y} ${cursor.x} ${cursor.y} ${cursor.x} ${cursor.y}`}
                fill="none"
                stroke="#6d5dfc"
                strokeWidth={k}
                strokeDasharray={`${3 * k} ${3 * k}`}
              />
            )}
            {penNodes.map((n, i) => (
              <g key={i}>
                {i === penNodes.length - 1 &&
                  [n.inX != null ? { x: n.inX, y: n.inY ?? n.y } : null, n.outX != null ? { x: n.outX, y: n.outY ?? n.y } : null].map((h, j) =>
                    h ? (
                      <g key={j}>
                        <line x1={n.x} y1={n.y} x2={h.x} y2={h.y} stroke="#6d5dfc" strokeWidth={k} opacity={0.7} />
                        <circle cx={h.x} cy={h.y} r={2.5 * k} fill="#6d5dfc" />
                      </g>
                    ) : null
                  )}
                <rect x={n.x - 3 * k} y={n.y - 3 * k} width={6 * k} height={6 * k} fill={i === penNodes.length - 1 ? '#6d5dfc' : '#ffffff'} stroke="#6d5dfc" strokeWidth={k} />
              </g>
            ))}
          </g>
        )}
        {glyph && cursor && (
          <text x={cursor.x + 9 * k} y={cursor.y + 16 * k} fontSize={12 * k} fill="#6d5dfc" data-testid="draw-pen-intent" data-intent={intent?.kind}>
            {glyph}
          </text>
        )}
      </g>
    )
  }
}

export default pen
