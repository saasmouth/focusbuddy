// Artboard tool (⇧O, as in Illustrator), WP-ARTBOARD:
//   - drag on the pasteboard (or Shift-drag anywhere, even inside an
//     artboard) to draw a new artboard;
//   - click an artboard to make it active; drag inside it to move it -- with
//     the art on it, unless Move/Copy Artwork with Artboard is off;
//   - Alt-drag an artboard to duplicate it (and its art) at the drop point;
//   - drag one of the active artboard's eight handles to resize it (Shift
//     keeps its proportions, Alt resizes about its centre). Resizing never
//     moves or scales the art; the artboard's page-sized paint layers are
//     re-laid to the new size (cropped or extended, never stretched).
//   - moving an artboard carries its art AND the paint layers on it.
// Each gesture is one undo step. Several artboards are v2-only content, so a
// drawing that must stay v1 for a live session refuses with the reason.

import type { Box, Pt } from '@shared/drawGeometry'
import type { DrawDoc } from '@shared/draw/model'
import { addArtboard, artboardAt, artboardById, duplicateArtboard, moveArtboards, normalArtboardRect, patchArtboard, primaryArtboard } from '@shared/draw/ops'
import { activateArtboard, copyNode, followResizeInPlace, guardArtboards, moveArtWithArtboard, newArtboardId } from '../editor/artboards'
import type { DrawTool, EditorCtx, Txn } from '../editor/types'
import { HANDLES, handlePoint, normBox, resizeBox, squareOff, type HandleId } from './helpers'

type ArtboardGesture =
  | { mode: 'new'; from: Pt; to: Pt; square: boolean }
  | { mode: 'move'; id: string; from: Pt; to: Pt; txn: Txn; before: DrawDoc; moved: boolean }
  | { mode: 'dup'; id: string; from: Pt; to: Pt }
  | { mode: 'resize'; id: string; handle: HandleId; start: Box; txn: Txn; before: DrawDoc; resized: boolean }

/** Snap a delta to whole pixels: artboards sit on the pixel grid. */
const whole = (v: number): number => Math.round(v)

/** Which handle of the active artboard is under a point (8 px on screen). */
export function artboardHandleAt(ctx: EditorCtx, p: Pt): HandleId | null {
  const s = ctx.get()
  const a = primaryArtboard(s.doc)
  const r = 6 / s.zoom
  for (const h of HANDLES) {
    const hp = handlePoint(a, h)
    if (Math.abs(p.x - hp.x) <= r && Math.abs(p.y - hp.y) <= r) return h
  }
  return null
}

