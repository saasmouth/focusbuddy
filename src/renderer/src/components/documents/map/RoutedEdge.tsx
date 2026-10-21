// A connector that goes around the shapes in its way, on screen.
//
// Without this the editor and the export disagree: mapExport routes its
// connectors, React Flow's default edge draws a bezier straight across
// everything, and what you arrange is not what you get out. A diagram tool
// that exports something other than what it showed you is worse than one that
// draws plain lines, because you only find out after sending the file.
//
// The routing itself is shared with the export — src/shared/mapRouting — so
// there is one algorithm and one set of tests behind both pictures.
import { memo } from 'react'
import { BaseEdge, EdgeLabelRenderer, useNodes, type EdgeProps } from '@xyflow/react'
import { routeOrthogonal, routeToPath, type RouteRect } from '@shared/mapRouting'

/** Fallback box size when a node has not been measured yet. */
const FALLBACK_W = 150
const FALLBACK_H = 48

function RoutedEdgeImpl({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  markerStart,
  style,
  label,
  data
}: EdgeProps): JSX.Element {
  const nodes = useNodes()

  const rectOf = (nid: string): RouteRect | null => {
    const n = nodes.find((x) => x.id === nid)
    if (!n) return null
    return {
      x: n.position.x,
      y: n.position.y,
      w: n.measured?.width ?? n.width ?? FALLBACK_W,
      h: n.measured?.height ?? n.height ?? FALLBACK_H
    }
  }

  const from = rectOf(source)
  const to = rectOf(target)
  const straight = (data as { routing?: string } | undefined)?.routing === 'straight'

  let d: string
  let midX = (sourceX + targetX) / 2
  let midY = (sourceY + targetY) / 2

  if (straight || !from || !to) {
    // Either asked for, or we have nothing to route with — React Flow gives
    // the endpoints even when the nodes are not measured yet, so a straight
    // line is still a correct picture rather than a missing one.
    d = `M${sourceX} ${sourceY} L${targetX} ${targetY}`
  } else {
    const obstacles = nodes
      .map((n) => rectOf(n.id))
      .filter((r): r is RouteRect => r !== null)
      // Identity matters to the router: it recognises the endpoint boxes by
      // reference, so hand it the same objects rather than fresh copies.
      .map((r) =>
        Math.abs(r.x - from.x) < 0.01 && Math.abs(r.y - from.y) < 0.01
          ? from
          : Math.abs(r.x - to.x) < 0.01 && Math.abs(r.y - to.y) < 0.01
            ? to
            : r
      )
    const pts = routeOrthogonal(from, to, obstacles)
    d = routeToPath(pts, 8)
    const mid = pts.length === 2 ? { x: midX, y: midY } : pts[Math.floor(pts.length / 2)]
    midX = mid.x
    midY = mid.y
  }

  return (
    <>
      <BaseEdge id={id} path={d} markerEnd={markerEnd} markerStart={markerStart} style={style} />
      {label ? (
        <EdgeLabelRenderer>
          <div
            // Placed at the middle of the ROUTE, not the midpoint of the
            // straight line between the ends: on a connector that goes around
            // something those are nowhere near each other and the label ends
            // up floating in empty space.
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)`,
              pointerEvents: 'all',
              fontSize: 11,
              color: '#334155',
              background: 'rgba(255,255,255,0.85)',
              padding: '0 3px',
              borderRadius: 3
            }}
            className="nodrag nopan"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

export const RoutedEdge = memo(RoutedEdgeImpl)
export default RoutedEdge
