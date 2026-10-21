// Reshape: stretch part of a path while keeping its overall shape.
//
//   - Select a path first (or click one with this tool).
//   - Click an anchor to make it the FOCUS point (Shift-click adds or removes
//     more), or click anywhere on the path's outline to add an anchor there
//     and focus it. Drag across empty canvas to focus every anchor in a box.
//   - Drag a focus point: the focus points move the whole way, the anchors
//     farthest from them stay put, and the rest of the path follows in
//     proportion -- one undo step.
//
// A live shape (rectangle, star...) becomes a plain path when reshaped, as
// with any anchor edit.

import type { Pt } from '@shared/drawGeometry'
import { insertAnchor, nearestOnPath, reshapePath, type AnchorRef } from '@shared/draw/geometry/reshape'
import type { DrawDoc, DrawPathNode } from '@shared/draw/model'
import { editableIds, getObject, mapObject } from '@shared/draw/ops'
import type { DrawTool, EditorCtx, EditorState, Txn } from '../editor/types'
import { normBox } from './helpers'

const KEY = 'reshape'

interface ReshapeState {
  id: string
  focus: AnchorRef[]
}

type Gesture =
  | { kind: 'drag'; id: string; start: Pt; base: DrawDoc; before: DrawDoc; inserted: boolean; moved: boolean; txn: Txn }
  | { kind: 'marquee'; id: string; from: Pt; to: Pt; additive: boolean }

/** The reshape focus for the current selection (cleared when its path is no longer selected). */
export function reshapeFocus(s: Pick<EditorState, 'toolState' | 'selection'>): ReshapeState | null {
  const r = s.toolState[KEY] as ReshapeState | undefined
  return r && s.selection.includes(r.id) ? r : null
}

function setFocus(ctx: EditorCtx, r: ReshapeState | null): void {
  ctx.set((s) => ({ toolState: { ...s.toolState, [KEY]: r ?? undefined } }))
}

/** The editable selected paths, topmost first. */
function targetPaths(ctx: EditorCtx): DrawPathNode[] {
  const s = ctx.get()
  return editableIds(s.doc, s.selection)
    .map((id) => getObject(s.doc, id))
    .filter((n): n is DrawPathNode => !!n && n.type === 'path')
    .reverse()
}

function anchorAt(n: DrawPathNode, p: Pt, r: number): AnchorRef | null {
  for (let si = 0; si < n.path.subpaths.length; si++) {
    const nodes = n.path.subpaths[si].nodes
    for (let ni = 0; ni < nodes.length; ni++) if (Math.hypot(nodes[ni].x - p.x, nodes[ni].y - p.y) <= r) return [si, ni]
  }
  return null
}

/** A reshaped path no longer matches its live-shape parameters. */
function asPlainPath(n: DrawPathNode): DrawPathNode {
  if (!n.shapeKind || n.shapeKind === 'path') return n
  const { cornerRadius: _r, sides: _s, innerRatio: _i, ...rest } = n
  void _r
  void _s
  void _i
  return { ...rest, shapeKind: 'path' }
}

function gesture(ctx: EditorCtx): Gesture | null {
  const g = ctx.get().gesture
  return g && g.toolId === 'reshape' ? (g.data as Gesture) : null
}

