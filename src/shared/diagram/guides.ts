// Smart alignment guides for dragging in PlexiDiagrams: while a shape (or a
// selection) moves, find other shapes whose edges or centres line up within a
// threshold, snap to them, and report the guide lines to draw. Also detects
// equal spacing between neighbours (the Lucid "equal gap" hint). Pure.

import type { Box } from './geom'

export interface GuideLine {
  axis: 'x' | 'y' // 'x' = vertical line at x; 'y' = horizontal line at y
  pos: number
  from: number // extent along the other axis
  to: number
  kind: 'edge' | 'center' | 'gap'
}

export interface SnapResult {
  dx: number // correction to apply to the moving box
  dy: number
  guides: GuideLine[]
}

const xs = (b: Box): number[] => [b.x, b.x + b.w / 2, b.x + b.w]
const ys = (b: Box): number[] => [b.y, b.y + b.h / 2, b.y + b.h]

export function snapToGuides(moving: Box, others: Box[], threshold: number): SnapResult {
  let bestX: { d: number; target: number; src: number; kind: GuideLine['kind'] } | null = null
  let bestY: { d: number; target: number; src: number; kind: GuideLine['kind'] } | null = null
  const mx = xs(moving)
  const my = ys(moving)
  for (const o of others) {
    const ox = xs(o)
    const oy = ys(o)
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const d = ox[j]! - mx[i]!
        if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, target: ox[j]!, src: i, kind: i === 1 && j === 1 ? 'center' : 'edge' }
        const e = oy[j]! - my[i]!
        if (Math.abs(e) <= threshold && (!bestY || Math.abs(e) < Math.abs(bestY.d))) bestY = { d: e, target: oy[j]!, src: i, kind: i === 1 && j === 1 ? 'center' : 'edge' }
      }
  }
  // Equal spacing: if the moving box sits between two neighbours on a row,
  // snap so both gaps match (only when no edge snap is closer).
  const gap = equalGap(moving, others, threshold)
  if (gap.dx !== undefined && (!bestX || Math.abs(gap.dx) < Math.abs(bestX.d))) bestX = { d: gap.dx, target: NaN, src: -1, kind: 'gap' }
  if (gap.dy !== undefined && (!bestY || Math.abs(gap.dy) < Math.abs(bestY.d))) bestY = { d: gap.dy, target: NaN, src: -1, kind: 'gap' }

  const dx = bestX?.d ?? 0
  const dy = bestY?.d ?? 0
  const snapped: Box = { ...moving, x: moving.x + dx, y: moving.y + dy }
  const guides: GuideLine[] = []
  if (bestX && bestX.kind !== 'gap') {
    const pos = bestX.target
    const aligned = others.filter((o) => xs(o).some((v) => Math.abs(v - pos) < 0.5))
    const all = [snapped, ...aligned]
    guides.push({ axis: 'x', pos, from: Math.min(...all.map((b) => b.y)) - 8, to: Math.max(...all.map((b) => b.y + b.h)) + 8, kind: bestX.kind })
  }
  if (bestY && bestY.kind !== 'gap') {
    const pos = bestY.target
    const aligned = others.filter((o) => ys(o).some((v) => Math.abs(v - pos) < 0.5))
    const all = [snapped, ...aligned]
    guides.push({ axis: 'y', pos, from: Math.min(...all.map((b) => b.x)) - 8, to: Math.max(...all.map((b) => b.x + b.w)) + 8, kind: bestY.kind })
  }
  guides.push(...gap.lines.map((l) => (l.axis === 'x' ? { ...l, pos: l.pos + dx } : { ...l, pos: l.pos + dy })))
  return { dx, dy, guides }
}

function equalGap(m: Box, others: Box[], threshold: number): { dx?: number; dy?: number; lines: GuideLine[] } {
  const lines: GuideLine[] = []
  let dx: number | undefined
  let dy: number | undefined
  // Horizontal neighbours overlapping vertically.
  const row = others.filter((o) => o.y < m.y + m.h && o.y + o.h > m.y)
  const left = row.filter((o) => o.x + o.w <= m.x).sort((a, b) => b.x + b.w - (a.x + a.w))[0]
  const right = row.filter((o) => o.x >= m.x + m.w).sort((a, b) => a.x - b.x)[0]
  if (left && right) {
    const target = (left.x + left.w + right.x - m.w) / 2
    const d = target - m.x
    if (Math.abs(d) <= threshold) {
      dx = d
      const y = Math.max(left.y, right.y, m.y) + 4
      lines.push({ axis: 'y', pos: y, from: left.x + left.w, to: m.x, kind: 'gap' }, { axis: 'y', pos: y, from: m.x + m.w, to: right.x, kind: 'gap' })
    }
  }
  const col = others.filter((o) => o.x < m.x + m.w && o.x + o.w > m.x)
  const above = col.filter((o) => o.y + o.h <= m.y).sort((a, b) => b.y + b.h - (a.y + a.h))[0]
  const below = col.filter((o) => o.y >= m.y + m.h).sort((a, b) => a.y - b.y)[0]
  if (above && below) {
    const target = (above.y + above.h + below.y - m.h) / 2
    const d = target - m.y
    if (Math.abs(d) <= threshold) {
      dy = d
      const x = Math.max(above.x, below.x, m.x) + 4
      lines.push({ axis: 'x', pos: x, from: above.y + above.h, to: m.y, kind: 'gap' }, { axis: 'x', pos: x, from: m.y + m.h, to: below.y, kind: 'gap' })
    }
  }
  return { dx, dy, lines }
}

export function snapToGrid(v: number, grid: number): number {
  return grid > 0 ? Math.round(v / grid) * grid : v
}
