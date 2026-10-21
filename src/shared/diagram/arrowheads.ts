// Connector end markers for PlexiDiagrams, drawn as plain SVG path data so the
// canvas and every exporter render them identically. Pure maths.
//
// Geometry is built in a local frame where the tip sits at (0,0) and the line
// arrives from +a (behind the tip); `b` is the lateral offset. The frame is then
// rotated so the head points along `angleDeg` (the direction of travel INTO the
// endpoint, as Route.startAngle / Route.endAngle report it).
//
// Each piece says how to fill it:
//   'stroke'     — filled with the line colour (solid heads)
//   'none'       — outline only (open V, bars, crow's feet)
//   'background' — filled with the canvas background (hollow heads hide the line)
// Every piece is also stroked with the line colour.

import type { MapArrowHead } from '../types'
import type { Pt } from './geom'

export type ArrowFill = 'stroke' | 'none' | 'background'

export interface ArrowPiece {
  d: string
  fill: ArrowFill
}

export const ARROW_HEADS: MapArrowHead[] = [
  'none',
  'arrow',
  'open',
  'triangle',
  'diamond',
  'diamondOpen',
  'circle',
  'circleOpen',
  'bar',
  'crowOne',
  'crowMany',
  'crowOneOrMany',
  'crowZeroOrOne',
  'crowZeroOrMany'
]

const fmt = (n: number): string => {
  const v = Math.round(n * 100) / 100
  return (Object.is(v, -0) ? 0 : v).toString()
}

export function arrowHeadPath(kind: MapArrowHead, tip: Pt, angleDeg: number, size: number): ArrowPiece[] {
  const s = Number.isFinite(size) && size > 0 ? size : 10
  const rad = ((Number.isFinite(angleDeg) ? angleDeg : 0) * Math.PI) / 180
  const ux = Math.cos(rad)
  const uy = Math.sin(rad)
  // a: distance back from the tip along the line, b: lateral offset.
  const P = (a: number, b: number): string => `${fmt(tip.x - a * ux - b * uy)},${fmt(tip.y - a * uy + b * ux)}`
  const polygon = (pts: [number, number][]): string => `M${pts.map(([a, b]) => P(a, b)).join(' L')} Z`
  const polyline = (pts: [number, number][]): string => `M${pts.map(([a, b]) => P(a, b)).join(' L')}`
  const circle = (a: number, r: number): string => `M${P(a - r, 0)} A${fmt(r)},${fmt(r)} 0 1 0 ${P(a + r, 0)} A${fmt(r)},${fmt(r)} 0 1 0 ${P(a - r, 0)} Z`
  const bar = (a: number, half: number): string => `M${P(a, -half)} L${P(a, half)}`
  const w = s * 0.45 // half width of triangles
  const crow = (junction: number): string =>
    `${polyline([[0, -s * 0.5], [junction, 0], [0, s * 0.5]])} ${polyline([[junction, 0], [0, 0]])}`

  switch (kind) {
    case 'none':
      return []
    case 'arrow':
      return [{ d: polygon([[0, 0], [s, -w], [s, w]]), fill: 'stroke' }]
    case 'open':
      return [{ d: polyline([[s, -w], [0, 0], [s, w]]), fill: 'none' }]
    case 'triangle':
      return [{ d: polygon([[0, 0], [s, -w], [s, w]]), fill: 'background' }]
    case 'diamond':
      return [{ d: polygon([[0, 0], [s * 0.6, -s * 0.35], [s * 1.2, 0], [s * 0.6, s * 0.35]]), fill: 'stroke' }]
    case 'diamondOpen':
      return [{ d: polygon([[0, 0], [s * 0.6, -s * 0.35], [s * 1.2, 0], [s * 0.6, s * 0.35]]), fill: 'background' }]
    case 'circle':
      return [{ d: circle(s * 0.4, s * 0.4), fill: 'stroke' }]
    case 'circleOpen':
      return [{ d: circle(s * 0.4, s * 0.4), fill: 'background' }]
    case 'bar':
      return [{ d: bar(s * 0.25, s * 0.5), fill: 'none' }]
    case 'crowOne':
      return [{ d: `${bar(s * 0.35, s * 0.5)} ${bar(s * 0.7, s * 0.5)}`, fill: 'none' }]
    case 'crowMany':
      return [{ d: crow(s), fill: 'none' }]
    case 'crowOneOrMany':
      return [{ d: `${crow(s)} ${bar(s * 1.3, s * 0.5)}`, fill: 'none' }]
    case 'crowZeroOrOne':
      return [
        { d: bar(s * 0.35, s * 0.5), fill: 'none' },
        { d: circle(s * 1.05, s * 0.3), fill: 'background' }
      ]
    case 'crowZeroOrMany':
      return [
        { d: crow(s), fill: 'none' },
        { d: circle(s * 1.5, s * 0.3), fill: 'background' }
      ]
    default:
      return []
  }
}

// How far to pull the line back from the endpoint so it ends inside the head's
// base instead of poking through a filled or hollow head. Marks drawn across
// the line (open V, bars, crow's feet) need no inset; hollow circles on crow
// variants are background-filled and cover the line themselves.
export function arrowInset(kind: MapArrowHead, size: number): number {
  const s = Number.isFinite(size) && size > 0 ? size : 10
  switch (kind) {
    case 'arrow':
      return s * 0.8
    case 'triangle':
      return s
    case 'diamond':
      return s * 1.1
    case 'diamondOpen':
      return s * 1.2
    case 'circle':
      return s * 0.7
    case 'circleOpen':
      return s * 0.8
    default:
      return 0
  }
}
