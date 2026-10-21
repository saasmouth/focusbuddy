// One interface for every geometry engine PlexiiDraw can use, so the engine
// behind Pathfinder, Offset Path and Outline Stroke can be swapped without
// touching a feature. See /private/tmp/claude-501/draw-plan/GEOMETRY-SPIKE.md
// (the spike that chose them) and documents/draw/README.md.
//
// PHASE 0: the interface, the three adapters and their tests. Nothing in the
// app imports this yet -- WP-GEO / WP-PATHFINDER wire it into features.
//
//   inhouse  drawGeometry.booleanPath: flattens curves; synchronous; no
//            offset. Correct on rectilinear input; KNOWN DEFECT on thin
//            overlaps of curves (see the spike and drawGeometryEngines.test).
//   paper    paper.js 0.12.18 (MIT): booleans on the true cubics, results
//            keep their curves. No eval, so it runs in the renderer.
//   clipper  Clipper2 0.4.0 wasm (BSL-1.0): integer-robust polygon booleans,
//            offset, outline stroke. Its loader compiles WebAssembly and
//            uses `new Function`, both refused by the renderer's CSP
//            (script-src 'self'), so it runs in the main process (or a test).

import type { BooleanOp, DrawPath } from '../../drawGeometry'

export type EngineId = 'inhouse' | 'paper' | 'clipper'

export interface OffsetOptions {
  join: 'miter' | 'round' | 'bevel'
  /** Miter limit as a multiple of the offset (Illustrator's "Miter limit"). */
  miterLimit?: number
}

export interface OutlineOptions {
  /** Stroke width (the outline extends width / 2 each side). */
  width: number
  join?: 'miter' | 'round' | 'bevel'
  cap?: 'butt' | 'round' | 'square'
  miterLimit?: number
}

export interface GeometryEngine {
  id: EngineId
  label: string
  /** Results keep bezier curves (true) or come back as polygons (false). */
  preservesCurves: boolean
  /** Can be loaded under the renderer's CSP (no eval, no wasm compilation). */
  runsInRenderer: boolean
  boolean(a: DrawPath, b: DrawPath, op: BooleanOp): DrawPath
  /** Offset Path: grow (delta > 0) or shrink a closed shape. */
  offset?(p: DrawPath, delta: number, opts: OffsetOptions): DrawPath
  /** Outline Stroke: the filled outline a stroke of `opts.width` paints. */
  outlineStroke?(p: DrawPath, opts: OutlineOptions): DrawPath
}

/** Whether this code is running in an Electron renderer (where the CSP applies). */
export function inRenderer(): boolean {
  const proc = (globalThis as { process?: { type?: string } }).process
  return proc?.type === 'renderer' || (typeof (globalThis as { window?: unknown }).window !== 'undefined' && !proc)
}

/**
 * Why an engine's result cannot be trusted, or null when it can: every
 * coordinate finite, every subpath non-empty. A feature that gets a reason
 * here falls back to another engine and says so -- it never shows the broken
 * geometry.
 */
export function invalidResult(r: DrawPath): string | null {
  for (const sp of r.subpaths) {
    if (sp.nodes.length === 0) return 'an empty subpath'
    for (const n of sp.nodes) {
      for (const v of [n.x, n.y, n.inX, n.inY, n.outX, n.outY]) if (v !== undefined && !Number.isFinite(v)) return 'a non-finite coordinate'
    }
  }
  return null
}
