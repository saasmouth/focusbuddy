// paper.js 0.12.18 (MIT) as a GeometryEngine: booleans on the true cubic
// curves. Conversion is lossless both ways -- both models are absolute-
// position cubic beziers; paper stores handles relative to their anchor.
//
// paper-core is the build without PaperScript: it contains no eval, so it runs
// under the renderer's CSP. It gets its own PaperScope, never the global one.

import type { BooleanOp, DrawNode, DrawPath } from '../../drawGeometry'
import type { GeometryEngine } from './engine'

// The few paper.js shapes this adapter touches.
interface PPoint {
  x: number
  y: number
  isZero(): boolean
}
interface PSegment {
  point: PPoint
  handleIn: PPoint
  handleOut: PPoint
}
interface PPath {
  className: string
  closed: boolean
  segments: PSegment[]
  children?: PPath[]
  reorient?(nonZero: boolean, clockwise: boolean): unknown
  unite(o: PPath, opts: object): PPath
  intersect(o: PPath, opts: object): PPath
  subtract(o: PPath, opts: object): PPath
  exclude(o: PPath, opts: object): PPath
}
interface PScope {
  setup(size: unknown): void
  Size: new (w: number, h: number) => unknown
  Point: new (x: number, y: number) => PPoint
  Segment: new (p: PPoint, hin: PPoint | null, hout: PPoint | null) => PSegment
  Path: new (o: object) => PPath
  CompoundPath: new (o: object) => PPath
}

const METHOD: Record<BooleanOp, 'unite' | 'intersect' | 'subtract' | 'exclude'> = { union: 'unite', intersect: 'intersect', subtract: 'subtract', exclude: 'exclude' }

export function toPaperPath(scope: PScope, p: DrawPath): PPath {
  const children = p.subpaths.map(
    (sp) =>
      new scope.Path({
        insert: false,
        closed: sp.closed,
        segments: sp.nodes.map(
          (n) =>
            new scope.Segment(
              new scope.Point(n.x, n.y),
              n.inX != null ? new scope.Point(n.inX - n.x, (n.inY ?? n.y) - n.y) : null,
              n.outX != null ? new scope.Point(n.outX - n.x, (n.outY ?? n.y) - n.y) : null
            )
        )
      })
  )
  return new scope.CompoundPath({ insert: false, children, fillRule: p.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' })
}

export function fromPaperPath(item: PPath): DrawPath {
  const paths = item.className === 'CompoundPath' ? (item.children ?? []) : [item]
  const subpaths = paths
    .map((pp) => ({
      closed: pp.closed,
      nodes: pp.segments.map((s): DrawNode => {
        const n: DrawNode = { x: s.point.x, y: s.point.y }
        if (!s.handleIn.isZero()) {
          n.inX = s.point.x + s.handleIn.x
          n.inY = s.point.y + s.handleIn.y
        }
        if (!s.handleOut.isZero()) {
          n.outX = s.point.x + s.handleOut.x
          n.outY = s.point.y + s.handleOut.y
        }
        return n
      })
    }))
    .filter((sp) => sp.nodes.length > 0)
  return { subpaths }
}

export async function createPaperEngine(): Promise<GeometryEngine> {
  const mod = (await import('paper/dist/paper-core')) as unknown as { default?: { PaperScope: new () => PScope }; PaperScope?: new () => PScope }
  const ns = mod.default ?? (mod as { PaperScope: new () => PScope })
  const scope = new ns.PaperScope()
  scope.setup(new scope.Size(1, 1))
  return {
    id: 'paper',
    label: 'paper.js 0.12.18',
    preservesCurves: true,
    runsInRenderer: true,
    boolean(a, b, op) {
      const r = toPaperPath(scope, a)[METHOD[op]](toPaperPath(scope, b), { insert: false })
      // paper may return pieces wound either way (Exclude gives A-B and B-A
      // wound opposite). Reorienting makes the windings nonzero-consistent,
      // which is the fill rule a DrawPath means.
      r.reorient?.(true, true)
      return fromPaperPath(r)
    }
  }
}