const reshape: DrawTool = {
  id: 'reshape',
  label: 'Reshape',
  icon: 'gesture',
  group: 6,
  order: 116,
  cursor: 'crosshair',
  overlayOrder: 42,

  onPointerDown(ctx, e) {
    const s = ctx.get()
    const r = 6 / s.zoom
    const paths = targetPaths(ctx)
    const current = reshapeFocus(s)
    for (const n of paths) {
      const a = anchorAt(n, e.p, r)
      if (a) {
        const prev = current && current.id === n.id ? current.focus : []
        const has = prev.some(([x, y]) => x === a[0] && y === a[1])
        const focus = e.shiftKey ? (has ? prev.filter(([x, y]) => !(x === a[0] && y === a[1])) : [...prev, a]) : has ? prev : [a]
        setFocus(ctx, { id: n.id, focus })
        if (!focus.length) return
        ctx.set({ gesture: { toolId: 'reshape', data: { kind: 'drag', id: n.id, start: e.p, base: s.doc, before: s.doc, inserted: false, moved: false, txn: ctx.history.begin('Reshape') } satisfies Gesture } })
        return
      }
    }
    for (const n of paths) {
      const hit = nearestOnPath(n.path, e.p)
      if (!hit || hit.dist > r) continue
      // On the outline: add an anchor here, exactly on the curve, and focus it.
      const txn = ctx.history.begin('Reshape')
      const ins = insertAnchor(n.path, hit.si, hit.seg, hit.t)
      const base = mapObject(s.doc, n.id, (o) => (o.type === 'path' ? asPlainPath({ ...o, path: ins.path }) : o))
      txn.preview(base)
      // Indices after the new anchor shift up by one in that subpath.
      const prev = current && current.id === n.id ? current.focus.map(([si, ni]): AnchorRef => (si === hit.si && ni >= ins.ni ? [si, ni + 1] : [si, ni])) : []
      const added: AnchorRef = [hit.si, ins.ni]
      setFocus(ctx, { id: n.id, focus: e.shiftKey ? [...prev, added] : [added] })
      ctx.set({ gesture: { toolId: 'reshape', data: { kind: 'drag', id: n.id, start: e.p, base, before: s.doc, inserted: true, moved: false, txn } satisfies Gesture } })
      return
    }
    const other = ctx.hitTest(e.p)
    if (other) {
      ctx.select([other.id])
      setFocus(ctx, null)
      return
    }
    if (paths.length) {
      ctx.set({ gesture: { toolId: 'reshape', data: { kind: 'marquee', id: paths[0].id, from: e.p, to: e.p, additive: e.shiftKey } satisfies Gesture } })
      return
    }
    ctx.status('Select a path to reshape first.')
  },

  onPointerMove(ctx, e) {
    const g = gesture(ctx)
    if (!g) return
    if (g.kind === 'marquee') {
      ctx.set({ gesture: { toolId: 'reshape', data: { ...g, to: e.p } } })
      return
    }
    const f = reshapeFocus(ctx.get())
    if (!f || f.id !== g.id) return
    const dx = e.p.x - g.start.x
    const dy = e.p.y - g.start.y
    if (!g.moved && Math.hypot(dx, dy) < 2 / ctx.get().zoom) return
    g.txn.preview(mapObject(g.base, g.id, (o) => (o.type === 'path' ? asPlainPath({ ...o, path: reshapePath(o.path, f.focus, dx, dy) }) : o)))
    if (!g.moved) ctx.set({ gesture: { toolId: 'reshape', data: { ...g, moved: true } } })
  },

  onPointerUp(ctx) {
    const g = gesture(ctx)
    if (!g) return
    if (g.kind === 'marquee') {
      const box = normBox(g.from, g.to)
      const n = getObject(ctx.doc(), g.id)
      if (!n || n.type !== 'path' || (box.w < 1e-6 && box.h < 1e-6)) return
      const inBox: AnchorRef[] = []
      n.path.subpaths.forEach((sp, si) =>
        sp.nodes.forEach((p, ni) => {
          if (p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h) inBox.push([si, ni])
        })
      )
      const prev = g.additive ? (reshapeFocus(ctx.get())?.focus ?? []) : []
      setFocus(ctx, { id: g.id, focus: [...prev, ...inBox.filter(([a, b]) => !prev.some(([x, y]) => x === a && y === b))] })
      return
    }
    if (!g.moved && !g.inserted) {
      g.txn.cancel()
      return
    }
    g.txn.commit()
  },

  Overlay({ state, k }) {
    if (state.tool !== 'reshape') return null
    const f = reshapeFocus(state)
    const g = state.gesture && state.gesture.toolId === 'reshape' ? (state.gesture.data as Gesture) : null
    const out: JSX.Element[] = []
    for (const id of state.selection) {
      const n = getObject(state.doc, id)
      if (!n || n.type !== 'path') continue
      n.path.subpaths.forEach((sp, si) =>
        sp.nodes.forEach((p, ni) => {
          const on = !!f && f.id === id && f.focus.some(([a, b]) => a === si && b === ni)
          out.push(
            <rect
              key={`${id}-${si}-${ni}`}
              x={p.x - 3 * k}
              y={p.y - 3 * k}
              width={6 * k}
              height={6 * k}
              fill={on ? '#6d5dfc' : '#ffffff'}
              stroke="#6d5dfc"
              strokeWidth={k}
              data-testid={on ? 'draw-reshape-focus' : undefined}
            />
          )
        })
      )
    }
    if (g && g.kind === 'marquee') {
      const b = normBox(g.from, g.to)
      out.push(<rect key="marquee" x={b.x} y={b.y} width={b.w} height={b.h} fill="rgba(109,93,252,0.08)" stroke="#6d5dfc" strokeWidth={k} strokeDasharray={`${3 * k} ${3 * k}`} />)
    }
    return <g pointerEvents="none">{out}</g>
  }
}

export default reshape
