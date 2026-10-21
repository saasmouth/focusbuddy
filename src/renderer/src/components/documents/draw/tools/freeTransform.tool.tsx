// Free Transform (E): transform the selection straight from its bounding box.
//
//   - Drag a corner or side handle to scale (Shift keeps the proportions, Alt
//     scales from the centre).
//   - Hold ⌘ (Ctrl) and drag a SIDE handle to shear along that side (Alt: about
//     the centre).
//   - Drag just outside the box, or the knob above it, to rotate about the
//     centre (Shift: 45° steps).
//   - Drag inside to move (Shift: along an axis; Alt: move a copy).
//
// Every gesture previews live, is one undo step, honours Scale Strokes &
// Effects and Scale Corners, and is remembered for Transform Again.
// Perspective Distort and Free Distort belong to the envelope work (WP-ENVELOPE)
// and are not offered here.

import type { Box, Matrix, Pt } from '@shared/drawGeometry'
import { about, boxToBox, refPointOf, skewing, translation, uiRotate, type RefPoint } from '@shared/draw/geometry/transform'
import type { DrawDoc } from '@shared/draw/model'
import type { DrawTool, EditorCtx, Txn } from '../editor/types'
import { applyTransform, editableBounds, editableSelection, planMatrix, type OriginSpec } from '../transform/apply'
import { angleTo, handleAt, resizeBox, type HandleId } from './helpers'
import { snap45 } from './transformTool'

type Mode = { kind: 'scale'; handle: HandleId } | { kind: 'shear'; handle: 'n' | 's' | 'e' | 'w' } | { kind: 'rotate' } | { kind: 'move' }

interface Gesture {
  mode: Mode
  start: Pt
  box: Box
  before: DrawDoc
  txn: Txn
  m: Matrix | null
  copy: boolean
  record: OriginSpec
  linear: Matrix | null
  error: string | null
}

const OPPOSITE: Record<HandleId, RefPoint> = { nw: 'br', n: 'b', ne: 'bl', e: 'l', se: 'tl', s: 't', sw: 'tr', w: 'r' }

/** Is `p` in the rotate ring just outside the box (and not inside it)? */
function inRotateRing(p: Pt, b: Box, zoom: number): boolean {
  const pad = 24 / zoom
  const inside = p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h
  const nearOut = p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad
  return nearOut && !inside
}

function gesture(ctx: EditorCtx): Gesture | null {
  const g = ctx.get().gesture
  return g && g.toolId === 'freeTransform' ? (g.data as Gesture) : null
}

function compute(g: Gesture, p: Pt, e: { shiftKey: boolean; altKey: boolean }): { m: Matrix | null; record: OriginSpec; linear: Matrix | null } {
  const b = g.box
  const centre = refPointOf(b, 'c')
  const lin = (m: Matrix): Matrix => [m[0], m[1], m[2], m[3], 0, 0]
  switch (g.mode.kind) {
    case 'move': {
      let dx = p.x - g.start.x
      let dy = p.y - g.start.y
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0
        else dx = 0
      }
      return { m: translation(dx, dy), record: { kind: 'absolute' }, linear: null }
    }
    case 'rotate': {
      let deg = -(angleTo(centre, p) - angleTo(centre, g.start))
      if (e.shiftKey) deg = snap45(deg)
      const m = uiRotate(deg, centre)
      return { m, record: { kind: 'ref', ref: 'c' }, linear: lin(m) }
    }
    case 'scale': {
      const next = resizeBox(b, g.mode.handle, p, e.shiftKey, e.altKey)
      const ref: RefPoint = e.altKey ? 'c' : OPPOSITE[g.mode.handle]
      const m = boxToBox(b, next, ref)
      return { m, record: { kind: 'ref', ref }, linear: lin(m) }
    }
    default: {
      const h = g.mode.handle
      const ref: RefPoint = e.altKey ? 'c' : OPPOSITE[h]
      const o = refPointOf(b, ref)
      const handle = refPointOf(b, h === 'n' ? 't' : h === 's' ? 'b' : h === 'e' ? 'r' : 'l')
      let m: Matrix | null = null
      if (h === 'n' || h === 's') {
        const arm = handle.y - o.y
        if (Math.abs(arm) > 1e-6) m = about(o, skewing((p.x - g.start.x) / arm, 0))
      } else {
        const arm = handle.x - o.x
        if (Math.abs(arm) > 1e-6) m = about(o, skewing(0, (p.y - g.start.y) / arm))
      }
      return { m, record: { kind: 'ref', ref }, linear: m ? lin(m) : null }
    }
  }
}

