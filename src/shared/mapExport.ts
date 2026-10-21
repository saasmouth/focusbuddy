// Pure renderer that turns a portable MapBody into a standalone SVG string. Kept
// free of React Flow and Electron so it runs in the renderer, in the main-process
// export path, and in unit tests. The SVG is the source of truth for every
// diagram export format: it is written directly for .svg, and rasterised /
// printed for PNG / JPG / PDF. No fabrication: an empty map exports an honest
// empty canvas.
//
// It draws from the same sources as the editor canvas — the shape registry's
// geometry, the style resolver, the connector router and the arrowheads — so an
// export looks like what was on screen (routed lines, styles, themes, rotation).

import type { MapBody, MapNode, MapEdge, MapShape } from './types'
import { getShape } from './diagram/shapes'
import { nodeSize } from './diagram/geom'
import { routeAll, type Route } from './diagram/routing'
import { arrowHeadPath } from './diagram/arrowheads'
import { dashArray, getTheme, resolveEdgeStyle, resolveNodeStyle, type ResolvedNodeStyle } from './diagram/style'

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

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Greedy word-wrap by an estimated glyph width (0.56em), honouring explicit
// line breaks, capped to what fits in the box height with an ellipsis.
export function wrapText(label: string, widthPx: number, fontSize: number, maxLines: number): string[] {
  // 0.52em is a typical average advance for Inter/Arial body text.
  const max = Math.max(3, Math.floor(widthPx / (fontSize * 0.52)))
  const out: string[] = []
  for (const para of label.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) {
      out.push('')
      continue
    }
    let cur = ''
    for (const w of words) {
      if (!cur) cur = w
      else if ((cur + ' ' + w).length <= max) cur += ' ' + w
      else {
        out.push(cur)
        cur = w
      }
      while (cur.length > max) {
        out.push(cur.slice(0, max))
        cur = cur.slice(max)
      }
    }
    if (cur) out.push(cur)
  }
  if (out.length > maxLines) {
    out.length = Math.max(1, maxLines)
    const last = out[out.length - 1] ?? ''
    out[out.length - 1] = last.slice(0, Math.max(0, max - 1)) + '…'
  }
  return out
}

function textBlock(text: string, rect: { x: number; y: number; w: number; h: number }, st: ResolvedNodeStyle, opts: { vertical?: boolean } = {}): string {
  if (!text) return ''
  const fs = st.fontSize
  const lh = fs * 1.25
  if (opts.vertical) {
    const cx = rect.x + rect.w / 2
    const cy = rect.y + rect.h / 2
    return `<text x="${r(cx)}" y="${r(cy)}" font-family="${esc(st.fontFamily)}" font-size="${fs}" font-weight="600" fill="${st.textColor}" text-anchor="middle" dominant-baseline="central" transform="rotate(-90 ${r(cx)} ${r(cy)})">${esc(text)}</text>`
  }
  const lines = wrapText(text, Math.max(8, rect.w), fs, Math.max(1, Math.floor(rect.h / lh)))
  const total = lines.length * lh
  const y0 = st.vAlign === 'top' ? rect.y + lh / 2 : st.vAlign === 'bottom' ? rect.y + rect.h - total + lh / 2 : rect.y + rect.h / 2 - total / 2 + lh / 2
  const anchor = st.textAlign === 'left' ? 'start' : st.textAlign === 'right' ? 'end' : 'middle'
  const x = st.textAlign === 'left' ? rect.x + 2 : st.textAlign === 'right' ? rect.x + rect.w - 2 : rect.x + rect.w / 2
  const deco = [st.underline ? 'underline' : '', st.strike ? 'line-through' : ''].filter(Boolean).join(' ')
  const attrs = `font-family="${esc(st.fontFamily)}" font-size="${fs}" font-weight="${st.bold ? 700 : 500}"${st.italic ? ' font-style="italic"' : ''}${deco ? ` text-decoration="${deco}"` : ''} fill="${st.textColor}" text-anchor="${anchor}" dominant-baseline="central"`
  return lines.map((ln, i) => `<text x="${r(x)}" y="${r(y0 + i * lh)}" ${attrs}>${esc(ln)}</text>`).join('')
}

