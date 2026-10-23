// Group Selection (no default letter, as in Illustrator; it sits under the
// Direct Selection tool there). Click selects one object INSIDE its groups;
// click it again and its group is selected, again and the group around that,
// and so on up. Shift-click adds an object or takes it away. Drag moves what
// is selected (Shift constrains to an axis; edges snap). Drag on empty canvas
// selects every object inside groups that the marquee touches. The selection
// box's handles scale and rotate exactly as with the Selection tool.
//
// This file also draws isolation mode's veil (see editor/isolation.ts): every
// tool's overlay is drawn whichever tool is active, and this is the one that
// owns group editing.

import { useMemo } from 'react'
import type { Box, Pt } from '@shared/drawGeometry'
import type { DrawNode } from '@shared/draw/model'
import { allPlaces, editableIds, isIdentityMatrix, moveObjects, outermostIds, parentMatrix, transformBox, nodeBounds, isMeasurable } from '@shared/draw/ops'
import { mapNodesDeep } from '@shared/draw/tree'
import { hitChainAt, isolatedGroup, isolationChain } from '../editor/isolation'
import type { DrawTool, EditorCtx, EditorState, Txn } from '../editor/types'
import { NodeView, GradientView, nodeGradients } from '../render/SceneView'
import { handleAt, normBox, selectionBox, snapDelta } from './helpers'
import select from './select.tool'

type GroupSelectGesture =
  | { kind: 'marquee'; from: Pt; to: Pt; additive: boolean }
  | { kind: 'move'; start: Pt; last: Pt; ids: string[]; moved: boolean; txn: Txn; climbTo: string | null }

function gesture(ctx: EditorCtx): GroupSelectGesture | null {
  const g = ctx.get().gesture
  return g && g.toolId === 'groupSelect' ? (g.data as GroupSelectGesture) : null
}