const freeTransform: DrawTool = {
  id: 'freeTransform',
  label: 'Free Transform',
  icon: 'transform',
  group: 6,
  order: 117,
  key: 'E',
  cursor: 'default',
  overlayOrder: 41,

  onPointerDown(ctx, e) {
    const s = ctx.get()
    let box = editableBounds(s.doc, s.selection)
    let mode: Mode | null = null
    if (box) {
      const h = handleAt(e.p, box, s.zoom)
      if (h === 'rot') mode = { kind: 'rotate' }
      else if (h) mode = (e.metaKey || e.ctrlKey) && (h === 'n' || h === 's' || h === 'e' || h === 'w') ? { kind: 'shear', handle: h } : { kind: 'scale', handle: h }
      else if (e.p.x >= box.x && e.p.x <= box.x + box.w && e.p.y >= box.y && e.p.y <= box.y + box.h) mode = { kind: 'move' }
      else if (inRotateRing(e.p, box, s.zoom)) mode = { kind: 'rotate' }
    }
    if (!mode) {
      const hit = ctx.hitTest(e.p)
      if (!hit) {
        ctx.select([])
        return
      }
      ctx.select(e.shiftKey ? [...new Set([...s.selection, hit.id])] : [hit.id])
      box = editableBounds(ctx.doc(), ctx.get().selection)
      if (!box) return
      mode = { kind: 'move' }
    }
    if (!editableSelection(ctx.get()).length || !box) return
    const before = ctx.doc()
    ctx.set({
      gesture: {
        toolId: 'freeTransform',
        data: { mode, start: e.p, box, before, txn: ctx.history.begin('Free Transform'), m: null, copy: false, record: { kind: 'absolute' }, linear: null, error: null } satisfies Gesture
      }
    })
  },

  onPointerMove(ctx, e) {
    const g = gesture(ctx)
    if (!g) return
    const { m, record, linear } = compute(g, e.p, e)
    const copy = g.mode.kind === 'move' && e.altKey
    if (!m) {
      g.txn.preview(g.before)
      ctx.set({ gesture: { toolId: 'freeTransform', data: { ...g, m: null } } })
      return
    }
    const plan = planMatrix(ctx, m, copy, g.before)
    g.txn.preview(plan.error ? g.before : plan.doc)
    if (plan.error) ctx.status(plan.error)
    ctx.set({ gesture: { toolId: 'freeTransform', data: { ...g, m, copy, record, linear, error: plan.error ?? null } } })
  },

  onPointerUp(ctx) {
    const g = gesture(ctx)
    if (!g) return
    ctx.history.replace(g.before)
    g.txn.cancel()
    if (!g.m || g.error) return
    if (g.mode.kind === 'move' && Math.abs(g.m[4]) < 1e-9 && Math.abs(g.m[5]) < 1e-9) return
    const label = g.mode.kind === 'move' ? (g.copy ? 'Move copy' : 'Move') : g.mode.kind === 'rotate' ? 'Rotate' : g.mode.kind === 'shear' ? 'Shear' : 'Scale'
    applyTransform(ctx, g.m, { label, copy: g.copy, record: g.record, linear: g.linear ?? undefined })
  },

  Overlay({ state, k }) {
    if (state.tool !== 'freeTransform') return null
    const b = editableBounds(state.doc, state.selection)
    if (!b) return null
    // The rotate ring: a faint outline where dragging turns the selection.
    const pad = 24 * k
    return (
      <rect
        x={b.x - pad}
        y={b.y - pad}
        width={b.w + 2 * pad}
        height={b.h + 2 * pad}
        fill="none"
        stroke="#6d5dfc"
        strokeOpacity={0.25}
        strokeWidth={k}
        strokeDasharray={`${2 * k} ${4 * k}`}
        data-testid="draw-free-transform-ring"
      />
    )
  }
}

export default freeTransform
