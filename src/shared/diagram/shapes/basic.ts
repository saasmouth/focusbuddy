// Basic geometric shapes. Ids are saved in documents — never rename.

import {
  type ShapeDef,
  ellipse,
  fpoly,
  line,
  poly,
  r,
  rect,
  regular,
  star
} from './types'
import {
  P,
  arc,
  band,
  bounds,
  box,
  ellipseRev,
  fill,
  fit,
  folded,
  fpath,
  none,
  pad,
  pathShape,
  shade,
  shape,
  stroke,
  wedge
} from './kit'

const B = 'Basic' as const

const fitPoly = (w: number, h: number, pts: [number, number][]): string => poly(fit(w, h, pts))

// Cloud: bumps traced as arcs between points on an inner ellipse, computed in
// unit space and scaled so the silhouette stays inside the box at any aspect.
export function cloudPath(w: number, h: number, bumps = 9): string {
  const pts: [number, number][] = []
  for (let i = 0; i < bumps; i++) {
    const a = ((-90 + (360 / bumps) * i + 12) * Math.PI) / 180
    pts.push([0.5 + 0.37 * Math.cos(a), 0.5 + 0.33 * Math.sin(a)])
  }
  let d = `M${P(pts[0][0] * w, pts[0][1] * h)}`
  for (let i = 0; i < bumps; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % bumps]
    const R = 0.6 * Math.hypot(x1 - x0, y1 - y0)
    d += ` A${r(R * w)},${r(R * h)} 0 0 1 ${P(x1 * w, y1 * h)}`
  }
  return d + ' Z'
}

export function heartPath(w: number, h: number): string {
  return fpath(
    w,
    h,
    'M', 0.5, 0.22,
    'C', 0.38, 0, 0, 0.02, 0, 0.32,
    'C', 0, 0.58, 0.3, 0.76, 0.5, 1,
    'C', 0.7, 0.76, 1, 0.58, 1, 0.32,
    'C', 1, 0.02, 0.62, 0, 0.5, 0.22,
    'Z'
  )
}

const polyText = (l: number, t: number, rt = l, b = t) => (w: number, h: number) =>
  pad(w, h, w * l, h * t, w * rt, h * b)

