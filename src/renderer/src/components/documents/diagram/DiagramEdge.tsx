import { memo, useEffect, useRef, useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, useReactFlow, type EdgeProps } from '@xyflow/react'
import { arrowHeadPath } from '@shared/diagram/arrowheads'
import { nearestT, pointAlong } from '@shared/diagram/routing'
import { dashArray, getTheme, resolveEdgeStyle } from '@shared/diagram/style'
import { useDiagramCtx } from './DiagramContext'
import { SELECT_COLOR } from './ShapeNode'

// A connector drawn from the shared router's output (orthogonal / curved /
// straight, with line jumps), so canvas and export draw the same line. When
// selected it glows, shows its bend points as draggable squares, a "+" at each
// segment midpoint to add a bend, and a label you can slide along the line.

function DiagramEdgeImpl({ id, selected }: EdgeProps): JSX.Element | null {
  const ctx = useDiagramCtx()
  const rf = useReactFlow()
  const edge = ctx.edgesById.get(id)
  const route = ctx.routes.get(id)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const editKey = `edge:${id}`
  useEffect(() => {
    if (ctx.editingId === editKey) {
      setDraft(edge?.label ?? '')
      setEditing(true)
      window.requestAnimationFrame(() => inputRef.current?.select())
    } else setEditing(false)
  }, [ctx.editingId, editKey, edge?.label])
  if (!edge || !route) return null

  const theme = getTheme(ctx.themeId)
  // A line without its own end arrow is drawn with the format default, never
  // the page setting: that setting is for NEW lines (stamped on creation).
  const st = resolveEdgeStyle(edge, ctx.themeId)
  const color = selected ? SELECT_COLOR : st.stroke
  const width = selected ? Math.max(st.strokeWidth, 2) : st.strokeWidth
  const head = 5 + st.strokeWidth * 2.2
  const pts = route.points
  const first = pts[0]!
  const last = pts[pts.length - 1]!
  const heads = [
    ...(st.startArrow !== 'none' ? arrowHeadPath(st.startArrow, first, route.startAngle, head) : []),
    ...(st.endArrow !== 'none' ? arrowHeadPath(st.endArrow, last, route.endAngle, head) : [])
  ]
  const locked = !!edge.locked || ctx.readOnly
  const routing = edge.routing ?? ctx.settings.defaultRouting ?? 'orthogonal'

  // Pointer-drag helper in flow coordinates.
  const drag = (e: React.PointerEvent, onMove: (p: { x: number; y: number }) => void): void => {
    e.stopPropagation()
    e.preventDefault()
    ctx.checkpoint()
    const move = (ev: PointerEvent): void => onMove(rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY }))
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Bend points the user can grab: the interior route points.
  const interior = pts.slice(1, -1)
  const bends = routing === 'curved' ? edge.waypoints ?? [] : interior
  const segMids = routing === 'curved' ? [] : pts.slice(0, -1).map((p, i) => ({ x: (p.x + pts[i + 1]!.x) / 2, y: (p.y + pts[i + 1]!.y) / 2, i }))

  const labelText = edge.label ?? ''
  const lp = route.labelPoint

  return (
    <>
      {selected && (
        <path d={route.path} fill="none" stroke={SELECT_COLOR} strokeOpacity={0.22} strokeWidth={width + 8} strokeLinecap="round" strokeLinejoin="round" />
      )}
      <BaseEdge
        id={id}
        path={route.path}
        interactionWidth={16}
        style={{ stroke: color, strokeWidth: width, strokeDasharray: dashArray(st.dash, st.strokeWidth), fill: 'none' }}
      />
      {heads.map((hp, i) => (
        <path
          key={i}
          d={hp.d}
          fill={hp.fill === 'stroke' ? color : hp.fill === 'background' ? ctx.settings.background || theme.background : 'none'}
          stroke={color}
          strokeWidth={Math.max(1, width * 0.9)}
          strokeLinejoin="round"
          className="pointer-events-none"
        />
      ))}
      {edge.animated && <path d={route.path} fill="none" stroke={color} strokeWidth={width} strokeDasharray="4 6" className="pd-edge-flow" />}

      <EdgeLabelRenderer>
        {(labelText || editing) && (
          <div
            className="nodrag nopan absolute"
            style={{ transform: `translate(-50%, -50%) translate(${lp.x}px, ${lp.y}px)`, pointerEvents: 'all', zIndex: selected ? 1002 : 1000 }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              if (!locked) ctx.setEditingId(editKey)
            }}
            onPointerDown={(e) => {
              if (!selected || locked || editing) return
              drag(e, (p) => ctx.setLabelPos(id, nearestT(pts, p)))
            }}
            data-testid="diagram-edge-label"
          >
            {editing ? (
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  ctx.commitLabel(editKey, draft)
                  ctx.setEditingId(null)
                }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') {
                    ctx.commitLabel(editKey, draft)
                    ctx.setEditingId(null)
                  }
                  if (e.key === 'Escape') ctx.setEditingId(null)
                }}
                className="rounded px-1 text-center outline-none bg-white"
                style={{ fontSize: st.fontSize, border: `1.5px solid ${SELECT_COLOR}`, minWidth: 60 }}
              />
            ) : (
              <span
                className="rounded px-1 whitespace-pre select-none"
                style={{
                  fontSize: st.fontSize,
                  color: st.textColor,
                  background: ctx.settings.background || theme.background,
                  outline: selected ? `1.5px solid ${SELECT_COLOR}` : undefined,
                  cursor: selected && !locked ? 'grab' : undefined
                }}
              >
                {labelText}
              </span>
            )}
          </div>
        )}

        {selected && !locked && (
          <>
            {bends.map((b, i) => (
              <div
                key={`b${i}`}
                className="nodrag nopan absolute h-2.5 w-2.5 bg-white cursor-move"
                style={{ transform: `translate(-50%, -50%) translate(${b.x}px, ${b.y}px)`, border: `1.5px solid ${SELECT_COLOR}`, pointerEvents: 'all', zIndex: 1003 }}
                title="Drag to bend · double-click to remove"
                data-testid="diagram-edge-bend"
                onPointerDown={(e) =>
                  drag(
                    e,
                    (p) => {
                      const base = routing === 'curved' ? [...(edge.waypoints ?? [])] : interior.map((q) => ({ x: q.x, y: q.y }))
                      base[i] = { x: Math.round(p.x), y: Math.round(p.y) }
                      ctx.setWaypoints(id, base)
                    }
                  )
                }
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  const base = routing === 'curved' ? [...(edge.waypoints ?? [])] : interior.map((q) => ({ x: q.x, y: q.y }))
                  base.splice(i, 1)
                  ctx.checkpoint()
                  ctx.setWaypoints(id, base.length ? base : undefined)
                }}
              />
            ))}
            {segMids.map((m) => (
              <div
                key={`m${m.i}`}
                className="nodrag nopan absolute h-3 w-3 rounded-full bg-white text-[9px] leading-[10px] text-center cursor-copy opacity-70 hover:opacity-100"
                style={{ transform: `translate(-50%, -50%) translate(${m.x}px, ${m.y}px)`, border: `1px solid ${SELECT_COLOR}`, color: SELECT_COLOR, pointerEvents: 'all', zIndex: 1003 }}
                title="Drag to add a bend"
                onPointerDown={(e) =>
                  drag(
                    e,
                    (p) => {
                      const base = interior.map((q) => ({ x: q.x, y: q.y }))
                      base.splice(m.i, 0, { x: Math.round(p.x), y: Math.round(p.y) })
                      ctx.setWaypoints(id, base)
                    }
                  )
                }
              >
                +
              </div>
            ))}
            {routing === 'curved' && (
              <div
                className="nodrag nopan absolute h-3 w-3 rounded-full bg-white text-[9px] leading-[10px] text-center cursor-copy opacity-70 hover:opacity-100"
                style={{ transform: `translate(-50%, -50%) translate(${pointAlong(pts, 0.5).x}px, ${pointAlong(pts, 0.5).y}px)`, border: `1px solid ${SELECT_COLOR}`, color: SELECT_COLOR, pointerEvents: 'all', zIndex: 1003 }}
                title="Drag to bend the curve"
                onPointerDown={(e) =>
                  drag(
                    e,
                    (p) => ctx.setWaypoints(id, [...(edge.waypoints ?? []), { x: Math.round(p.x), y: Math.round(p.y) }].slice(-6))
                  )
                }
              >
                +
              </div>
            )}
            {[first, last].map((p, i) => (
              <div
                key={`end${i}`}
                className="pointer-events-none absolute h-2.5 w-2.5 rounded-full bg-white"
                style={{ transform: `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)`, border: `2px solid ${SELECT_COLOR}`, zIndex: 1003 }}
              />
            ))}
          </>
        )}
      </EdgeLabelRenderer>
    </>
  )
}

export const DiagramEdge = memo(DiagramEdgeImpl)
