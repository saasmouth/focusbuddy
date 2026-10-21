// Everything drawn OVER the artwork, in artboard units, with strokes and
// handles kept a constant size on screen (k = 1 / zoom): the grid, smart
// guides, each tool's own previews (marquee, shape rubber band, pencil trail,
// pen draft, point handles), and the selection frame.

import type { DrawArtboard } from '@shared/draw/model'
import type { EditorState } from '../editor/types'
import { drawTools } from '../tools/registry'
import { HANDLES, handlePoint, selectionBox } from '../tools/helpers'

const GRID = 50

export default function Overlay({ state, board, stageW, stageH }: { state: EditorState; board: DrawArtboard; stageW: number; stageH: number }): JSX.Element {
  const k = 1 / state.zoom
  const selBox = selectionBox(state.doc, state.selection)
  const overlays = drawTools()
    .filter((t) => t.Overlay)
    .sort((a, b) => (a.overlayOrder ?? 0) - (b.overlayOrder ?? 0))
  return (
    <svg
      width={stageW}
      height={stageH}
      viewBox={`${board.x} ${board.y} ${board.w} ${board.h}`}
      className="absolute left-0 top-0 pointer-events-none"
      data-testid="draw-overlay"
    >
      {state.showGrid && (
        <g opacity={0.25}>
          {Array.from({ length: Math.floor(board.w / GRID) }, (_, i) => (
            <line key={`gx${i}`} x1={board.x + (i + 1) * GRID} y1={board.y} x2={board.x + (i + 1) * GRID} y2={board.y + board.h} stroke="#0ea5e9" strokeWidth={k} />
          ))}
          {Array.from({ length: Math.floor(board.h / GRID) }, (_, i) => (
            <line key={`gy${i}`} x1={board.x} y1={board.y + (i + 1) * GRID} x2={board.x + board.w} y2={board.y + (i + 1) * GRID} stroke="#0ea5e9" strokeWidth={k} />
          ))}
        </g>
      )}

      {state.guides.map((g, i) =>
        g.axis === 'x' ? (
          <line key={i} x1={g.at} y1={board.y} x2={g.at} y2={board.y + board.h} stroke="#ec4899" strokeWidth={k} />
        ) : (
          <line key={i} x1={board.x} y1={g.at} x2={board.x + board.w} y2={g.at} stroke="#ec4899" strokeWidth={k} />
        )
      )}

      {overlays.map((t) => {
        const O = t.Overlay!
        return <O key={t.id} state={state} k={k} />
      })}

      {/* Selection frame */}
      {selBox && state.tool !== 'node' && (
        <g data-testid="draw-selection">
          <rect x={selBox.x} y={selBox.y} width={selBox.w} height={selBox.h} fill="none" stroke="#6d5dfc" strokeWidth={k} />
          <line x1={selBox.x + selBox.w / 2} y1={selBox.y} x2={selBox.x + selBox.w / 2} y2={selBox.y - 22 * k} stroke="#6d5dfc" strokeWidth={k} />
          <circle cx={selBox.x + selBox.w / 2} cy={selBox.y - 22 * k} r={4 * k} fill="#ffffff" stroke="#6d5dfc" strokeWidth={1.5 * k} />
          {HANDLES.map((h) => {
            const p = handlePoint(selBox, h)
            return <rect key={h} x={p.x - 4 * k} y={p.y - 4 * k} width={8 * k} height={8 * k} fill="#ffffff" stroke="#6d5dfc" strokeWidth={1.5 * k} />
          })}
        </g>
      )}
    </svg>
  )
}
