// Pure renderer that turns a portable MapBody into a standalone SVG string. Kept
// free of React Flow and Electron so it runs in the renderer, in the main-process
// export path, and in unit tests. The SVG is the source of truth for every Draw
// export format: it is written directly for .svg, and rasterised / printed for
// PNG / JPG / PDF. No fabrication: an empty map exports an honest empty canvas.

import type { MapBody, MapNode, MapEdge, MapShape } from './types'

// Shared fractional (0..1) polygon outlines for the polygon-based stencil shapes,
// so the editor (as a CSS clip-path) and the export (as SVG points) draw exactly
// the same outline from one definition.
export const POLYGON_POINTS: Partial<Record<MapShape, [number, number][]>> = {
  hexagon: [
    [0.25, 0],
    [0.75, 0],
    [1, 0.5],
    [0.75, 1],
    [0.25, 1],
    [0, 0.5]
  ],
  trapezoid: [
    [0.2, 0],
    [0.8, 0],
    [1, 1],
    [0, 1]
  ],
  chevron: [
    [0, 0],
    [0.75, 0],
    [1, 0.5],
    [0.75, 1],
    [0, 1],
    [0.25, 0.5]
  ],
  triangle: [
    [0.5, 0],
    [1, 1],
    [0, 1]
  ],
  pentagon: [
    [0.5, 0],
    [1, 0.38],
    [0.82, 1],
    [0.18, 1],
    [0, 0.38]
  ],
  // Five-point star: outer radius 0.5, inner 0.2, from a fixed unit circle so the
  // editor clip-path and the SVG export draw the identical outline.
  star: [
    [0.5, 0],
    [0.618, 0.338],
    [0.976, 0.345],
    [0.69, 0.562],
    [0.794, 0.905],
    [0.5, 0.7],
    [0.206, 0.905],
    [0.31, 0.562],
    [0.024, 0.345],
    [0.382, 0.338]
  ],
  cross: [
    [0.33, 0],
    [0.67, 0],
    [0.67, 0.33],
    [1, 0.33],
    [1, 0.67],
    [0.67, 0.67],
    [0.67, 1],
    [0.33, 1],
    [0.33, 0.67],
    [0, 0.67],
    [0, 0.33],
    [0.33, 0.33]
  ],
  arrow: [
    [0, 0.3],
    [0.6, 0.3],
    [0.6, 0.1],
    [1, 0.5],
    [0.6, 0.9],
    [0.6, 0.7],
    [0, 0.7]
  ],
  callout: [
    [0, 0],
    [1, 0],
    [1, 0.75],
    [0.35, 0.75],
    [0.2, 1],
    [0.25, 0.75],
    [0, 0.75]
  ]
}

// CSS clip-path polygon() string for a polygon stencil shape (used by the editor).
export function polygonClipPath(shape: MapShape): string | null {
  const pts = POLYGON_POINTS[shape]
  if (!pts) return null
  return `polygon(${pts.map(([px, py]) => `${px * 100}% ${py * 100}%`).join(', ')})`
}