function setGesture(ctx: EditorCtx, data: GroupSelectGesture): void {
  ctx.set({ gesture: { toolId: 'groupSelect', data } })
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** Every editable object (not group) at any depth in the current scope whose visible box touches `box`. */
export function leavesInBox(s: Pick<EditorState, 'doc' | 'isolation'>, box: Box): string[] {
  const iso = isolatedGroup(s)
  const places = allPlaces(s.doc).filter((p) => p.node.type !== 'group' && p.node.type !== 'opaque' && (!iso || p.parents.some((g) => g.id === iso.id)))
  const ok = new Set(editableIds(s.doc, places.map((p) => p.node.id)))
  const out: string[] = []
  for (const p of places) {
    if (!ok.has(p.node.id) || !isMeasurable(p.node)) continue
    const m = parentMatrix(p.parents)
    const b = isIdentityMatrix(m) ? nodeBounds(p.node) : transformBox(nodeBounds(p.node), m)
    if (overlaps(b, box)) out.push(p.node.id)
  }
  return out
}

const groupSelect: DrawTool = {
  id: 'groupSelect',
  label: 'Group selection',
  icon: 'ads_click',
  group: 0,
  // After Direct Selection (20), so the flyout leads with Direct, as Illustrator's does.
  order: 21,
  flyout: 'direct',
  cursor: 'default',
  overlayOrder: 1,

  onPointerDown(ctx, e) {
    const s = ctx.get()
    const p = e.p
    // The selection box's handles work as they do with the Selection tool.
    const selBox = selectionBox(s.doc, s.selection)
    if (selBox && handleAt(p, selBox, s.zoom)) {
      select.onPointerDown?.(ctx, e)
      return
    }
    const chain = hitChainAt(s, p, 4 / s.zoom)
    if (!chain) {
      if (!e.shiftKey) ctx.select([])
      setGesture(ctx, { kind: 'marquee', from: p, to: p, additive: e.shiftKey })
      return
    }
    // The deepest member of the chain that is already selected, if any.
    let k = -1
    for (let i = chain.length - 1; i >= 0; i--) {
      if (s.selection.includes(chain[i].id)) {
        k = i
        break
      }
    }
    const leaf = chain[chain.length - 1]
    let climbTo: string | null = null
    if (e.shiftKey) {
      if (k >= 0) {
        // Shift-click on something selected takes it out of the selection.
        ctx.select(s.selection.filter((id) => id !== chain[k].id))
        return
      }
      ctx.select(outermostIds(s.doc, [...s.selection, leaf.id]))
    } else if (k < 0) {
      ctx.select([leaf.id])
    } else if (k > 0) {
      // A click (not a drag) on a selected object climbs to its group.
      climbTo = chain[k - 1].id
    }
    const txn = ctx.history.begin('Move')
    setGesture(ctx, { kind: 'move', start: p, last: p, ids: editableIds(ctx.doc(), ctx.get().selection), moved: false, txn, climbTo })
  },

  onPointerMove(ctx, e) {
    const d = gesture(ctx)
    if (!d) return
    const p = e.p
    if (d.kind === 'marquee') {
      setGesture(ctx, { ...d, to: p })
      return
    }
    const box = selectionBox(ctx.doc(), d.ids)
    if (!box) return
    let dx = p.x - d.last.x
    let dy = p.y - d.last.y
    if (e.shiftKey) {
      if (Math.abs(p.x - d.start.x) > Math.abs(p.y - d.start.y)) dy = d.start.y - d.last.y
      else dx = d.start.x - d.last.x
    }
    const snapped = snapDelta(ctx, box, dx, dy, d.ids)
    ctx.set({ guides: snapped.guides })
    d.txn.preview(moveObjects(ctx.doc(), d.ids, snapped.dx, snapped.dy))
    setGesture(ctx, { ...d, last: { x: d.last.x + snapped.dx, y: d.last.y + snapped.dy }, moved: true })
  },

  onPointerUp(ctx) {
    const d = gesture(ctx)
    if (!d) return
    const s = ctx.get()
    if (d.kind === 'marquee') {
      const box = normBox(d.from, d.to)
      if (box.w > 2 / s.zoom || box.h > 2 / s.zoom) {
        const hits = leavesInBox(s, box)
        ctx.select(outermostIds(s.doc, d.additive ? [...s.selection, ...hits] : hits))
      }
      return
    }
    if (!d.moved) {
      d.txn.cancel()
      if (d.climbTo) ctx.select(outermostIds(s.doc, [...s.selection, d.climbTo]))
      return
    }
    d.txn.commit()
  },

  Overlay({ state, k }) {
    return (
      <>
        <IsolationVeil state={state} />
        {state.gesture?.toolId === 'groupSelect' && (state.gesture.data as GroupSelectGesture).kind === 'marquee' && <Marquee d={state.gesture.data as GroupSelectGesture & { kind: 'marquee' }} k={k} />}
      </>
    )
  }
}

function Marquee({ d, k }: { d: { from: Pt; to: Pt }; k: number }): JSX.Element {
  const b = normBox(d.from, d.to)
  return <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="rgba(109,93,252,0.12)" stroke="#6d5dfc" strokeWidth={k} strokeDasharray={`${3 * k} ${3 * k}`} />
}

/**
 * Isolation mode's look: everything is dimmed behind a light veil, and the
 * isolated group is drawn again on top at full strength, in its place.
 * (The text being typed into is left to the text box, so it is not doubled.)
 */
function IsolationVeil({ state }: { state: EditorState }): JSX.Element | null {
  const chain = isolationChain(state)
  const g = chain.length ? chain[chain.length - 1] : null
  const outer = g ? parentMatrix(chain.slice(0, -1)) : null
  const editing = state.editingText
  const shown = useMemo<DrawNode | null>(() => {
    if (!g) return null
    // A live work widget is not mounted twice; it shows (dimmed) in its layer.
    const children = mapNodesDeep(g.children, (n) => (n.id === editing || n.type === 'widget' ? { ...n, hidden: true } : n))
    return children === g.children ? g : { ...g, children }
  }, [g, editing])
  if (!g || !shown || !outer) return null
  const board = state.doc.artboards[0]
  const gradients = nodeGradients(shown, state.doc)
  // Generous, so the veil also covers art on the pasteboard around the artboard.
  const pad = Math.max(board.w, board.h) * 4
  return (
    <g data-testid="draw-isolation-veil">
      <rect x={board.x - pad} y={board.y - pad} width={board.w + 2 * pad} height={board.h + 2 * pad} fill="#ffffff" opacity={0.55} />
      <defs>
        {gradients.map((gr, i) => (
          <GradientView key={`${i}:${gr.id}`} g={gr} />
        ))}
      </defs>
      <g transform={isIdentityMatrix(outer) ? undefined : `matrix(${outer.join(' ')})`}>
        <NodeView o={shown} assets={state.doc.assets} swatches={state.doc.swatches} />
      </g>
    </g>
  )
}

export default groupSelect
