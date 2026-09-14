// The path for a sparkline, and the arithmetic under a stat card.
//
// Pure, so the shape of the line can be tested without a DOM. The interesting
// cases are the degenerate ones: one point, every point identical, and a series
// that is all zeroes. Each of those divides by a range of nothing, and each is
// a real series somebody will have on their first day.

export interface Series {
  points: number[]
}

/** An SVG path through the series, fitted to a box. */
export function sparklinePath(points: readonly number[], width: number, height: number, pad = 2): string {
  if (points.length === 0) return ''
  const w = Math.max(1, width - pad * 2)
  const h = Math.max(1, height - pad * 2)
  if (points.length === 1) {
    // One reading is a flat line across the middle, not a dot in the corner.
    const y = pad + h / 2
    return `M ${pad} ${y} L ${pad + w} ${y}`
  }
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min
  const step = w / (points.length - 1)
  return points
    .map((p, i) => {
      // A flat series sits in the middle rather than pinned to the bottom,
      // which is where dividing by a zero range would otherwise put it.
      const t = range === 0 ? 0.5 : (p - min) / range
      const x = pad + i * step
      const y = pad + h - t * h
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}

export interface Delta {
  /** Change from the first reading to the last, as a percentage. */
  pct: number
  direction: 'up' | 'down' | 'flat'
}

/** How the series has moved, end to end. */
export function delta(points: readonly number[]): Delta | null {
  if (points.length < 2) return null
  const first = points[0]
  const last = points[points.length - 1]
  if (first === 0) {
    // No honest percentage exists from a base of zero. Report the direction and
    // let the caller show the direction without inventing a number.
    return { pct: 0, direction: last === 0 ? 'flat' : last > 0 ? 'up' : 'down' }
  }
  const pct = ((last - first) / Math.abs(first)) * 100
  return { pct, direction: Math.abs(pct) < 0.05 ? 'flat' : pct > 0 ? 'up' : 'down' }
}

/** "1.2k", "5.2M" — a number that has to fit in a card. */
export function compact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B'
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (abs >= 10_000) return Math.round(n / 1000) + 'k'
  if (abs >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(Math.round(n * 100) / 100)
}