// Default on-screen sizes per shape, matching the editor's node components so an
// export looks like what the user drew. A node's own width/height wins when set.
function nodeSize(n: MapNode): { w: number; h: number } {
  if (typeof n.width === 'number' && typeof n.height === 'number') return { w: n.width, h: n.height }
  switch (n.shape) {
    case 'decision':
      return { w: 130, h: 92 }
    case 'database':
      return { w: 110, h: 64 }
    case 'circle':
      return { w: 86, h: 86 }
    case 'widget':
      return { w: 280, h: 190 }
    case 'terminator':
      return { w: 120, h: 48 }
    case 'data':
      return { w: 132, h: 48 }
    case 'note':
      return { w: 120, h: 48 }
    case 'hexagon':
      return { w: 130, h: 70 }
    case 'trapezoid':
      return { w: 140, h: 60 }
    case 'chevron':
      return { w: 150, h: 52 }
    case 'triangle':
      return { w: 96, h: 84 }
    case 'pentagon':
      return { w: 100, h: 92 }
    case 'star':
      return { w: 96, h: 96 }
    case 'cross':
      return { w: 90, h: 90 }
    case 'arrow':
      return { w: 130, h: 70 }
    case 'callout':
      return { w: 140, h: 84 }
    case 'lane':
      return { w: 680, h: 200 }
    default:
      return { w: 130, h: 48 }
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Greedy word-wrap to fit a pixel width at ~7px/char (13px sans), capped at 3
// lines with an ellipsis so a long label never blows out the shape.
function wrapLabel(label: string, widthPx: number): string[] {
  const max = Math.max(4, Math.floor(widthPx / 7))
  const words = label.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (!cur) cur = w
    else if ((cur + ' ' + w).length <= max) cur += ' ' + w
    else {
      lines.push(cur)
      cur = w
    }
  }
  if (cur) lines.push(cur)
  if (lines.length > 3) {
    lines.length = 3
    lines[2] = lines[2].slice(0, Math.max(0, max - 1)) + '…'
  }
  return lines.length ? lines : ['']
}

function centeredText(cx: number, cy: number, lines: string[], color: string): string {
  const lh = 15
  const startY = cy - ((lines.length - 1) * lh) / 2
  return lines
    .map(
      (ln, i) =>
        `<text x="${cx}" y="${startY + i * lh}" font-family="Inter, system-ui, sans-serif" font-size="13" fill="${color}" text-anchor="middle" dominant-baseline="central">${esc(ln)}</text>`
    )
    .join('')
}

function shapeSvg(n: MapNode): string {
  const { w, h } = nodeSize(n)
  const x = n.x
  const y = n.y
  const cx = x + w / 2
  const cy = y + h / 2
  const stroke = n.color || '#2563eb'
  const fill = stroke
  const common = `fill="${fill}" fill-opacity="0.12" stroke="${stroke}" stroke-width="2"`
  const ink = '#1c1917'
  let body = ''
  // Polygon stencil shapes share one outline definition (hexagon/trapezoid/chevron).
  const poly = POLYGON_POINTS[n.shape]
  if (poly) {
    const pts = poly.map(([px, py]) => `${(x + px * w).toFixed(1)},${(y + py * h).toFixed(1)}`).join(' ')
    const label = centeredText(cx, cy, wrapLabel(n.label || '', w - 12), ink)
    return `<polygon points="${pts}" ${common} />${label}`
  }
  switch (n.shape) {
    case 'decision':
      body = `<polygon points="${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}" ${common} />`
      break
    case 'terminator':
      body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" ry="${h / 2}" ${common} />`
      break
    case 'data':
      body = `<polygon points="${x + w * 0.16},${y} ${x + w},${y} ${x + w * 0.84},${y + h} ${x},${y + h}" ${common} />`
      break
    case 'database': {
      const ry = Math.min(10, h * 0.16)
      body =
        `<path d="M ${x} ${y + ry} A ${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry} L ${x + w} ${y + h - ry} A ${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry} Z" ${common} />` +
        `<ellipse cx="${cx}" cy="${y + ry}" rx="${w / 2}" ry="${ry}" fill="${fill}" fill-opacity="0.18" stroke="${stroke}" stroke-width="2" />`
      break
    }
    case 'circle':
      body = `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" ${common} />`
      break
    case 'note':
      body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" ry="6" fill="#fff" stroke="${stroke}" stroke-width="2" stroke-dasharray="4 3" />`
      break
    case 'lane': {
      const band = 26
      body =
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" ry="6" fill="${fill}" fill-opacity="0.05" stroke="${stroke}" stroke-opacity="0.4" stroke-width="2" />` +
        `<rect x="${x}" y="${y}" width="${band}" height="${h}" fill="${fill}" fill-opacity="0.15" />` +
        `<text x="${x + band / 2}" y="${cy}" font-family="Inter, system-ui, sans-serif" font-size="12" font-weight="600" fill="${ink}" text-anchor="middle" transform="rotate(-90 ${x + band / 2} ${cy})">${esc(n.label || '')}</text>`
      break
    }
    case 'widget':
      body =
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" ry="10" fill="#fff" stroke="${stroke}" stroke-width="2" />` +
        `<rect x="${x}" y="${y}" width="${w}" height="26" rx="10" ry="10" fill="${fill}" fill-opacity="0.16" />` +
        `<text x="${x + 10}" y="${y + 13}" font-family="Inter, system-ui, sans-serif" font-size="10" fill="${stroke}" dominant-baseline="central">live work widget</text>`
      break
    default: // process
      body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" ry="8" ${common} />`
  }
  const label = n.shape === 'widget' || n.shape === 'lane' ? '' : centeredText(cx, cy, wrapLabel(n.label || '', w - 12), ink)
  return body + label
}

// Where the straight line from (x1,y1) toward (x2,y2) crosses the rectangle
// centred on (x2,y2), so an arrow lands on the border of the target box instead
// of at its centre. Returns the target centre if the two points coincide.
function borderPoint(fromX: number, fromY: number, box: { cx: number; cy: number; w: number; h: number }): { x: number; y: number } {
  const dx = box.cx - fromX
  const dy = box.cy - fromY
  if (dx === 0 && dy === 0) return { x: box.cx, y: box.cy }
  const hw = box.w / 2
  const hh = box.h / 2
  const scale = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh)
  return { x: box.cx - dx * scale, y: box.cy - dy * scale }
}

