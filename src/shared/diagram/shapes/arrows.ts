// Block arrows. Every arrow is a single closed silhouette so connectors attach to
// its real edge. Directional variants are generated from one "points right"
// definition by mapping (along, across) coordinates onto the box, so heads keep
// sensible proportions at any aspect ratio. Ids are saved in documents — never
// rename.

import { type Rect, type ShapeDef, fpoly, poly, r } from './types'
import { P, box, fill, fpath, onEllipse, pad, pathShape, shape } from './kit'

const A = 'Arrows' as const

type Dir = 'right' | 'left' | 'up' | 'down'
type Pt = [number, number]

// Length along the arrow / thickness across it, for a direction.
const dims = (w: number, h: number, dir: Dir): [number, number] =>
  dir === 'left' || dir === 'right' ? [w, h] : [h, w]

// Map an (along u, across v) point to box coordinates.
function mapPt(w: number, h: number, dir: Dir, [u, v]: Pt): Pt {
  switch (dir) {
    case 'right':
      return [u, v]
    case 'left':
      return [w - u, v]
    case 'down':
      return [v, u]
    case 'up':
      return [v, h - u]
  }
}

// Map an (along, across) rectangle to a box-space text rect.
function mapRect(w: number, h: number, dir: Dir, u0: number, u1: number, v0: number, v1: number): Rect {
  const a = mapPt(w, h, dir, [u0, v0])
  const b = mapPt(w, h, dir, [u1, v1])
  const x = Math.min(a[0], b[0])
  const y = Math.min(a[1], b[1])
  return box(w, h, x, y, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))
}

function dirPoly(w: number, h: number, dir: Dir, f: (L: number, T: number) => Pt[]): string {
  const [L, T] = dims(w, h, dir)
  return poly(f(L, T).map((p) => mapPt(w, h, dir, p)))
}

// Single-headed block arrow pointing +u.
const blockPts = (L: number, T: number): Pt[] => {
  const hl = Math.min(L * 0.45, T * 0.8)
  return [
    [0, T * 0.3],
    [L - hl, T * 0.3],
    [L - hl, 0],
    [L, T / 2],
    [L - hl, T],
    [L - hl, T * 0.7],
    [0, T * 0.7]
  ]
}
const blockText = (w: number, h: number, dir: Dir): Rect => {
  const [L, T] = dims(w, h, dir)
  const hl = Math.min(L * 0.45, T * 0.8)
  return mapRect(w, h, dir, 4, L - hl * 0.4, T * 0.3, T * 0.7)
}

const doublePts = (L: number, T: number): Pt[] => {
  const hl = Math.min(L * 0.3, T * 0.8)
  return [
    [0, T / 2],
    [hl, 0],
    [hl, T * 0.3],
    [L - hl, T * 0.3],
    [L - hl, 0],
    [L, T / 2],
    [L - hl, T],
    [L - hl, T * 0.7],
    [hl, T * 0.7],
    [hl, T]
  ]
}

// Callout: a text box at the tail with an arrow growing out of it.
const calloutPts = (L: number, T: number): Pt[] => {
  const bx = L * 0.62
  const hl = Math.min((L - bx) * 0.6, T * 0.4)
  return [
    [0, 0],
    [bx, 0],
    [bx, T * 0.36],
    [L - hl, T * 0.36],
    [L - hl, T * 0.2],
    [L, T / 2],
    [L - hl, T * 0.8],
    [L - hl, T * 0.64],
    [bx, T * 0.64],
    [bx, T],
    [0, T]
  ]
}

// Rotate a unit-square point 90° clockwise about the centre.
const rot = ([x, y]: Pt): Pt => [1 - y, x]
function quadSym(quarter: Pt[]): Pt[] {
  const out: Pt[] = []
  let q = quarter
  for (let k = 0; k < 4; k++) {
    out.push(...q)
    q = q.map(rot)
  }
  return out
}

