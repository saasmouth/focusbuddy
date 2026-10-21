// The PlexiDiagrams shape registry: every shape the editor can place, keyed by
// its saved id. Category files each export an array of ShapeDef; this index
// merges them. The first definition of an id wins, so legacy ids are protected.

import { LEGACY_SHAPES } from './legacy'
import { BASIC_SHAPES } from './basic'
import { FLOWCHART_SHAPES } from './flowchart'
import { ARROW_SHAPES } from './arrows'
import { CONTAINER_SHAPES } from './containers'
import { CALLOUT_SHAPES } from './callouts'
import { STICKY_SHAPES } from './sticky'
import { TABLE_SHAPES } from './tables'
import { UML_SHAPES } from './uml'
import { ERD_SHAPES } from './erd'
import { BPMN_SHAPES } from './bpmn'
import { NETWORK_SHAPES } from './network'
import { CLOUD_SHAPES } from './cloud'
import { ORGCHART_SHAPES } from './orgchart'
import { MINDMAP_SHAPES } from './mindmap'
import { WIREFRAME_SHAPES } from './wireframe'
import { DEFAULT_PORTS, type ShapeCategory, type ShapeDef, type ShapeGeometry } from './types'

export * from './types'

const ALL: ShapeDef[] = [
  ...LEGACY_SHAPES,
  ...BASIC_SHAPES,
  ...FLOWCHART_SHAPES,
  ...ARROW_SHAPES,
  ...CONTAINER_SHAPES,
  ...CALLOUT_SHAPES,
  ...STICKY_SHAPES,
  ...TABLE_SHAPES,
  ...UML_SHAPES,
  ...ERD_SHAPES,
  ...BPMN_SHAPES,
  ...NETWORK_SHAPES,
  ...CLOUD_SHAPES,
  ...ORGCHART_SHAPES,
  ...MINDMAP_SHAPES,
  ...WIREFRAME_SHAPES
]

const BY_ID = new Map<string, ShapeDef>()
for (const s of ALL) if (!BY_ID.has(s.id)) BY_ID.set(s.id, s)

export const SHAPES: ShapeDef[] = [...BY_ID.values()]

// Palette order.
export const SHAPE_CATEGORIES: ShapeCategory[] = [
  'Basic',
  'Flowchart',
  'Arrows',
  'Containers',
  'Callouts',
  'Sticky notes',
  'Tables',
  'UML',
  'ERD',
  'BPMN',
  'Network',
  'Cloud',
  'Org chart',
  'Mind map',
  'Wireframe',
  'Plexii'
]

export function getShape(id: string): ShapeDef {
  return BY_ID.get(id) ?? BY_ID.get('process')!
}

export function isShapeId(id: unknown): id is string {
  return typeof id === 'string' && BY_ID.has(id)
}

export function shapesIn(category: ShapeCategory): ShapeDef[] {
  return SHAPES.filter((s) => s.category === category)
}

export function searchShapes(query: string): ShapeDef[] {
  const q = query.trim().toLowerCase()
  if (!q) return SHAPES
  const words = q.split(/\s+/)
  return SHAPES.filter((s) => {
    const hay = `${s.label} ${s.id} ${s.category} ${(s.keywords ?? []).join(' ')}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

export function shapeGeometry(id: string, w: number, h: number): ShapeGeometry {
  return getShape(id).draw(w, h)
}

export function shapePorts(id: string): [number, number][] {
  return getShape(id).ports ?? DEFAULT_PORTS
}

// The closed outline used for routing and attachment.
export function shapeOutline(id: string, w: number, h: number): string {
  const def = getShape(id)
  if (def.outline) return def.outline(w, h)
  const g = def.draw(w, h)
  return (g.parts.find((p) => p.paint === 'fill') ?? g.parts[0])?.d ?? `M0,0 H${w} V${h} H0 Z`
}
