// The PlexiDiagrams shape contract. One definition per shape drives every
// surface: the editor canvas (SVG), the palette thumbnails, the SVG/PNG/PDF
// export, connector routing (outline + ports) and hit testing. Pure data and
// maths only — no React, no DOM — so it runs in the renderer, main process and
// unit tests alike.

import type { MapNodeStyle } from '../../types'

export type ShapeCategory =
  | 'Basic'
  | 'Flowchart'
  | 'Arrows'
  | 'Containers'
  | 'UML'
  | 'ERD'
  | 'BPMN'
  | 'Network'
  | 'Cloud'
  | 'Org chart'
  | 'Mind map'
  | 'Wireframe'
  | 'Sticky notes'
  | 'Tables'
  | 'Callouts'
  | 'Plexii'

// How a part is painted, relative to the node's resolved style:
//   fill   — the shape fill + stroke (the main body)
//   stroke — outline only, no fill (inner lines, dividers)
//   shade  — the stroke colour at low opacity (cylinder tops, cube sides, folds)
//   solid  — filled with the stroke colour (arrow tips, BPMN end-event rings)
//   none   — invisible (hit areas only)
export type ShapePaint = 'fill' | 'stroke' | 'shade' | 'solid' | 'none'

export interface ShapePart {
  d: string // SVG path data in node-local coordinates (0,0)–(w,h)
  paint: ShapePaint
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface ShapeGeometry {
  parts: ShapePart[]
  text: Rect // where the label sits
}

// Special renderers for shapes whose body is not just paths.
export type ShapeSpecial =
  | 'table' // grid from node.cells
  | 'umlClass' // name + attribute/method compartments from label lines
  | 'erdEntity' // name + attribute rows from label lines
  | 'image' // node.image fitted inside
  | 'icon' // node.icon (Material Symbols) centred, label below
  | 'widget' // live desk widget embed
  | 'text' // free text, no outline
  | 'sticky' // folded sticky note (paths + coloured fill)
  | 'lane' // container with a title band

/** What a shape's geometry may read from the node it draws. */
export interface ShapeDrawContext {
  cells?: string[][]
}

export interface ShapeDef {
  id: string // stable, saved in documents — never rename
  label: string // palette name
  category: ShapeCategory
  keywords?: string[] // extra search terms
  w: number // default width
  h: number // default height
  minW?: number
  minH?: number
  aspectLocked?: boolean // resize keeps proportions by default (circles, icons)
  // `node` is the shape being drawn, for the few shapes whose geometry depends
  // on its contents (a table's grid follows its cells). Absent in the palette.
  draw: (w: number, h: number, node?: ShapeDrawContext) => ShapeGeometry
  // Outline used for connector attachment and routing obstacles. Defaults to the
  // first 'fill' part. Must be a closed path.
  outline?: (w: number, h: number) => string
  // Connection points as fractions of the box ([0..1, 0..1]). Defaults to the
  // four side midpoints. The editor shows these as ports; routing snaps to them.
  ports?: [number, number][]
  defaultLabel?: string
  container?: boolean // other shapes can be placed inside (lanes, pools, frames)
  special?: ShapeSpecial
  icon?: string // default Material Symbols icon for icon shapes
  defaultStyle?: Partial<MapNodeStyle>
  color?: string // default stroke/accent colour when added
}

export const DEFAULT_PORTS: [number, number][] = [
  [0.5, 0],
  [1, 0.5],
  [0.5, 1],
  [0, 0.5]
]

// ── path helpers (shared by every shape file) ───────────────────────────────

export const r = (n: number): string => (Math.round(n * 100) / 100).toString()

// Closed polygon from absolute points.
export function poly(points: [number, number][]): string {
  return `M${points.map(([x, y]) => `${r(x)},${r(y)}`).join(' L')} Z`
}

// Closed polygon from fractional points scaled to the box.
export function fpoly(w: number, h: number, points: [number, number][]): string {
  return poly(points.map(([x, y]) => [x * w, y * h]))
}

export function rect(x: number, y: number, w: number, h: number, rad = 0): string {
  if (rad <= 0) return `M${r(x)},${r(y)} H${r(x + w)} V${r(y + h)} H${r(x)} Z`
  const k = Math.min(rad, w / 2, h / 2)
  return (
    `M${r(x + k)},${r(y)} H${r(x + w - k)} A${r(k)},${r(k)} 0 0 1 ${r(x + w)},${r(y + k)} ` +
    `V${r(y + h - k)} A${r(k)},${r(k)} 0 0 1 ${r(x + w - k)},${r(y + h)} ` +
    `H${r(x + k)} A${r(k)},${r(k)} 0 0 1 ${r(x)},${r(y + h - k)} ` +
    `V${r(y + k)} A${r(k)},${r(k)} 0 0 1 ${r(x + k)},${r(y)} Z`
  )
}

export function ellipse(cx: number, cy: number, rx: number, ry: number): string {
  return (
    `M${r(cx - rx)},${r(cy)} A${r(rx)},${r(ry)} 0 1 0 ${r(cx + rx)},${r(cy)} ` +
    `A${r(rx)},${r(ry)} 0 1 0 ${r(cx - rx)},${r(cy)} Z`
  )
}

export function line(x1: number, y1: number, x2: number, y2: number): string {
  return `M${r(x1)},${r(y1)} L${r(x2)},${r(y2)}`
}

// Text box inset from the full shape box.
export function inset(w: number, h: number, l: number, t = l, rt = l, b = t): Rect {
  return { x: l, y: t, w: Math.max(0, w - l - rt), h: Math.max(0, h - t - b) }
}

// Regular polygon / star points inside the box.
export function regular(w: number, h: number, sides: number, rotationDeg = -90): [number, number][] {
  const pts: [number, number][] = []
  for (let i = 0; i < sides; i++) {
    const a = ((rotationDeg + (360 / sides) * i) * Math.PI) / 180
    pts.push([w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)])
  }
  return pts
}

export function star(w: number, h: number, points: number, innerRatio: number): [number, number][] {
  const pts: [number, number][] = []
  for (let i = 0; i < points * 2; i++) {
    const a = ((-90 + (180 / points) * i) * Math.PI) / 180
    const k = i % 2 === 0 ? 1 : innerRatio
    pts.push([w / 2 + (w / 2) * k * Math.cos(a), h / 2 + (h / 2) * k * Math.sin(a)])
  }
  return pts
}
