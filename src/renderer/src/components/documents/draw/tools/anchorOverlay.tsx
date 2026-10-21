// The on-canvas anchor display every anchor tool shares: the selected paths'
// outlines, their anchors (filled = selected, hollow = not), the handles that
// are shown, the path under the pointer, and the corner widgets.

import type { Pt } from '@shared/drawGeometry'
import { pathToSvgD, transformPath } from '@shared/drawGeometry'
import { cornerInfo, handleOf } from '@shared/draw/geometry/pathEdit'
import { getObject, nodeMatrix, toDoc, type AnchorRef } from '@shared/draw/ops'
import type { EditorState } from '../editor/types'
import { anchorHitAt, anchorIndex, editablePaths, handlesShown, selectedAnchors } from '../editor/anchorSelection'

const ACCENT = '#6d5dfc'

/** Where a corner widget sits for a selected corner anchor, in document space. */
export interface CornerWidget {
  ref: AnchorRef
  at: Pt
  corner: Pt
  bisector: Pt
}

/** Corner widgets for the selected corner anchors (Illustrator's live-corner dots). */
export function cornerWidgets(s: EditorState): CornerWidget[] {
  const out: CornerWidget[] = []
  const k = 1 / s.zoom
  for (const ref of selectedAnchors(s)) {
    const o = getObject(s.doc, ref.id)
    if (!o || o.type !== 'path') continue
    const sp = o.path.subpaths[ref.si]
    const info = cornerInfo(sp, ref.ni)
    if (!info) continue
    const n = sp.nodes[ref.ni]
    const bx = info.uIn.x + info.uOut.x
    const by = info.uIn.y + info.uOut.y
    const bl = Math.hypot(bx, by)
    if (bl < 1e-9) continue
    const local = { x: n.x + (bx / bl) * 16 * k, y: n.y + (by / bl) * 16 * k }
    const corner = toDoc(s.doc, ref.id, n)
    const at = toDoc(s.doc, ref.id, local)
    const d = Math.hypot(at.x - corner.x, at.y - corner.y) || 1
    out.push({ ref, at, corner, bisector: { x: (at.x - corner.x) / d, y: (at.y - corner.y) / d } })
  }
  return out
}

export function cornerWidgetAt(s: EditorState, p: Pt): CornerWidget | null {
  const r = 6 / s.zoom
  return cornerWidgets(s).find((w) => Math.hypot(w.at.x - p.x, w.at.y - p.y) <= r) ?? null
}

export function AnchorOverlay({ state, k, widgets = false, hover = true }: { state: EditorState; k: number; widgets?: boolean; hover?: boolean }): JSX.Element {
  const s = state
  const selectedPaths = editablePaths(s.doc).filter((o) => s.selection.includes(o.id))
  // The path under the pointer shows its anchors, so they can be picked directly.
  const hit = hover && s.cursorPt && !s.gesture ? anchorHitAt(s, s.cursorPt, { handles: false }) : null
  const hoverId = hit ? (hit.kind === 'segment' ? hit.id : hit.ref.id) : null
  const hovered = hoverId && !s.selection.includes(hoverId) ? editablePaths(s.doc).find((o) => o.id === hoverId) : undefined
  return (
    <g data-testid="draw-anchor-overlay">
      {hovered && (
        <g opacity={0.8}>
          <path d={pathToSvgD(transformPath(hovered.path, nodeMatrix(s.doc, hovered.id)))} fill="none" stroke={ACCENT} strokeWidth={k} />
          {hovered.path.subpaths.flatMap((sp, si) =>
            sp.nodes.map((n, ni) => {
              const p = toDoc(s.doc, hovered.id, n)
              return <rect key={`h${si}-${ni}`} x={p.x - 2.5 * k} y={p.y - 2.5 * k} width={5 * k} height={5 * k} fill="#ffffff" stroke={ACCENT} strokeWidth={k} />
            })
          )}
        </g>
      )}
      {selectedPaths.map((o) => (
        <g key={o.id} data-testid={`draw-anchors-${o.id}`}>
          <path d={pathToSvgD(transformPath(o.path, nodeMatrix(s.doc, o.id)))} fill="none" stroke={ACCENT} strokeWidth={k} />
          {o.path.subpaths.flatMap((sp, si) =>
            sp.nodes.map((n, ni) => {
              const ref = { id: o.id, si, ni }
              const p = toDoc(s.doc, o.id, n)
              const sel = anchorIndex(s).has(ref)
              const shown = handlesShown(s, ref)
              const hin = shown ? handleOf(n, 'in') : null
              const hout = shown ? handleOf(n, 'out') : null
              return (
                <g key={`${si}-${ni}`}>
                  {[hin, hout].map((h, i) => {
                    if (!h) return null
                    const q = toDoc(s.doc, o.id, h)
                    return (
                      <g key={i}>
                        <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={ACCENT} strokeWidth={k} opacity={0.7} />
                        <circle cx={q.x} cy={q.y} r={3 * k} fill={ACCENT} />
                      </g>
                    )
                  })}
                  <rect
                    x={p.x - 3.5 * k}
                    y={p.y - 3.5 * k}
                    width={7 * k}
                    height={7 * k}
                    fill={sel ? ACCENT : '#ffffff'}
                    stroke={ACCENT}
                    strokeWidth={1.5 * k}
                    data-selected={sel ? 'true' : 'false'}
                  />
                </g>
              )
            })
          )}
        </g>
      ))}
      {widgets &&
        cornerWidgets(s).map((w) => (
          <circle key={`${w.ref.id}:${w.ref.si}:${w.ref.ni}`} cx={w.at.x} cy={w.at.y} r={3.5 * k} fill="#ffffff" stroke={ACCENT} strokeWidth={1.2 * k} data-testid="draw-corner-widget" />
        ))}
    </g>
  )
}
