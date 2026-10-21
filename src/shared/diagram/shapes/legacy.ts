// The original PlexiDiagrams shapes, ported to the registry. Their ids are saved
// in existing documents, so they must never change. Geometry matches the old
// clip-path outlines (the former shared/mapExport POLYGON_POINTS) so old diagrams look the
// same after the move to SVG rendering.

import { type ShapeDef, ellipse, fpoly, inset, rect } from './types'

const pts = {
  decision: [
    [0.5, 0],
    [1, 0.5],
    [0.5, 1],
    [0, 0.5]
  ],
  data: [
    [0.16, 0],
    [1, 0],
    [0.84, 1],
    [0, 1]
  ],
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
} satisfies Record<string, [number, number][]>

function polyShape(
  id: keyof typeof pts,
  label: string,
  category: ShapeDef['category'],
  w: number,
  h: number,
  text: (w: number, h: number) => ReturnType<typeof inset>,
  extra: Partial<ShapeDef> = {}
): ShapeDef {
  return {
    id,
    label,
    category,
    w,
    h,
    draw: (W, H) => ({ parts: [{ d: fpoly(W, H, pts[id]), paint: 'fill' }], text: text(W, H) }),
    ...extra
  }
}

export const LEGACY_SHAPES: ShapeDef[] = [
  {
    id: 'process',
    label: 'Process',
    category: 'Flowchart',
    keywords: ['rectangle', 'step', 'action', 'box'],
    w: 120,
    h: 48,
    defaultLabel: 'Step',
    draw: (w, h) => ({ parts: [{ d: rect(0, 0, w, h, 6), paint: 'fill' }], text: inset(w, h, 8, 4) })
  },
  polyShape('decision', 'Decision', 'Flowchart', 130, 92, (w, h) => inset(w, h, w * 0.22, h * 0.22), {
    keywords: ['diamond', 'branch', 'if', 'yes no', 'rhombus'],
    defaultLabel: 'Decision?'
  }),
  {
    id: 'terminator',
    label: 'Start / End',
    category: 'Flowchart',
    keywords: ['terminator', 'pill', 'start', 'end', 'stadium'],
    w: 120,
    h: 48,
    defaultLabel: 'Start',
    draw: (w, h) => ({ parts: [{ d: rect(0, 0, w, h, h / 2), paint: 'fill' }], text: inset(w, h, h / 3, 4) })
  },
  polyShape('data', 'Data (I/O)', 'Flowchart', 132, 52, (w, h) => inset(w, h, w * 0.17, 4), {
    keywords: ['parallelogram', 'input', 'output', 'io']
  }),
  {
    id: 'database',
    label: 'Database',
    category: 'Flowchart',
    keywords: ['cylinder', 'store', 'storage', 'db', 'disk'],
    w: 104,
    h: 64,
    defaultLabel: 'Store',
    draw: (w, h) => {
      const ry = Math.min(h * 0.16, w * 0.25)
      const body = `M0,${ry} A${w / 2},${ry} 0 0 1 ${w},${ry} V${h - ry} A${w / 2},${ry} 0 0 1 0,${h - ry} Z`
      const lid = `M0,${ry} A${w / 2},${ry} 0 0 0 ${w},${ry}`
      return {
        parts: [
          { d: body, paint: 'fill' },
          { d: lid, paint: 'stroke' }
        ],
        text: inset(w, h, 6, ry * 2 + 2, 6, ry)
      }
    },
    outline: (w, h) => {
      const ry = Math.min(h * 0.16, w * 0.25)
      return `M0,${ry} A${w / 2},${ry} 0 0 1 ${w},${ry} V${h - ry} A${w / 2},${ry} 0 0 1 0,${h - ry} Z`
    }
  },
  {
    id: 'circle',
    label: 'Circle',
    category: 'Basic',
    keywords: ['ellipse', 'round', 'connector', 'state', 'oval'],
    w: 86,
    h: 86,
    aspectLocked: true,
    draw: (w, h) => ({
      parts: [{ d: ellipse(w / 2, h / 2, w / 2, h / 2), paint: 'fill' }],
      text: inset(w, h, w * 0.15, h * 0.15)
    })
  },
  {
    id: 'note',
    label: 'Text',
    category: 'Basic',
    keywords: ['text', 'label', 'free text', 'caption'],
    w: 120,
    h: 40,
    defaultLabel: 'Text',
    special: 'text',
    draw: (w, h) => ({ parts: [{ d: rect(0, 0, w, h), paint: 'none' }], text: inset(w, h, 4, 2) })
  },
  polyShape('hexagon', 'Preparation', 'Flowchart', 130, 70, (w, h) => inset(w, h, w * 0.22, 4), {
    keywords: ['hexagon', 'prep', 'setup']
  }),
  polyShape('trapezoid', 'Manual operation', 'Flowchart', 140, 60, (w, h) => inset(w, h, w * 0.18, 4), {
    keywords: ['trapezoid', 'manual']
  }),
  polyShape('chevron', 'Chevron', 'Arrows', 150, 52, (w, h) => inset(w, h, w * 0.26, 4, w * 0.22), {
    keywords: ['stage', 'step', 'phase', 'process arrow']
  }),
  polyShape('triangle', 'Triangle', 'Basic', 96, 84, (w, h) => inset(w, h, w * 0.25, h * 0.45, w * 0.25, 4), {
    keywords: ['triangle', 'delta']
  }),
  polyShape('pentagon', 'Pentagon', 'Basic', 100, 92, (w, h) => inset(w, h, w * 0.18, h * 0.25), {
    keywords: ['pentagon']
  }),
  polyShape('star', 'Star', 'Basic', 96, 96, (w, h) => inset(w, h, w * 0.32, h * 0.36), {
    keywords: ['star', 'favourite', 'highlight'],
    aspectLocked: true
  }),
  polyShape('cross', 'Cross', 'Basic', 90, 90, (w, h) => inset(w, h, w * 0.34, h * 0.34), {
    keywords: ['plus', 'cross', 'add', 'junction'],
    aspectLocked: true
  }),
  polyShape('arrow', 'Block arrow', 'Arrows', 130, 70, (w, h) => inset(w, h, 6, h * 0.3, w * 0.4, h * 0.3), {
    keywords: ['arrow', 'right', 'direction']
  }),
  polyShape('callout', 'Speech callout', 'Callouts', 140, 84, (w, h) => inset(w, h, 8, 6, 8, h * 0.27), {
    keywords: ['speech', 'bubble', 'comment', 'annotation']
  }),
  {
    id: 'lane',
    label: 'Swimlane',
    category: 'Containers',
    keywords: ['swimlane', 'lane', 'container', 'band', 'row'],
    w: 680,
    h: 200,
    minW: 120,
    minH: 60,
    container: true,
    special: 'lane',
    defaultLabel: 'Lane',
    draw: (w, h) => ({
      parts: [
        { d: rect(0, 0, w, h, 6), paint: 'fill' },
        { d: rect(0, 0, 28, h, 6), paint: 'shade' }
      ],
      text: { x: 0, y: 0, w: 28, h }
    })
  },
  {
    id: 'icon',
    label: 'Icon',
    category: 'Plexii',
    keywords: ['icon', 'symbol', 'glyph', 'pictogram'],
    w: 72,
    h: 72,
    aspectLocked: true,
    special: 'icon',
    icon: 'star',
    defaultStyle: { fill: 'none', stroke: 'none' },
    draw: (w, h) => ({ parts: [{ d: rect(0, 0, w, h, 8), paint: 'fill' }], text: { x: 0, y: h * 0.74, w, h: h * 0.26 } })
  },
  {
    id: 'image',
    label: 'Image',
    category: 'Plexii',
    keywords: ['image', 'picture', 'photo', 'logo', 'screenshot'],
    w: 240,
    h: 160,
    special: 'image',
    defaultStyle: { fill: 'none', stroke: 'none', strokeWidth: 0 },
    draw: (w, h) => ({ parts: [{ d: rect(0, 0, w, h, 4), paint: 'fill' }], text: { x: 0, y: h, w, h: 0 } })
  },
  {
    id: 'data-card',
    label: 'Data card',
    category: 'Plexii',
    keywords: ['record', 'row', 'card', 'data', 'table', 'linked'],
    w: 180,
    h: 84,
    defaultLabel: 'Record',
    draw: (w, h) => ({
      parts: [
        { d: rect(0, 0, w, h, 8), paint: 'fill' },
        { d: rect(0, 0, 6, h, 3), paint: 'solid' }
      ],
      text: inset(w, h, 14, 6, 8, 6)
    }),
    ports: [
      [0.5, 0],
      [1, 0.5],
      [0.5, 1],
      [0, 0.5],
      [0.25, 0],
      [0.75, 0],
      [0.25, 1],
      [0.75, 1]
    ]
  },
  {
    id: 'app-tile',
    label: 'Plexii app',
    category: 'Plexii',
    keywords: ['app', 'application', 'plexii', 'shortcut', 'launcher'],
    w: 150,
    h: 64,
    special: 'icon',
    icon: 'apps',
    draw: (w, h) => ({ parts: [{ d: rect(0, 0, w, h, 12), paint: 'fill' }], text: { x: 0, y: h * 0.62, w, h: h * 0.36 } })
  },
  {
    id: 'tool-tile',
    label: 'Plexii tool',
    category: 'Plexii',
    keywords: ['tool', 'widget', 'plexii', 'utility'],
    w: 150,
    h: 64,
    special: 'icon',
    icon: 'construction',
    draw: (w, h) => ({ parts: [{ d: rect(0, 0, w, h, 12), paint: 'fill' }, { d: rect(0, 0, w, 10, 6), paint: 'shade' }], text: { x: 0, y: h * 0.62, w, h: h * 0.36 } })
  },
  {
    id: 'widget',
    label: 'Live work widget',
    category: 'Plexii',
    keywords: ['widget', 'embed', 'live', 'plexii'],
    w: 280,
    h: 190,
    special: 'widget',
    draw: (w, h) => ({ parts: [{ d: rect(0, 0, w, h, 8), paint: 'fill' }], text: { x: 0, y: 0, w: 0, h: 0 } })
  }
]