// Map pairs inside a fractional segment list (M/L/C/Q only).
function mapSegs(segs: (string | number)[], fn: (p: Pt) => Pt): (string | number)[] {
  const out: (string | number)[] = []
  let pend: number | null = null
  for (const s of segs) {
    if (typeof s === 'string') {
      out.push(s)
      pend = null
    } else if (pend === null) pend = s
    else {
      out.push(...fn([pend, s]))
      pend = null
    }
  }
  return out
}

const CURVED: (string | number)[] = [
  'M', 0, 1,
  'Q', 0, 0.24, 0.7, 0.22,
  'L', 0.7, 0,
  'L', 1, 0.35,
  'L', 0.7, 0.7,
  'L', 0.7, 0.48,
  'Q', 0.28, 0.5, 0.28, 1,
  'Z'
]
const CURVE_MAP: Record<Dir, (p: Pt) => Pt> = {
  right: (p) => p,
  left: ([x, y]) => [1 - x, y],
  up: ([x, y]) => [y, 1 - x],
  down: ([x, y]) => [1 - y, x]
}

function block(id: string, label: string, dir: Dir, w: number, h: number, keywords: string[]): ShapeDef {
  return shape(id, label, A, w, h, (W, H) => ({ parts: [fill(dirPoly(W, H, dir, blockPts))], text: blockText(W, H, dir) }), {
    keywords
  })
}

function curved(id: string, label: string, dir: Dir, keywords: string[]): ShapeDef {
  const horiz = dir === 'left' || dir === 'right'
  return pathShape(
    id,
    label,
    A,
    horiz ? 120 : 90,
    horiz ? 90 : 120,
    (w, h) => fpath(w, h, ...mapSegs(CURVED, CURVE_MAP[dir])),
    (w, h) => box(w, h, 0, 0, 0, 0),
    { keywords: ['curved', 'curve', 'bend', 'swoosh', ...keywords] }
  )
}

function callout(id: string, label: string, dir: Dir, keywords: string[]): ShapeDef {
  const horiz = dir === 'left' || dir === 'right'
  return shape(
    id,
    label,
    A,
    horiz ? 160 : 110,
    horiz ? 80 : 130,
    (w, h) => {
      const [L, T] = dims(w, h, dir)
      return { parts: [fill(dirPoly(w, h, dir, calloutPts))], text: mapRect(w, h, dir, 4, L * 0.62 - 4, 4, T - 4) }
    },
    { keywords: ['callout', 'arrow callout', 'pointer', ...keywords] }
  )
}

// Circular arrow: a 270° band with a head at its end, as one closed path.
function circularPath(w: number, h: number): string {
  const cx = w / 2
  const cy = h / 2
  const sx = w / 2
  const sy = h / 2
  const rm = 0.36
  const t = 0.09
  const a0 = 150
  const a1 = 420
  const ro = rm + t
  const ri = rm - t
  const q = (rr: number, a: number): string => {
    const [x, y] = onEllipse(cx, cy, sx * rr, sy * rr, a)
    return P(x, y)
  }
  return (
    `M${q(ro, a0)} A${r(sx * ro)},${r(sy * ro)} 0 1 1 ${q(ro, a1)} ` +
    `L${q(rm + 0.14, a1)} L${q(rm, a1 + 32)} L${q(rm - 0.14, a1)} L${q(ri, a1)} ` +
    `A${r(sx * ri)},${r(sy * ri)} 0 1 0 ${q(ri, a0)} Z`
  )
}

