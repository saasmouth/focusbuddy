// Clipper2 0.4.0 compiled to WebAssembly (BSL-1.0) as a GeometryEngine:
// polygon booleans (every fill rule, integer-robust), Offset Path and Outline
// Stroke. Curves are flattened first (0.05px for offsets, 0.25px for
// booleans), so results are polygons; refitting to curves is WP-GEO's job.
//
// MAIN PROCESS / NODE ONLY. Its loader compiles WebAssembly and generates code
// with `new Function`, which the renderer's CSP (script-src 'self') refuses.

import { flattenPath, type BooleanOp, type DrawNode, type DrawPath, type DrawSubpath } from '../../drawGeometry'
import { inRenderer, type GeometryEngine, type OffsetOptions, type OutlineOptions } from './engine'

/* eslint-disable @typescript-eslint/no-explicit-any */
type W = any

const PRECISION = 4

/** The subpaths as Clipper paths; `closed` picks only closed (true) or only open (false) ones. */
function toPathsD(w: W, p: DrawPath, tolerance: number, closed?: boolean): W {
  const ps = new w.PathsD()
  for (const sp of p.subpaths) {
    if (closed !== undefined && sp.closed !== closed) continue
    const ring = flattenPath({ subpaths: [{ ...sp, closed: sp.closed }] }, tolerance)[0]
    if (!ring || ring.length < 2) continue
    const pts = sp.closed && ring.length > 1 && ring[0].x === ring[ring.length - 1].x && ring[0].y === ring[ring.length - 1].y ? ring.slice(0, -1) : ring
    const flat: number[] = []
    for (const q of pts) flat.push(q.x, q.y)
    ps.push_back(w.MakePathD(flat))
  }
  return ps
}

function fromPathsD(ps: W): DrawPath {
  const subpaths: DrawSubpath[] = []
  for (let i = 0; i < ps.size(); i++) {
    const path = ps.get(i)
    const n = path.size()
    const v = path.view() as Float64Array
    const stride = n ? v.length / n : 2
    const nodes: DrawNode[] = []
    for (let k = 0; k < n; k++) nodes.push({ x: v[k * stride], y: v[k * stride + 1] })
    if (nodes.length) subpaths.push({ closed: true, nodes })
  }
  return { subpaths }
}

export async function createClipperEngine(): Promise<GeometryEngine> {
  if (inRenderer()) {
    throw new Error('Clipper2 runs in the main process only: the renderer’s Content-Security-Policy refuses WebAssembly compilation and generated code.')
  }
  const factory = (await import('clipper2-wasm/dist/es/clipper2z.js')).default
  const w: W = await factory()
  const join = (j: OffsetOptions['join'] | undefined): W => (j === 'round' ? w.JoinType.Round : j === 'bevel' ? w.JoinType.Square : w.JoinType.Miter)
  const CLIP: Record<BooleanOp, W> = { union: w.ClipType.Union, intersect: w.ClipType.Intersection, subtract: w.ClipType.Difference, exclude: w.ClipType.Xor }
  return {
    id: 'clipper',
    label: 'Clipper2 0.4.0 (wasm)',
    preservesCurves: false,
    runsInRenderer: false,
    boolean(a, b, op) {
      const A = toPathsD(w, a, 0.25)
      const B = toPathsD(w, b, 0.25)
      const out = w.BooleanOpD(CLIP[op], a.fillRule === 'evenodd' ? w.FillRule.EvenOdd : w.FillRule.NonZero, A, B, PRECISION)
      const r = fromPathsD(out)
      A.delete()
      B.delete()
      out.delete()
      return r
    },
    offset(p, delta, opts) {
      const ps = toPathsD(w, p, 0.05)
      const out = w.InflatePathsD(ps, delta, join(opts.join), w.EndType.Polygon, opts.miterLimit ?? 4, PRECISION, 0.05)
      const r = fromPathsD(out)
      ps.delete()
      out.delete()
      return r
    },
    outlineStroke(p, opts: OutlineOptions) {
      const half = opts.width / 2
      const jt = join(opts.join)
      const cap = opts.cap === 'round' ? w.EndType.Round : opts.cap === 'square' ? w.EndType.Square : w.EndType.Butt
      // Open subpaths get end caps; closed ones are stroked as rings.
      const open = toPathsD(w, p, 0.05, false)
      const closed = toPathsD(w, p, 0.05, true)
      const a = w.InflatePathsD(open, half, jt, cap, opts.miterLimit ?? 4, PRECISION, 0.05)
      const b = w.InflatePathsD(closed, half, jt, w.EndType.Joined, opts.miterLimit ?? 4, PRECISION, 0.05)
      const both = w.UnionD(a, b, w.FillRule.NonZero, PRECISION)
      const r = fromPathsD(both)
      for (const x of [open, closed, a, b, both]) x.delete()
      return r
    }
  }
}