function edgeSvg(e: MapEdge, byId: Map<string, { cx: number; cy: number; w: number; h: number }>): string {
  const a = byId.get(e.source)
  const b = byId.get(e.target)
  if (!a || !b) return ''
  const start = borderPoint(b.cx, b.cy, a)
  const end = borderPoint(a.cx, a.cy, b)
  const dash = e.style === 'dashed' ? ' stroke-dasharray="6 4"' : ''
  const line = `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="#64748b" stroke-width="2"${dash} marker-end="url(#arrow)" />`
  let label = ''
  if (e.label) {
    const mx = (start.x + end.x) / 2
    const my = (start.y + end.y) / 2
    const wpx = e.label.length * 7 + 8
    label =
      `<rect x="${mx - wpx / 2}" y="${my - 9}" width="${wpx}" height="18" rx="3" fill="#fff" fill-opacity="0.9" />` +
      `<text x="${mx}" y="${my}" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#334155" text-anchor="middle" dominant-baseline="central">${esc(e.label)}</text>`
  }
  return line + label
}

export interface MapSvgResult {
  svg: string
  width: number
  height: number
}

export function mapToSvg(body: MapBody, opts: { padding?: number; background?: string } = {}): MapSvgResult {
  const pad = opts.padding ?? 48
  const bg = opts.background ?? '#ffffff'
  const nodes = body.nodes ?? []
  const edges = body.edges ?? []

  // Bounding box over all node boxes; an empty map gets a small honest canvas.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const boxes = new Map<string, { cx: number; cy: number; w: number; h: number }>()
  for (const n of nodes) {
    const { w, h } = nodeSize(n)
    boxes.set(n.id, { cx: n.x + w / 2, cy: n.y + h / 2, w, h })
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + w)
    maxY = Math.max(maxY, n.y + h)
  }
  if (!nodes.length) {
    minX = 0
    minY = 0
    maxX = 320
    maxY = 180
  }
  const width = Math.max(1, Math.round(maxX - minX + pad * 2))
  const height = Math.max(1, Math.round(maxY - minY + pad * 2))
  const tx = pad - minX
  const ty = pad - minY

  // Edges first so nodes paint on top of connector ends.
  const edgeLayer = edges.map((e) => edgeSvg(e, boxes)).join('')
  // Lanes are containers, so paint them first (behind the other shapes).
  const ordered = nodes.slice().sort((a, b) => (a.shape === 'lane' ? 0 : 1) - (b.shape === 'lane' ? 0 : 1))
  const nodeLayer = ordered.map((n) => shapeSvg(n)).join('')

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" /></marker></defs>` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${bg}" />` +
    `<g transform="translate(${tx} ${ty})">${edgeLayer}${nodeLayer}</g>` +
    `</svg>`
  return { svg, width, height }
}