export const ARROW_SHAPES: ShapeDef[] = [
  block('arrow-left', 'Left arrow', 'left', 130, 70, ['arrow', 'left', 'back', 'previous', 'west']),
  block('arrow-up', 'Up arrow', 'up', 70, 130, ['arrow', 'up', 'increase', 'north', 'raise']),
  block('arrow-down', 'Down arrow', 'down', 70, 130, ['arrow', 'down', 'decrease', 'south', 'lower']),
  shape(
    'arrow-left-right',
    'Left-right arrow',
    A,
    150,
    64,
    (w, h) => {
      const hl = Math.min(w * 0.3, h * 0.8)
      return { parts: [fill(dirPoly(w, h, 'right', doublePts))], text: pad(w, h, hl * 0.6, h * 0.3) }
    },
    { keywords: ['double arrow', 'both ways', 'bidirectional', 'exchange', 'swap', 'horizontal'] }
  ),
  shape(
    'arrow-up-down',
    'Up-down arrow',
    A,
    64,
    150,
    (w, h) => {
      const hl = Math.min(h * 0.3, w * 0.8)
      return { parts: [fill(dirPoly(w, h, 'down', doublePts))], text: pad(w, h, w * 0.3, hl * 0.6) }
    },
    { keywords: ['double arrow', 'vertical', 'bidirectional', 'scroll'] }
  ),
  pathShape(
    'arrow-quad',
    'Quad arrow',
    A,
    110,
    110,
    (w, h) => {
      const a = 0.08
      const hw = 0.2
      const hl = 0.22
      return fpoly(
        w,
        h,
        quadSym([
          [0.5, 0],
          [0.5 + hw, hl],
          [0.5 + a, hl],
          [0.5 + a, 0.5 - a]
        ])
      )
    },
    (w, h) => box(w, h, 0, 0, 0, 0),
    { keywords: ['four way', 'move', 'cross arrow', 'all directions', 'pan'], aspectLocked: true }
  ),
  shape(
    'arrow-notched-right',
    'Notched right arrow',
    A,
    140,
    70,
    (w, h) => {
      const hl = Math.min(w * 0.45, h * 0.8)
      const nk = Math.min(hl * 0.5, w * 0.15)
      return {
        parts: [
          fill(
            poly([
              [0, h * 0.3],
              [w - hl, h * 0.3],
              [w - hl, 0],
              [w, h / 2],
              [w - hl, h],
              [w - hl, h * 0.7],
              [0, h * 0.7],
              [nk, h / 2]
            ])
          )
        ],
        text: pad(w, h, nk + 4, h * 0.3, hl * 0.4, h * 0.3)
      }
    },
    { keywords: ['arrow', 'notched', 'flow', 'process arrow'] }
  ),
  shape(
    'arrow-striped-right',
    'Striped right arrow',
    A,
    150,
    70,
    (w, h) => {
      const hl = Math.min(w * 0.4, h * 0.8)
      const s = Math.max(1, w * 0.04)
      const x0 = s * 4
      return {
        parts: [
          fill(
            poly([
              [x0, h * 0.3],
              [w - hl, h * 0.3],
              [w - hl, 0],
              [w, h / 2],
              [w - hl, h],
              [w - hl, h * 0.7],
              [x0, h * 0.7]
            ])
          ),
          fill(`M0,${r(h * 0.3)} H${r(s)} V${r(h * 0.7)} H0 Z M${P(s * 2, h * 0.3)} H${r(s * 3)} V${r(h * 0.7)} H${r(s * 2)} Z`)
        ],
        text: pad(w, h, x0 + 4, h * 0.3, hl * 0.4, h * 0.3)
      }
    },
    {
      keywords: ['arrow', 'striped', 'speed', 'fast', 'motion'],
      outline: (w, h) => {
        const hl = Math.min(w * 0.4, h * 0.8)
        return poly([
          [0, h * 0.3],
          [w - hl, h * 0.3],
          [w - hl, 0],
          [w, h / 2],
          [w - hl, h],
          [w - hl, h * 0.7],
          [0, h * 0.7]
        ])
      }
    }
  ),
  pathShape(
    'arrow-u-turn',
    'U-turn arrow',
    A,
    110,
    120,
    (w, h) => {
      const t = w * 0.2
      const e = w * 0.12
      const Ro = (w - e) / 2
      const Ri = Ro - t
      const ryo = Math.min(Ro, h * 0.45)
      const ryi = ryo * (Ri / Ro)
      const headLen = Math.min(h * 0.35, (t + 2 * e) * 0.8)
      const hy = h - headLen
      const xr = 2 * Ro
      return (
        `M0,${r(h)} V${r(ryo)} A${r(Ro)},${r(ryo)} 0 0 1 ${P(xr, ryo)} V${r(hy)} H${r(w)} ` +
        `L${P(xr - t / 2, h)} L${P(xr - t - e, hy)} H${r(xr - t)} V${r(ryo)} ` +
        `A${r(Ri)},${r(ryi)} 0 0 0 ${P(t, ryo)} V${r(h)} Z`
      )
    },
    (w, h) => box(w, h, 0, 0, 0, 0),
    { keywords: ['u turn', 'return', 'back', 'reverse', 'loop back'] }
  ),
  curved('arrow-curved-right', 'Curved right arrow', 'right', ['right', 'turn right']),
  curved('arrow-curved-left', 'Curved left arrow', 'left', ['left', 'turn left']),
  curved('arrow-curved-up', 'Curved up arrow', 'up', ['up', 'turn up']),
  curved('arrow-curved-down', 'Curved down arrow', 'down', ['down', 'turn down']),
  pathShape(
    'arrow-pentagon',
    'Pentagon arrow',
    A,
    150,
    56,
    (w, h) => {
      const k = Math.min(w * 0.3, h * 0.5)
      return poly([[0, 0], [w - k, 0], [w, h / 2], [w - k, h], [0, h]])
    },
    (w, h) => pad(w, h, 6, 4, Math.min(w * 0.3, h * 0.5) * 0.6, 4),
    { keywords: ['homeplate', 'home plate', 'step', 'stage', 'tag', 'signpost', 'timeline'] }
  ),
  pathShape(
    'arrow-pentagon-left',
    'Pentagon arrow (left)',
    A,
    150,
    56,
    (w, h) => {
      const k = Math.min(w * 0.3, h * 0.5)
      return poly([[k, 0], [w, 0], [w, h], [k, h], [0, h / 2]])
    },
    (w, h) => pad(w, h, Math.min(w * 0.3, h * 0.5) * 0.6, 4, 6, 4),
    { keywords: ['homeplate', 'back', 'step', 'tag', 'signpost'] }
  ),
  shape(
    'arrow-chevron-double',
    'Double chevron',
    A,
    120,
    70,
    (w, h) => {
      const k = Math.min(w * 0.22, h * 0.5)
      const g = w * 0.04
      const cw = (w - g) / 2 + k / 2
      const chev = (x: number): string =>
        poly([[x, 0], [x + cw - k, 0], [x + cw, h / 2], [x + cw - k, h], [x, h], [x + k, h / 2]])
      return { parts: [fill(`${chev(0)} ${chev(w - cw)}`)], text: box(w, h, 0, 0, 0, 0) }
    },
    {
      keywords: ['chevron', 'fast forward', 'next', 'skip', 'double arrow'],
      outline: (w, h) => {
        const k = Math.min(w * 0.22, h * 0.5)
        return poly([[0, 0], [w - k, 0], [w, h / 2], [w - k, h], [0, h], [k, h / 2]])
      }
    }
  ),
  pathShape(
    'arrow-chevron-left',
    'Chevron (left)',
    A,
    150,
    52,
    (w, h) => fpoly(w, h, [[0.25, 0], [1, 0], [0.75, 0.5], [1, 1], [0.25, 1], [0, 0.5]]),
    (w, h) => pad(w, h, w * 0.22, 4, w * 0.26, 4),
    { keywords: ['chevron', 'back', 'stage', 'previous', 'step'] }
  ),
  pathShape('arrow-circular', 'Circular arrow', A, 100, 100, circularPath, (w, h) => box(w, h, w * 0.32, h * 0.38, w * 0.36, h * 0.24), {
    keywords: ['refresh', 'cycle', 'loop', 'repeat', 'rotate', 'reload', 'circular'],
    aspectLocked: true
  }),
  callout('arrow-callout-right', 'Right arrow callout', 'right', ['right']),
  callout('arrow-callout-left', 'Left arrow callout', 'left', ['left']),
  callout('arrow-callout-up', 'Up arrow callout', 'up', ['up']),
  callout('arrow-callout-down', 'Down arrow callout', 'down', ['down']),
  shape(
    'arrow-callout-left-right',
    'Left-right arrow callout',
    A,
    200,
    80,
    (w, h) => {
      const b0 = w * 0.22
      const hl = Math.min(b0 * 0.6, h * 0.4)
      return {
        parts: [
          fill(
            poly([
              [0, h / 2],
              [hl, h * 0.2],
              [hl, h * 0.36],
              [b0, h * 0.36],
              [b0, 0],
              [w - b0, 0],
              [w - b0, h * 0.36],
              [w - hl, h * 0.36],
              [w - hl, h * 0.2],
              [w, h / 2],
              [w - hl, h * 0.8],
              [w - hl, h * 0.64],
              [w - b0, h * 0.64],
              [w - b0, h],
              [b0, h],
              [b0, h * 0.64],
              [hl, h * 0.64],
              [hl, h * 0.8]
            ])
          )
        ],
        text: pad(w, h, b0 + 4, 4)
      }
    },
    { keywords: ['callout', 'both ways', 'bidirectional', 'pointer'] }
  ),
  pathShape(
    'arrow-callout-quad',
    'Quad arrow callout',
    A,
    150,
    150,
    (w, h) => {
      const b0 = 0.25
      const a = 0.06
      const hw = 0.12
      const hl = 0.12
      return fpoly(
        w,
        h,
        quadSym([
          [b0, b0],
          [0.5 - a, b0],
          [0.5 - a, hl],
          [0.5 - hw, hl],
          [0.5, 0],
          [0.5 + hw, hl],
          [0.5 + a, hl],
          [0.5 + a, b0]
        ])
      )
    },
    (w, h) => pad(w, h, w * 0.27, h * 0.27),
    { keywords: ['callout', 'four way', 'hub', 'center', 'centre'], aspectLocked: true }
  ),
  pathShape(
    'arrow-bent',
    'Bent arrow',
    A,
    110,
    100,
    (w, h) =>
      fpoly(w, h, [[0, 1], [0, 0.18], [0.7, 0.18], [0.7, 0], [1, 0.3], [0.7, 0.6], [0.7, 0.42], [0.26, 0.42], [0.26, 1]]),
    (w, h) => box(w, h, 0, 0, 0, 0),
    { keywords: ['bent', 'turn', 'corner', 'elbow', 'redirect'] }
  ),
  pathShape(
    'arrow-bent-up',
    'Bent-up arrow',
    A,
    110,
    100,
    (w, h) =>
      fpoly(w, h, [[0, 0.74], [0.58, 0.74], [0.58, 0.3], [0.44, 0.3], [0.72, 0], [1, 0.3], [0.86, 0.3], [0.86, 1], [0, 1]]),
    (w, h) => box(w, h, 0, 0, 0, 0),
    { keywords: ['bent', 'turn up', 'elbow', 'corner'] }
  ),
  pathShape(
    'arrow-left-right-up',
    'Left-right-up arrow',
    A,
    130,
    110,
    (w, h) =>
      fpoly(w, h, [
        [0, 0.78],
        [0.16, 0.56],
        [0.16, 0.7],
        [0.42, 0.7],
        [0.42, 0.2],
        [0.3, 0.2],
        [0.5, 0],
        [0.7, 0.2],
        [0.58, 0.2],
        [0.58, 0.7],
        [0.84, 0.7],
        [0.84, 0.56],
        [1, 0.78],
        [0.84, 1],
        [0.84, 0.86],
        [0.16, 0.86],
        [0.16, 1]
      ]),
    (w, h) => box(w, h, 0, 0, 0, 0),
    { keywords: ['three way', 'tri arrow', 'split', 'branch', 'fork'] }
  ),
  pathShape(
    'arrow-triangle-right',
    'Triangle arrowhead',
    A,
    70,
    80,
    (w, h) => fpoly(w, h, [[0, 0], [1, 0.5], [0, 1]]),
    (w, h) => pad(w, h, w * 0.08, h * 0.3, w * 0.45, h * 0.3),
    { keywords: ['play', 'arrowhead', 'triangle', 'next', 'forward'] }
  )
]