export const BASIC_SHAPES: ShapeDef[] = [
  pathShape('basic-rectangle', 'Rectangle', B, 120, 64, (w, h) => rect(0, 0, w, h), (w, h) => pad(w, h, 6, 4), {
    keywords: ['box', 'square corners', 'rect']
  }),
  pathShape(
    'basic-rounded-rectangle',
    'Rounded rectangle',
    B,
    120,
    64,
    (w, h) => rect(0, 0, w, h, Math.min(w, h) * 0.2),
    (w, h) => pad(w, h, 8, 4),
    { keywords: ['rounded', 'box', 'card', 'pill'] }
  ),
  pathShape('basic-square', 'Square', B, 80, 80, (w, h) => rect(0, 0, w, h), (w, h) => pad(w, h, 6), {
    keywords: ['box', 'quad'],
    aspectLocked: true
  }),
  pathShape(
    'basic-ellipse',
    'Ellipse',
    B,
    120,
    72,
    (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2),
    polyText(0.15, 0.15),
    { keywords: ['oval', 'circle', 'round'] }
  ),
  pathShape(
    'basic-right-triangle',
    'Right triangle',
    B,
    96,
    84,
    (w, h) => fpoly(w, h, [[0, 0], [1, 1], [0, 1]]),
    polyText(0.06, 0.5, 0.45, 0.04),
    { keywords: ['triangle', 'right angle'] }
  ),
  pathShape(
    'basic-triangle-down',
    'Inverted triangle',
    B,
    96,
    84,
    (w, h) => fpoly(w, h, [[0, 0], [1, 0], [0.5, 1]]),
    polyText(0.25, 0.04, 0.25, 0.45),
    { keywords: ['triangle', 'down', 'funnel', 'merge'] }
  ),
  pathShape(
    'basic-diamond',
    'Diamond',
    B,
    96,
    96,
    (w, h) => fpoly(w, h, [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]),
    polyText(0.22, 0.22),
    { keywords: ['rhombus', 'lozenge', 'decision'] }
  ),
  pathShape(
    'basic-parallelogram',
    'Parallelogram',
    B,
    132,
    60,
    (w, h) => fpoly(w, h, [[0.2, 0], [1, 0], [0.8, 1], [0, 1]]),
    polyText(0.2, 0.06),
    { keywords: ['slant', 'skew', 'rhomboid'] }
  ),
  pathShape(
    'basic-trapezoid',
    'Trapezoid',
    B,
    132,
    64,
    (w, h) => fpoly(w, h, [[0, 1], [0.2, 0], [0.8, 0], [1, 1]]),
    polyText(0.2, 0.06),
    { keywords: ['trapezium', 'keystone'] }
  ),
  pathShape('basic-hexagon', 'Hexagon', B, 104, 90, (w, h) => fitPoly(w, h, regular(1, 1, 6, 0)), polyText(0.24, 0.1), {
    keywords: ['hex', 'six sides', 'polygon', 'honeycomb']
  }),
  pathShape('basic-heptagon', 'Heptagon', B, 96, 92, (w, h) => fitPoly(w, h, regular(1, 1, 7)), polyText(0.22, 0.22, 0.22, 0.14), {
    keywords: ['seven sides', 'polygon'],
    aspectLocked: true
  }),
  pathShape(
    'basic-octagon',
    'Octagon',
    B,
    92,
    92,
    (w, h) =>
      fpoly(w, h, [
        [0.29, 0],
        [0.71, 0],
        [1, 0.29],
        [1, 0.71],
        [0.71, 1],
        [0.29, 1],
        [0, 0.71],
        [0, 0.29]
      ]),
    polyText(0.12, 0.12),
    { keywords: ['eight sides', 'stop', 'polygon'], aspectLocked: true }
  ),
  pathShape(
    'basic-decagon',
    'Decagon',
    B,
    96,
    96,
    (w, h) => fitPoly(w, h, regular(1, 1, 10, -90 + 18)),
    polyText(0.15, 0.15),
    { keywords: ['ten sides', 'polygon'], aspectLocked: true }
  ),
  pathShape(
    'basic-dodecagon',
    'Dodecagon',
    B,
    96,
    96,
    (w, h) => fitPoly(w, h, regular(1, 1, 12, -90 + 15)),
    polyText(0.13, 0.13),
    { keywords: ['twelve sides', 'polygon'], aspectLocked: true }
  ),
  pathShape('basic-star-4', '4-point star', B, 96, 96, (w, h) => fitPoly(w, h, star(1, 1, 4, 0.38)), polyText(0.36, 0.36), {
    keywords: ['star', 'sparkle', 'twinkle'],
    aspectLocked: true
  }),
  pathShape('basic-star-6', '6-point star', B, 96, 96, (w, h) => fitPoly(w, h, star(1, 1, 6, 0.58)), polyText(0.28, 0.3), {
    keywords: ['star', 'hexagram'],
    aspectLocked: true
  }),
  pathShape('basic-star-8', '8-point star', B, 96, 96, (w, h) => fitPoly(w, h, star(1, 1, 8, 0.66)), polyText(0.25, 0.25), {
    keywords: ['star', 'compass'],
    aspectLocked: true
  }),
  pathShape('basic-star-12', '12-point star', B, 96, 96, (w, h) => fitPoly(w, h, star(1, 1, 12, 0.74)), polyText(0.22, 0.22), {
    keywords: ['star', 'badge', 'seal'],
    aspectLocked: true
  }),
  pathShape('basic-burst', 'Burst', B, 110, 110, (w, h) => fitPoly(w, h, star(1, 1, 16, 0.8)), polyText(0.2, 0.2), {
    keywords: ['explosion', 'starburst', 'seal', 'sale', 'badge'],
    aspectLocked: true,
    defaultLabel: 'New!'
  }),
  shape(
    'basic-donut',
    'Donut',
    B,
    96,
    96,
    (w, h) => ({
      parts: [fill(`${ellipse(w / 2, h / 2, w / 2, h / 2)} ${ellipseRev(w / 2, h / 2, w * 0.3, h * 0.3)}`)],
      text: box(w, h, w * 0.3, h * 0.36, w * 0.4, h * 0.28)
    }),
    {
      keywords: ['ring', 'annulus', 'circle', 'hole'],
      aspectLocked: true,
      outline: (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2)
    }
  ),
  pathShape('basic-heart', 'Heart', B, 96, 88, heartPath, polyText(0.22, 0.22, 0.22, 0.3), {
    keywords: ['love', 'like', 'favourite', 'favorite'],
    aspectLocked: true
  }),
  pathShape('basic-cloud', 'Cloud', B, 140, 96, (w, h) => cloudPath(w, h), polyText(0.2, 0.24), {
    keywords: ['cloud', 'thought', 'internet', 'weather']
  }),
  shape(
    'basic-cube',
    'Cube',
    B,
    104,
    96,
    (w, h) => {
      const d = Math.min(w, h) * 0.2
      return {
        parts: [
          fill(`M0,${r(d)} L${r(d)},0 H${r(w)} V${r(h - d)} L${P(w - d, h)} H0 Z`),
          stroke(`M0,${r(d)} H${r(w - d)} L${r(w)},0 M${r(w - d)},${r(d)} V${r(h)}`),
          shade(`M${P(w - d, d)} L${r(w)},0 V${r(h - d)} L${P(w - d, h)} Z`)
        ],
        text: pad(w, h, 6, d + 4, d + 6, 4)
      }
    },
    { keywords: ['3d', 'box', 'block', 'isometric'] }
  ),
  shape(
    'basic-cylinder-h',
    'Horizontal cylinder',
    B,
    140,
    64,
    (w, h) => {
      const rx = Math.min(w * 0.16, h * 0.3)
      return {
        parts: [
          fill(
            `M${r(rx)},0 H${r(w - rx)} A${r(rx)},${r(h / 2)} 0 0 1 ${P(w - rx, h)} ` +
              `H${r(rx)} A${r(rx)},${r(h / 2)} 0 0 1 ${r(rx)},0 Z`
          ),
          stroke(`M${r(w - rx)},0 A${r(rx)},${r(h / 2)} 0 0 0 ${P(w - rx, h)}`)
        ],
        text: pad(w, h, rx + 4, 4, rx * 2 + 4, 4)
      }
    },
    { keywords: ['can', 'tube', 'pipe', 'cylinder', 'drum', 'direct access'] }
  ),
  shape(
    'basic-can',
    'Can',
    B,
    90,
    110,
    (w, h) => {
      const ry = Math.min(h * 0.14, w * 0.3)
      return {
        parts: [
          fill(
            `M0,${r(ry)} A${r(w / 2)},${r(ry)} 0 0 1 ${r(w)},${r(ry)} V${r(h - ry)} ` +
              `A${r(w / 2)},${r(ry)} 0 0 1 0,${r(h - ry)} Z`
          ),
          shade(`${ellipse(w / 2, ry, w / 2, ry)}`)
        ],
        text: pad(w, h, 6, ry * 2 + 4, 6, ry + 2)
      }
    },
    {
      keywords: ['cylinder', 'tube', 'barrel', 'tin'],
      outline: (w, h) => {
        const ry = Math.min(h * 0.14, w * 0.3)
        return `M0,${r(ry)} A${r(w / 2)},${r(ry)} 0 0 1 ${r(w)},${r(ry)} V${r(h - ry)} A${r(w / 2)},${r(ry)} 0 0 1 0,${r(h - ry)} Z`
      }
    }
  ),
  shape(
    'basic-frame',
    'Frame',
    B,
    120,
    90,
    (w, h) => {
      const t = Math.min(w, h) * 0.12
      return {
        parts: [fill(`${rect(0, 0, w, h)} M${P(t, t)} V${r(h - t)} H${r(w - t)} V${r(t)} Z`)],
        text: pad(w, h, t + 4, t + 2)
      }
    },
    { keywords: ['picture frame', 'border', 'hollow'], outline: (w, h) => rect(0, 0, w, h) }
  ),
  pathShape(
    'basic-plaque',
    'Plaque',
    B,
    130,
    72,
    (w, h) => {
      const k = Math.min(w, h) * 0.18
      return (
        `M${r(k)},0 H${r(w - k)} A${r(k)},${r(k)} 0 0 0 ${r(w)},${r(k)} V${r(h - k)} ` +
        `A${r(k)},${r(k)} 0 0 0 ${P(w - k, h)} H${r(k)} A${r(k)},${r(k)} 0 0 0 0,${r(h - k)} ` +
        `V${r(k)} A${r(k)},${r(k)} 0 0 0 ${r(k)},0 Z`
      )
    },
    (w, h) => pad(w, h, Math.min(w, h) * 0.2, 4),
    { keywords: ['ticket', 'concave', 'sign', 'nameplate'] }
  ),
  shape(
    'basic-bevel',
    'Bevel',
    B,
    120,
    72,
    (w, h) => {
      const k = Math.min(w, h) * 0.14
      return {
        parts: [
          fill(rect(0, 0, w, h)),
          shade(`M0,${r(h)} L${P(k, h - k)} H${r(w - k)} V${r(k)} L${r(w)},0 V${r(h)} Z`),
          stroke(
            `${rect(k, k, w - 2 * k, h - 2 * k)} M0,0 L${P(k, k)} M${r(w)},0 L${P(w - k, k)} ` +
              `M${r(w)},${r(h)} L${P(w - k, h - k)} M0,${r(h)} L${P(k, h - k)}`
          )
        ],
        text: pad(w, h, k + 3, k + 2)
      }
    },
    { keywords: ['button', 'raised', 'emboss', '3d'] }
  ),
  pathShape(
    'basic-moon',
    'Moon',
    B,
    70,
    96,
    (w, h) =>
      `M${r(w)},0 A${r(w)},${r(h / 2)} 0 0 0 ${P(w, h)} A${r(w * 0.55)},${r(h / 2)} 0 0 1 ${r(w)},0 Z`,
    (w, h) => box(w, h, w * 0.06, h * 0.3, w * 0.36, h * 0.4),
    { keywords: ['crescent', 'night', 'lunar'] }
  ),
  pathShape(
    'basic-lightning',
    'Lightning bolt',
    B,
    80,
    110,
    (w, h) =>
      fpoly(w, h, [
        [0.4, 0],
        [0.72, 0],
        [0.56, 0.36],
        [0.86, 0.36],
        [0.3, 1],
        [0.44, 0.54],
        [0.14, 0.54]
      ]),
    (w, h) => box(w, h, w * 0.3, h * 0.38, w * 0.4, h * 0.14),
    { keywords: ['bolt', 'flash', 'electric', 'power', 'thunder', 'energy'] }
  ),
  pathShape(
    'basic-pie',
    'Pie wedge',
    B,
    96,
    96,
    (w, h) => wedge(w / 2, h / 2, w / 2, h / 2, -90, 180),
    (w, h) => box(w, h, w * 0.52, h * 0.52, w * 0.3, h * 0.3),
    { keywords: ['pie', 'sector', 'pacman', 'slice', 'chart'], aspectLocked: true }
  ),
  pathShape(
    'basic-quarter-pie',
    'Quarter circle',
    B,
    90,
    90,
    (w, h) => wedge(0, h, w, h, -90, 0),
    (w, h) => box(w, h, w * 0.08, h * 0.45, w * 0.5, h * 0.48),
    { keywords: ['quadrant', 'sector', 'wedge'], aspectLocked: true }
  ),
  pathShape(
    'basic-chord',
    'Chord',
    B,
    96,
    96,
    (w, h) => {
      const a0 = 140
      const a1 = 400
      const x0 = w / 2 + (w / 2) * Math.cos((a0 * Math.PI) / 180)
      const y0 = h / 2 + (h / 2) * Math.sin((a0 * Math.PI) / 180)
      const x1 = w / 2 + (w / 2) * Math.cos((a1 * Math.PI) / 180)
      const y1 = h / 2 + (h / 2) * Math.sin((a1 * Math.PI) / 180)
      return `M${P(x0, y0)} A${r(w / 2)},${r(h / 2)} 0 1 1 ${P(x1, y1)} Z`
    },
    polyText(0.18, 0.18, 0.18, 0.32),
    { keywords: ['segment', 'circle segment'], aspectLocked: true }
  ),
  shape(
    'basic-block-arc',
    'Block arc',
    B,
    120,
    64,
    (w, h) => ({
      parts: [fill(band(w / 2, h, w / 2, h, w * 0.28, h * 0.56, 180, 360))],
      text: box(w, h, w * 0.3, h * 0.55, w * 0.4, h * 0.45)
    }),
    { keywords: ['arch', 'rainbow', 'gauge', 'arc', 'bridge'] }
  ),
  shape(
    'basic-arc',
    'Arc',
    B,
    120,
    60,
    (w, h) => ({
      parts: [none(bounds(w, h)), stroke(arc(w / 2, h, w / 2, h, 180, 360))],
      text: box(w, h, w * 0.25, h * 0.45, w * 0.5, h * 0.55)
    }),
    { keywords: ['curve', 'semicircle line', 'bow'], outline: bounds }
  ),
  pathShape(
    'basic-half-circle',
    'Half circle',
    B,
    120,
    60,
    (w, h) => `M0,${r(h)} A${r(w / 2)},${r(h)} 0 0 1 ${r(w)},${r(h)} Z`,
    (w, h) => box(w, h, w * 0.2, h * 0.35, w * 0.6, h * 0.6),
    { keywords: ['semicircle', 'dome', 'half moon'] }
  ),
  pathShape(
    'basic-teardrop',
    'Teardrop',
    B,
    80,
    104,
    (w, h) =>
      fpath(
        w,
        h,
        'M', 0.5, 0,
        'C', 0.66, 0.2, 1, 0.4, 1, 0.65,
        'C', 1, 0.86, 0.78, 1, 0.5, 1,
        'C', 0.22, 1, 0, 0.86, 0, 0.65,
        'C', 0, 0.4, 0.34, 0.2, 0.5, 0,
        'Z'
      ),
    polyText(0.16, 0.45, 0.16, 0.1),
    { keywords: ['drop', 'water', 'droplet', 'pin', 'location'] }
  ),
  pathShape(
    'basic-cross-x',
    'Multiply (X)',
    B,
    90,
    90,
    (w, h) => {
      const t = 0.18
      return fpoly(w, h, [
        [t, 0],
        [0.5, 0.5 - t],
        [1 - t, 0],
        [1, t],
        [0.5 + t, 0.5],
        [1, 1 - t],
        [1 - t, 1],
        [0.5, 0.5 + t],
        [t, 1],
        [0, 1 - t],
        [0.5 - t, 0.5],
        [0, t]
      ])
    },
    polyText(0.38, 0.38),
    { keywords: ['x', 'cross', 'close', 'cancel', 'delete', 'times', 'no'], aspectLocked: true }
  ),
  pathShape(
    'basic-snip-corner',
    'Snipped rectangle',
    B,
    120,
    64,
    (w, h) => {
      const k = Math.min(w, h) * 0.25
      return poly([[0, 0], [w - k, 0], [w, k], [w, h], [0, h]])
    },
    (w, h) => pad(w, h, 6, 4, Math.min(w, h) * 0.2, 4),
    { keywords: ['snip', 'cut corner', 'tag'] }
  ),
  pathShape(
    'basic-snip-two',
    'Snipped diagonal corners',
    B,
    120,
    64,
    (w, h) => {
      const k = Math.min(w, h) * 0.25
      return poly([[k, 0], [w, 0], [w, h - k], [w - k, h], [0, h], [0, k]])
    },
    (w, h) => pad(w, h, Math.min(w, h) * 0.2, 4),
    { keywords: ['snip', 'cut corners', 'chamfer'] }
  ),
  pathShape(
    'basic-round-corner',
    'One round corner',
    B,
    120,
    64,
    (w, h) => {
      const k = Math.min(w, h) * 0.35
      return `M0,0 H${r(w - k)} A${r(k)},${r(k)} 0 0 1 ${r(w)},${r(k)} V${r(h)} H0 Z`
    },
    (w, h) => pad(w, h, 6, 4, Math.min(w, h) * 0.2, 4),
    { keywords: ['tab', 'rounded corner', 'leaf'] }
  ),
  pathShape(
    'basic-leaf',
    'Leaf',
    B,
    110,
    70,
    (w, h) => {
      const k = Math.min(w, h) * 0.5
      return (
        `M0,0 H${r(w - k)} A${r(k)},${r(k)} 0 0 1 ${r(w)},${r(k)} V${r(h)} ` +
        `H${r(k)} A${r(k)},${r(k)} 0 0 1 0,${r(h - k)} Z`
      )
    },
    (w, h) => pad(w, h, Math.min(w, h) * 0.18, 4),
    { keywords: ['diagonal round', 'rounded corners', 'petal'] }
  ),
  shape(
    'basic-folded-corner',
    'Folded corner',
    B,
    100,
    110,
    (w, h) => {
      const f = folded(w, h, Math.min(w, h) * 0.22)
      return { parts: [fill(f.body), shade(f.fold)], text: pad(w, h, 8, Math.min(w, h) * 0.22 + 2, 8, 6) }
    },
    { keywords: ['page', 'document', 'paper', 'dog ear'] }
  ),
  pathShape(
    'basic-capsule',
    'Capsule',
    B,
    64,
    120,
    (w, h) => rect(0, 0, w, h, Math.min(w, h) / 2),
    (w, h) => pad(w, h, 4, Math.min(w, h) / 3),
    { keywords: ['pill', 'stadium', 'vertical', 'tube'] }
  ),
  pathShape(
    'basic-shield',
    'Shield',
    B,
    90,
    104,
    (w, h) =>
      fpath(w, h, 'M', 0, 0, 'H', 1, 'V', 0.45, 'C', 1, 0.75, 0.75, 0.9, 0.5, 1, 'C', 0.25, 0.9, 0, 0.75, 0, 0.45, 'Z'),
    polyText(0.12, 0.1, 0.12, 0.3),
    { keywords: ['badge', 'security', 'protect', 'crest', 'guard'] }
  ),
  pathShape(
    'basic-wave',
    'Wave',
    B,
    140,
    72,
    (w, h) =>
      fpath(w, h, 'M', 0, 0.14, 'C', 0.3, 0, 0.6, 0.32, 1, 0.14, 'V', 0.86, 'C', 0.7, 1, 0.4, 0.68, 0, 0.86, 'Z'),
    polyText(0.04, 0.24),
    { keywords: ['flag', 'banner', 'tape', 'ripple', 'wavy'] }
  ),
  pathShape(
    'basic-l-shape',
    'L-shape',
    B,
    100,
    100,
    (w, h) => fpoly(w, h, [[0, 0], [0.42, 0], [0.42, 0.58], [1, 0.58], [1, 1], [0, 1]]),
    (w, h) => box(w, h, 4, h * 0.62, w - 8, h * 0.34),
    { keywords: ['corner', 'elbow', 'angle'] }
  ),
  pathShape(
    'basic-diagonal-stripe',
    'Diagonal stripe',
    B,
    100,
    100,
    (w, h) => fpoly(w, h, [[0, 0.5], [0.5, 0], [1, 0], [0, 1]]),
    (w, h) => box(w, h, w * 0.18, h * 0.3, w * 0.36, h * 0.24),
    { keywords: ['slash', 'stripe', 'band'] }
  ),
  shape(
    'basic-no-symbol',
    'No symbol',
    B,
    90,
    90,
    (w, h) => {
      const cx = w / 2
      const cy = h / 2
      const ir = 0.74
      // Two half-rings either side of the slash, as one compound shape.
      const k = 0.13
      const q = (a: number, rr: number): string => {
        const t = (a * Math.PI) / 180
        return P(cx + (w / 2) * rr * Math.cos(t), cy + (h / 2) * rr * Math.sin(t))
      }
      const off = (Math.asin(Math.min(0.95, k / ir)) * 180) / Math.PI
      return {
        parts: [
          fill(
            `${ellipse(cx, cy, w / 2, h / 2)} ` +
              `M${q(-135 + off, ir)} A${r((w / 2) * ir)},${r((h / 2) * ir)} 0 0 1 ${q(45 - off, ir)} Z ` +
              `M${q(45 + off, ir)} A${r((w / 2) * ir)},${r((h / 2) * ir)} 0 0 1 ${q(225 - off, ir)} Z`
          )
        ],
        text: box(w, h, w * 0.3, h * 0.88, w * 0.4, h * 0.12)
      }
    },
    {
      keywords: ['prohibited', 'forbidden', 'ban', 'not allowed', 'stop'],
      aspectLocked: true,
      outline: (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2)
    }
  ),
  shape(
    'basic-brace-left',
    'Left brace',
    B,
    120,
    100,
    (w, h) => {
      const bw = Math.min(w * 0.25, 24)
      const m = bw / 2
      return {
        parts: [
          none(bounds(w, h)),
          stroke(
            `M${r(bw)},0 Q${r(m)},0 ${P(m, h * 0.1)} V${r(h * 0.4)} Q${P(m, h * 0.5)} 0,${r(h * 0.5)} ` +
              `Q${P(m, h * 0.5)} ${P(m, h * 0.6)} V${r(h * 0.9)} Q${P(m, h)} ${P(bw, h)}`
          )
        ],
        text: box(w, h, bw + 4, 0, w - bw - 4, h)
      }
    },
    { keywords: ['curly brace', 'brace', 'group', 'annotation', '{'], outline: bounds, defaultLabel: 'Note' }
  ),
  shape(
    'basic-brace-right',
    'Right brace',
    B,
    120,
    100,
    (w, h) => {
      const bw = Math.min(w * 0.25, 24)
      const x0 = w - bw
      const m = w - bw / 2
      return {
        parts: [
          none(bounds(w, h)),
          stroke(
            `M${r(x0)},0 Q${r(m)},0 ${P(m, h * 0.1)} V${r(h * 0.4)} Q${P(m, h * 0.5)} ${r(w)},${r(h * 0.5)} ` +
              `Q${P(m, h * 0.5)} ${P(m, h * 0.6)} V${r(h * 0.9)} Q${P(m, h)} ${P(x0, h)}`
          )
        ],
        text: box(w, h, 0, 0, w - bw - 4, h)
      }
    },
    { keywords: ['curly brace', 'brace', 'group', 'annotation', '}'], outline: bounds, defaultLabel: 'Note' }
  ),
  shape(
    'basic-bracket-left',
    'Left bracket',
    B,
    120,
    100,
    (w, h) => {
      const bw = Math.min(w * 0.15, 14)
      return {
        parts: [none(bounds(w, h)), stroke(`M${r(bw)},0 H0 V${r(h)} H${r(bw)}`)],
        text: box(w, h, bw + 4, 0, w - bw - 4, h)
      }
    },
    { keywords: ['square bracket', 'bracket', 'annotation', '['], outline: bounds, defaultLabel: 'Note' }
  ),
  shape(
    'basic-bracket-right',
    'Right bracket',
    B,
    120,
    100,
    (w, h) => {
      const bw = Math.min(w * 0.15, 14)
      return {
        parts: [none(bounds(w, h)), stroke(`M${r(w - bw)},0 H${r(w)} V${r(h)} H${r(w - bw)}`)],
        text: box(w, h, 0, 0, w - bw - 4, h)
      }
    },
    { keywords: ['square bracket', 'bracket', 'annotation', ']'], outline: bounds, defaultLabel: 'Note' }
  ),
  shape(
    'basic-double-bracket',
    'Double bracket',
    B,
    140,
    64,
    (w, h) => {
      const k = Math.min(w, h) * 0.18
      return {
        parts: [
          none(bounds(w, h)),
          stroke(
            `M${r(k)},0 A${r(k)},${r(k)} 0 0 0 0,${r(k)} V${r(h - k)} A${r(k)},${r(k)} 0 0 0 ${r(k)},${r(h)} ` +
              `M${r(w - k)},0 A${r(k)},${r(k)} 0 0 1 ${r(w)},${r(k)} V${r(h - k)} A${r(k)},${r(k)} 0 0 1 ${P(w - k, h)}`
          )
        ],
        text: pad(w, h, k + 4, 4)
      }
    },
    { keywords: ['parentheses', 'bracket pair', 'quote'], outline: bounds }
  ),
  shape(
    'basic-line-h',
    'Horizontal line',
    B,
    160,
    24,
    (w, h) => ({
      parts: [none(bounds(w, h)), stroke(line(0, h / 2, w, h / 2))],
      text: box(w, h, 0, 0, w, h / 2)
    }),
    { keywords: ['rule', 'separator', 'divider', 'hr'], outline: bounds, minH: 8 }
  ),
  shape(
    'basic-line-v',
    'Vertical line',
    B,
    24,
    160,
    (w, h) => ({
      parts: [none(bounds(w, h)), stroke(line(w / 2, 0, w / 2, h))],
      text: box(w, h, 0, 0, w, h)
    }),
    { keywords: ['rule', 'separator', 'divider'], outline: bounds, minW: 8 }
  )
]