const artboard: DrawTool = {
  id: 'artboard',
  label: 'Artboard',
  icon: 'dashboard_customize',
  group: 5,
  order: 158,
  key: 'Shift+O',
  cursor: 'crosshair',
  overlayOrder: 5,

  onPointerDown(ctx, e) {
    if (!guardArtboards(ctx)) return
    const doc = ctx.doc()
    const handle = artboardHandleAt(ctx, e.p)
    if (handle && !e.shiftKey) {
      const a = primaryArtboard(doc)
      ctx.set({ gesture: { toolId: 'artboard', data: { mode: 'resize', id: a.id, handle, start: { x: a.x, y: a.y, w: a.w, h: a.h }, before: doc, txn: ctx.history.begin('Resize Artboard'), resized: false } satisfies ArtboardGesture } })
      return
    }
    const hit = e.shiftKey ? undefined : artboardAt(doc, e.p)
    if (hit) {
      activateArtboard(ctx, hit.id)
      const data: ArtboardGesture = e.altKey
        ? { mode: 'dup', id: hit.id, from: e.p, to: e.p }
        : { mode: 'move', id: hit.id, from: e.p, to: e.p, before: ctx.doc(), txn: ctx.history.begin('Move Artboard'), moved: false }
      ctx.set({ gesture: { toolId: 'artboard', data } })
      return
    }
    ctx.set({ gesture: { toolId: 'artboard', data: { mode: 'new', from: e.p, to: e.p, square: false } satisfies ArtboardGesture } })
  },

  onPointerMove(ctx, e) {
    const g = ctx.get().gesture
    if (!g || g.toolId !== 'artboard') return
    const d = g.data as ArtboardGesture
    if (d.mode === 'new' || d.mode === 'dup') {
      ctx.set({ gesture: { toolId: 'artboard', data: { ...d, to: e.p, ...(d.mode === 'new' ? { square: e.shiftKey } : {}) } } })
      return
    }
    if (d.mode === 'move') {
      const dx = whole(e.p.x - d.from.x)
      const dy = whole(e.p.y - d.from.y)
      // Every preview starts from the document as the gesture began.
      d.txn.preview(moveArtboards(d.before, [d.id], dx, dy, moveArtWithArtboard(ctx.get())))
      ctx.set({ gesture: { toolId: 'artboard', data: { ...d, to: e.p, moved: d.moved || dx !== 0 || dy !== 0 } } })
      return
    }
    const r = normalArtboardRect(resizeBox(d.start, d.handle, e.p, e.shiftKey, e.altKey))
    const next = patchArtboard(d.before, d.id, r)
    d.txn.preview(next)
    ctx.set({ gesture: { toolId: 'artboard', data: { ...d, resized: next !== d.before } } })
  },

  onPointerUp(ctx, e) {
    const g = ctx.get().gesture
    if (!g || g.toolId !== 'artboard') return
    const d = g.data as ArtboardGesture
    if (d.mode === 'move') {
      if (d.moved) d.txn.commit()
      else d.txn.cancel()
      return
    }
    if (d.mode === 'resize') {
      if (!d.resized) return d.txn.cancel()
      d.txn.commit()
      // The artboard's page-sized paint follows (re-laid, never stretched), in this same step.
      void followResizeInPlace(ctx, d.before, d.id)
      return
    }
    if (d.mode === 'dup') {
      const dx = whole(e.p.x - d.from.x)
      const dy = whole(e.p.y - d.from.y)
      if (!dx && !dy) return
      const r = duplicateArtboard(ctx.doc(), d.id, newArtboardId(), dx, dy, { withArt: moveArtWithArtboard(ctx.get()), copyNode })
      ctx.history.commit(r.doc, 'Duplicate Artboard')
      if (r.newNodeIds.length) ctx.select(r.newNodeIds)
      return
    }
    const to = d.square ? squareOff(d.from, e.p) : e.p
    const box = normBox(d.from, to)
    // A click on the pasteboard is not an artboard: Illustrator needs a drag.
    if (box.w * ctx.get().zoom < 4 || box.h * ctx.get().zoom < 4) return
    const doc = ctx.doc()
    ctx.history.commit(addArtboard(doc, newArtboardId(), box), 'New Artboard')
    const added = doc.artboards.length + 1
    ctx.status(`Artboard ${added} of ${added} — ${Math.round(box.w)} × ${Math.round(box.h)}.`)
  },

  Overlay({ state, k }) {
    if (state.tool !== 'artboard') return null
    const doc = state.doc
    const active = primaryArtboard(doc)
    const g = state.gesture?.toolId === 'artboard' ? (state.gesture.data as ArtboardGesture) : null
    const ghost =
      g?.mode === 'new'
        ? normBox(g.from, g.square ? squareOff(g.from, g.to) : g.to)
        : g?.mode === 'dup'
          ? (() => {
              const a = artboardById(doc, g.id)
              return a ? { x: a.x + whole(g.to.x - g.from.x), y: a.y + whole(g.to.y - g.from.y), w: a.w, h: a.h } : null
            })()
          : null
    return (
      <g data-testid="draw-artboard-tool-overlay" pointerEvents="none">
        {doc.artboards.map((a) => (
          <rect key={a.id} x={a.x} y={a.y} width={a.w} height={a.h} fill="none" stroke={a.id === active.id ? '#6d5dfc' : '#a8a29e'} strokeWidth={(a.id === active.id ? 1.5 : 1) * k} strokeDasharray={a.id === active.id ? undefined : `${4 * k} ${3 * k}`} />
        ))}
        {HANDLES.map((h) => {
          const p = handlePoint(active, h)
          return <rect key={h} data-testid={`draw-artboard-handle-${h}`} x={p.x - 4 * k} y={p.y - 4 * k} width={8 * k} height={8 * k} fill="#ffffff" stroke="#6d5dfc" strokeWidth={1.5 * k} />
        })}
        {ghost && <rect data-testid="draw-artboard-ghost" x={ghost.x} y={ghost.y} width={ghost.w} height={ghost.h} fill="#6d5dfc" fillOpacity={0.06} stroke="#6d5dfc" strokeWidth={k} strokeDasharray={`${4 * k} ${3 * k}`} />}
      </g>
    )
  }
}

export default artboard