const r = (n: number): string => (Math.round(n * 100) / 100).toString()

function paths(n: MapNode, st: ResolvedNodeStyle, w: number, h: number): string {
  const g = getShape(n.shape).draw(w, h)
  const sw = st.strokeDash === 'none' ? 0 : st.strokeWidth
  const dash = dashArray(st.strokeDash, sw)
  const stroke = sw > 0 && st.stroke !== 'none' ? st.stroke : 'none'
  const ink = st.stroke === 'none' ? st.textColor : st.stroke
  const fill = st.fill === 'none' ? 'none' : st.fill
  return g.parts
    .map((p) => {
      switch (p.paint) {
        case 'fill':
          return `<path d="${p.d}" fill="${fill}"${fill === 'none' ? '' : ` fill-opacity="${st.fillOpacity}"`} stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linejoin="round" />`
        case 'stroke':
          return `<path d="${p.d}" fill="none" stroke="${ink}" stroke-width="${Math.max(1, sw * 0.75)}" stroke-linecap="round" stroke-linejoin="round" />`
        case 'shade':
          return `<path d="${p.d}" fill="${ink}" fill-opacity="0.16" stroke="none" />`
        case 'solid':
          return `<path d="${p.d}" fill="${ink}" stroke="none" />`
        default:
          return ''
      }
    })
    .join('')
}

function tableDims(n: MapNode): { rows: number; cols: number } {
  if (n.cells?.length) return { rows: n.cells.length, cols: Math.max(1, ...n.cells.map((x) => x.length)) }
  const m = /(\d+)x(\d+)/.exec(n.shape)
  return m ? { cols: Number(m[1]), rows: Number(m[2]) } : { rows: 3, cols: 3 }
}

