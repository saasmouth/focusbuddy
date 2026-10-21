// Style resolution and themes for PlexiDiagrams. A shape's look is the theme's
// defaults, overridden by the shape's colour, its registry defaults, its own
// style, and finally any matching data rule. Edges resolve the same way. Both
// the editor and the export call these, so a style never renders two ways.

import type { MapArrowHead, MapEdge, MapNode, MapNodeStyle, MapStrokeDash } from '../types'
import { getShape } from './shapes'

export interface ResolvedNodeStyle {
  fill: string
  fillOpacity: number
  stroke: string
  strokeWidth: number
  strokeDash: MapStrokeDash
  radius?: number
  opacity: number
  shadow: boolean
  fontFamily: string
  fontSize: number
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  textColor: string
  textAlign: 'left' | 'center' | 'right'
  vAlign: 'top' | 'middle' | 'bottom'
}

export interface ResolvedEdgeStyle {
  stroke: string
  strokeWidth: number
  dash: MapStrokeDash
  startArrow: MapArrowHead
  endArrow: MapArrowHead
  fontSize: number
  textColor: string
}

export interface DiagramTheme {
  id: string
  name: string
  background: string
  // 'tint': fill is the shape colour at fillOpacity; otherwise a fixed fill.
  fillMode: 'tint' | 'fixed'
  fill: string
  fillOpacity: number
  strokeMode: 'shape' | 'fixed' // 'shape' = use the node's colour
  stroke: string
  strokeWidth: number
  textColor: string
  fontFamily: string
  fontSize: number
  line: string
  lineWidth: number
  grid: string
  palette: string[] // swatches offered in the colour pickers
}

const SYSTEM_FONT = 'Inter, -apple-system, "Segoe UI", system-ui, sans-serif'

export const THEMES: DiagramTheme[] = [
  {
    id: 'plexii',
    name: 'Plexii',
    background: '#ffffff',
    fillMode: 'tint',
    fill: '#ffffff',
    fillOpacity: 0.12,
    strokeMode: 'shape',
    stroke: '#2563eb',
    strokeWidth: 2,
    textColor: '#1c1917',
    fontFamily: SYSTEM_FONT,
    fontSize: 12,
    line: '#64748b',
    lineWidth: 1.5,
    grid: '#e7e5e4',
    palette: ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#475569', '#db2777', '#65a30d', '#0f172a']
  },
  {
    id: 'classic',
    name: 'Classic',
    background: '#ffffff',
    fillMode: 'fixed',
    fill: '#ffffff',
    fillOpacity: 1,
    strokeMode: 'fixed',
    stroke: '#1f2937',
    strokeWidth: 1.5,
    textColor: '#111827',
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontSize: 12,
    line: '#1f2937',
    lineWidth: 1.25,
    grid: '#e5e7eb',
    palette: ['#1f2937', '#6b7280', '#2563eb', '#16a34a', '#dc2626', '#f59e0b', '#ffffff', '#f3f4f6']
  },
  {
    id: 'pastel',
    name: 'Pastel',
    background: '#fffdf8',
    fillMode: 'tint',
    fill: '#ffffff',
    fillOpacity: 0.28,
    strokeMode: 'shape',
    stroke: '#94a3b8',
    strokeWidth: 1.5,
    textColor: '#334155',
    fontFamily: SYSTEM_FONT,
    fontSize: 12,
    line: '#94a3b8',
    lineWidth: 1.5,
    grid: '#f1ece2',
    palette: ['#93c5fd', '#86efac', '#fcd34d', '#fca5a5', '#c4b5fd', '#67e8f9', '#f9a8d4', '#cbd5e1']
  },
  {
    id: 'vivid',
    name: 'Vivid',
    background: '#ffffff',
    fillMode: 'tint',
    fill: '#ffffff',
    fillOpacity: 0.9,
    strokeMode: 'shape',
    stroke: '#2563eb',
    strokeWidth: 0,
    textColor: '#ffffff',
    fontFamily: SYSTEM_FONT,
    fontSize: 12,
    line: '#334155',
    lineWidth: 2,
    grid: '#e7e5e4',
    palette: ['#2563eb', '#16a34a', '#ea580c', '#dc2626', '#9333ea', '#0891b2', '#db2777', '#0f172a']
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    background: '#0b3a6b',
    fillMode: 'fixed',
    fill: '#0b3a6b',
    fillOpacity: 1,
    strokeMode: 'fixed',
    stroke: '#e0f2fe',
    strokeWidth: 1.5,
    textColor: '#e0f2fe',
    fontFamily: '"SF Mono", Menlo, Consolas, monospace',
    fontSize: 12,
    line: '#bae6fd',
    lineWidth: 1.25,
    grid: '#13497f',
    palette: ['#e0f2fe', '#7dd3fc', '#fde68a', '#fca5a5', '#86efac', '#c4b5fd']
  },
  {
    id: 'dark',
    name: 'Dark',
    background: '#16171c',
    fillMode: 'tint',
    fill: '#16171c',
    fillOpacity: 0.22,
    strokeMode: 'shape',
    stroke: '#60a5fa',
    strokeWidth: 2,
    textColor: '#ecebf3',
    fontFamily: SYSTEM_FONT,
    fontSize: 12,
    line: '#a3a2b0',
    lineWidth: 1.5,
    grid: '#2a2b33',
    palette: ['#60a5fa', '#4ade80', '#fbbf24', '#f87171', '#a78bfa', '#22d3ee', '#f472b6', '#e5e7eb']
  },
  {
    id: 'mono',
    name: 'Monochrome',
    background: '#ffffff',
    fillMode: 'fixed',
    fill: '#f5f5f4',
    fillOpacity: 1,
    strokeMode: 'fixed',
    stroke: '#44403c',
    strokeWidth: 1.5,
    textColor: '#1c1917',
    fontFamily: SYSTEM_FONT,
    fontSize: 12,
    line: '#57534e',
    lineWidth: 1.5,
    grid: '#e7e5e4',
    palette: ['#1c1917', '#44403c', '#78716c', '#a8a29e', '#d6d3d1', '#f5f5f4', '#ffffff']
  }
]

