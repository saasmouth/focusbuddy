// The in-house engine: drawGeometry.booleanPath behind the GeometryEngine
// interface. Kept as the reference the other engines are checked against on
// the rectilinear sweep; not a fallback for curves (see engine.ts).

import { booleanPath } from '../../drawGeometry'
import type { GeometryEngine } from './engine'

export const inhouseEngine: GeometryEngine = {
  id: 'inhouse',
  label: 'In-house (flattening)',
  preservesCurves: false,
  runsInRenderer: true,
  boolean: (a, b, op) => booleanPath(a, b, op)
}