function nodeSvg(n: MapNode, themeId: string | undefined): string {
  const def = getShape(n.shape)
  const { w, h } = nodeSize(n)
  const st = resolveNodeStyle(n, themeId)
  const g = def.draw(w, h)
  const rot = n.rotation ? ` rotate(${n.rotation} ${r(w / 2)} ${r(h / 2)})` : ''
  const flip = n.flipX || n.flipY ? `<g transform="translate(${n.flipX ? w : 0} ${n.flipY ? h : 0}) scale(${n.flipX ? -1 : 1} ${n.flipY ? -1 : 1})">` : '<g>'
  let inner = ''
  if (def.special === 'widget') {
    inner =
      `<rect x="0" y="0" width="${w}" height="${h}" rx="10" ry="10" fill="#fff" stroke="${st.stroke}" stroke-width="2" />` +
      `<rect x="0" y="0" width="${w}" height="26" rx="10" ry="10" fill="${st.stroke}" fill-opacity="0.16" />` +
      `<text x="10" y="13" font-family="${esc(st.fontFamily)}" font-size="10" fill="${st.stroke}" dominant-baseline="central">live work widget</text>`
  } else {
    inner = `${flip}${paths(n, st, w, h)}</g>`
  }
  if (def.special === 'image' && n.image) {
    inner += `<image href="${esc(n.image)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" />`
  }
  const icon = n.icon || (def.special === 'icon' ? def.icon : undefined)
  if (icon) {
    const isIconShape = def.special === 'icon'
    const size = isIconShape ? Math.max(14, Math.min(w * 0.7, (g.text.y > h * 0.4 ? g.text.y : h) - 8)) : Math.max(12, Math.min(22, g.text.h * 0.5))
    const cx = isIconShape ? w / 2 : g.text.x + g.text.w / 2
    const cy = isIconShape ? 4 + size / 2 : g.text.y + 2 + size / 2
    inner += `<text x="${r(cx)}" y="${r(cy)}" font-family="'Material Symbols Outlined'" font-size="${r(size)}" fill="${st.stroke === 'none' ? st.textColor : st.stroke}" text-anchor="middle" dominant-baseline="central">${esc(icon)}</text>`
  }
  if (def.special === 'table') {
    const { rows, cols } = tableDims(n)
    const cw = w / cols
    const ch = h / rows
    for (let i = 1; i < cols; i++) inner += `<line x1="${r(i * cw)}" y1="0" x2="${r(i * cw)}" y2="${h}" stroke="${st.stroke}" stroke-width="1" />`
    for (let j = 1; j < rows; j++) inner += `<line x1="0" y1="${r(j * ch)}" x2="${w}" y2="${r(j * ch)}" stroke="${st.stroke}" stroke-width="1" />`
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const t = n.cells?.[j]?.[i]
        if (t) inner += textBlock(t, { x: i * cw + 3, y: j * ch, w: cw - 6, h: ch }, { ...st, bold: st.bold || (/header/.test(n.shape) && j === 0) })
      }
  } else if (def.special === 'umlClass' || def.special === 'erdEntity') {
    const lines = (n.label || '').split('\n')
    const fs = st.fontSize
    const head = fs * 1.9
    inner += textBlock(lines[0] ?? '', { x: 0, y: 0, w, h: head }, { ...st, bold: true, vAlign: 'middle' })
    inner += `<line x1="0" y1="${r(head)}" x2="${w}" y2="${r(head)}" stroke="${st.stroke}" stroke-width="1" />`
    let y = head + 4
    for (const l of lines.slice(1)) {
      if (/^\s*-{2,}\s*$/.test(l)) {
        inner += `<line x1="0" y1="${r(y)}" x2="${w}" y2="${r(y)}" stroke="${st.stroke}" stroke-width="1" />`
        y += 4
        continue
      }
      inner += `<text x="6" y="${r(y + fs * 0.62)}" font-family="${esc(st.fontFamily)}" font-size="${Math.max(9, fs - 1)}" fill="${st.textColor}" dominant-baseline="central">${esc(l)}</text>`
      y += fs * 1.3
      if (y > h) break
    }
  } else if (def.special !== 'widget') {
    const rect = icon && def.special !== 'icon' ? { ...g.text, y: g.text.y + Math.min(26, g.text.h * 0.4), h: Math.max(10, g.text.h - Math.min(26, g.text.h * 0.4)) } : g.text
    inner += textBlock(n.label || '', rect, st, { vertical: def.special === 'lane' })
  }
  const opacity = st.opacity < 1 ? ` opacity="${st.opacity}"` : ''
  const shadow = st.shadow ? ' filter="url(#pd-shadow)"' : ''
  return `<g transform="translate(${r(n.x)} ${r(n.y)})${rot}"${opacity}${shadow}>${inner}</g>`
}