export function getTheme(id: string | undefined): DiagramTheme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!
}

// Apply style overrides on top of a resolved style, ignoring absent keys.
function overlay(base: ResolvedNodeStyle, s: Partial<MapNodeStyle> | undefined): ResolvedNodeStyle {
  if (!s) return base
  const out = { ...base }
  for (const [k, v] of Object.entries(s)) if (v !== undefined) (out as Record<string, unknown>)[k] = v
  return out
}

export function resolveNodeStyle(
  node: Pick<MapNode, 'shape' | 'color' | 'style'>,
  themeId?: string,
  rule?: { fill?: string; stroke?: string; textColor?: string }
): ResolvedNodeStyle {
  const t = getTheme(themeId)
  const def = getShape(node.shape)
  const color = node.color || def.color || t.stroke
  let base: ResolvedNodeStyle = {
    fill: t.fillMode === 'tint' ? color : t.fill,
    fillOpacity: t.fillMode === 'tint' ? t.fillOpacity : t.fillOpacity,
    stroke: t.strokeMode === 'shape' ? color : t.stroke,
    strokeWidth: t.strokeWidth,
    strokeDash: 'solid',
    opacity: 1,
    shadow: false,
    fontFamily: t.fontFamily,
    fontSize: t.fontSize,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    textColor: t.textColor,
    textAlign: 'center',
    vAlign: 'middle'
  }
  // The original rectangle was white with a coloured border; keep that look.
  if (t.id === 'plexii' && node.shape === 'process') base = { ...base, fill: '#ffffff', fillOpacity: 1 }
  // Free text has no box; containers get a fainter tint so content reads on top.
  if (def.special === 'text') base = { ...base, fill: 'none', stroke: 'none', strokeWidth: 0, textColor: t.id === 'plexii' ? color : t.textColor }
  if (def.container && t.fillMode === 'tint') base = { ...base, fillOpacity: Math.min(base.fillOpacity, 0.05) }
  if (def.special === 'sticky') base = { ...base, textColor: '#1c1917' }
  base = overlay(base, def.defaultStyle)
  base = overlay(base, node.style)
  if (rule) {
    if (rule.fill) base = { ...base, fill: rule.fill, fillOpacity: Math.max(base.fillOpacity, 0.85) }
    if (rule.stroke) base = { ...base, stroke: rule.stroke }
    if (rule.textColor) base = { ...base, textColor: rule.textColor }
  }
  return base
}

export function resolveEdgeStyle(edge: MapEdge, themeId?: string, defaultEndArrow: MapArrowHead = 'arrow'): ResolvedEdgeStyle {
  const t = getTheme(themeId)
  return {
    stroke: edge.stroke || t.line,
    strokeWidth: edge.strokeWidth ?? t.lineWidth,
    dash: edge.dash ?? (edge.style === 'dashed' ? 'dashed' : 'solid'),
    // `arrow` is the older both/none/end switch, honoured when no explicit head is set.
    startArrow: edge.startArrow ?? (edge.arrow === 'both' ? 'arrow' : 'none'),
    endArrow: edge.endArrow ?? (edge.arrow === 'none' ? 'none' : defaultEndArrow),
    fontSize: edge.fontSize ?? 11,
    textColor: edge.textColor || (t.id === 'blueprint' || t.id === 'dark' ? t.textColor : '#334155')
  }
}

// SVG stroke-dasharray for a dash style at a stroke width.
export function dashArray(dash: MapStrokeDash, width: number): string | undefined {
  const w = Math.max(1, width)
  switch (dash) {
    case 'dashed':
      return `${6 * w} ${4 * w}`
    case 'dotted':
      return `${w} ${2.5 * w}`
    case 'dashdot':
      return `${7 * w} ${3 * w} ${w} ${3 * w}`
    default:
      return undefined
  }
}

// Readable text colour (black or white) for a background colour.
export function contrastText(bg: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg.trim())
  if (!m) return '#1c1917'
  const n = parseInt(m[1]!, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1c1917' : '#ffffff'
}