function edgeSvg(e: MapEdge, route: Route, themeId: string | undefined, bg: string, defaultEnd: MapEdge['endArrow']): string {
  const st = resolveEdgeStyle(e, themeId, defaultEnd ?? 'arrow')
  const dash = dashArray(st.dash, st.strokeWidth)
  let out = `<path class="pd-edge" d="${route.path}" fill="none" stroke="${st.stroke}" stroke-width="${st.strokeWidth}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linejoin="round" />`
  const size = 5 + st.strokeWidth * 2.2
  const pts = route.points
  const heads = [
    ...(st.startArrow !== 'none' ? arrowHeadPath(st.startArrow, pts[0]!, route.startAngle, size) : []),
    ...(st.endArrow !== 'none' ? arrowHeadPath(st.endArrow, pts[pts.length - 1]!, route.endAngle, size) : [])
  ]
  for (const hp of heads) {
    const fill = hp.fill === 'stroke' ? st.stroke : hp.fill === 'background' ? bg : 'none'
    out += `<path class="pd-arrowhead" d="${hp.d}" fill="${fill}" stroke="${st.stroke}" stroke-width="${Math.max(1, st.strokeWidth * 0.9)}" stroke-linejoin="round" />`
  }
  if (e.label) {
    const lp = route.labelPoint
    const lines = e.label.split('\n')
    const wpx = Math.max(...lines.map((l) => l.length)) * st.fontSize * 0.56 + 8
    const hpx = lines.length * st.fontSize * 1.25 + 4
    out += `<rect x="${r(lp.x - wpx / 2)}" y="${r(lp.y - hpx / 2)}" width="${r(wpx)}" height="${r(hpx)}" rx="3" fill="${bg}" fill-opacity="0.92" />`
    lines.forEach((l, i) => {
      out += `<text x="${r(lp.x)}" y="${r(lp.y - ((lines.length - 1) * st.fontSize * 1.25) / 2 + i * st.fontSize * 1.25)}" font-family="Inter, system-ui, sans-serif" font-size="${st.fontSize}" fill="${st.textColor}" text-anchor="middle" dominant-baseline="central">${esc(l)}</text>`
    })
  }
  return out
}

export interface MapSvgResult {
  svg: string
  width: number
  height: number
}

export function mapToSvg(
  body: MapBody,
  opts: { padding?: number; background?: string; iconFontUrl?: string } = {}
): MapSvgResult {
  const pad = opts.padding ?? 48
  const settings = body.settings ?? {}
  const themeId = settings.theme
  const theme = getTheme(themeId)
  const bg = opts.background ?? settings.background ?? theme.background
  const hiddenLayers = new Set((body.layers ?? []).filter((l) => !l.visible).map((l) => l.id))
  const nodes = (body.nodes ?? []).filter((n) => !n.hidden && !hiddenLayers.has(n.layerId ?? 'layer-base'))
  const ids = new Set(nodes.map((n) => n.id))
  const edges = (body.edges ?? []).filter((e) => ids.has(e.source) && ids.has(e.target) && !hiddenLayers.has(e.layerId ?? 'layer-base'))
  const routes = routeAll(nodes, edges, { lineJumps: !!settings.lineJumps, defaultRouting: settings.defaultRouting ?? 'orthogonal' })

  // Bounds over shapes (rotated shapes by their rotated corners) and routed lines.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const grow = (x: number, y: number): void => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  for (const n of nodes) {
    const { w, h } = nodeSize(n)
    if (n.rotation) {
      const a = (n.rotation * Math.PI) / 180
      const cx = n.x + w / 2
      const cy = n.y + h / 2
      for (const [dx, dy] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as const) {
        grow(cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a))
      }
    } else {
      grow(n.x, n.y)
      grow(n.x + w, n.y + h)
    }
  }
  for (const rt of routes.values()) for (const p of rt.points) grow(p.x, p.y)
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

  // Lines under shapes (as on the canvas); shapes in z-order (array order).
  const edgeLayer = edges.map((e) => (routes.has(e.id) ? edgeSvg(e, routes.get(e.id)!, themeId, bg, settings.defaultEndArrow) : '')).join('')
  const nodeLayer = nodes.map((n) => nodeSvg(n, themeId)).join('')
  const needsIcons = nodes.some((n) => n.icon || getShape(n.shape).special === 'icon')
  const fontFace = needsIcons && opts.iconFontUrl ? `<style>@font-face{font-family:'Material Symbols Outlined';src:url(${opts.iconFontUrl}) format('woff2');}</style>` : ''

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs>${fontFace}<filter id="pd-shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="2.5" flood-opacity="0.22" /></filter></defs>` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${bg}" />` +
    `<g transform="translate(${r(tx)} ${r(ty)})">${edgeLayer}${nodeLayer}</g>` +
    `</svg>`
  return { svg, width, height }
}
