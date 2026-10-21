// Mind-map topics. Ids are saved in documents — never rename.

import { type ShapeDef, ellipse, line, poly, rect } from './types'
import { PORTS_8, bounds, box, fill, none, pad, pathShape, shape, stroke } from './kit'
import { cloudPath } from './basic'

const M = 'Mind map' as const

export const MINDMAP_SHAPES: ShapeDef[] = [
  pathShape(
    'mind-central',
    'Central topic',
    M,
    200,
    90,
    (w, h) => rect(0, 0, w, h, Math.min(w, h) * 0.3),
    (w, h) => pad(w, h, Math.min(w, h) * 0.2, 6),
    {
      keywords: ['mind map', 'central topic', 'main idea', 'root', 'core', 'centre', 'center'],
      defaultLabel: 'Central topic',
      ports: PORTS_8,
      defaultStyle: { bold: true, fontSize: 18 },
      color: '#7C3AED'
    }
  ),
  pathShape(
    'mind-central-oval',
    'Central topic (oval)',
    M,
    200,
    110,
    (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2),
    (w, h) => pad(w, h, w * 0.15, h * 0.16),
    {
      keywords: ['mind map', 'central topic', 'root', 'oval', 'bubble'],
      defaultLabel: 'Central topic',
      ports: PORTS_8,
      defaultStyle: { bold: true, fontSize: 18 },
      color: '#7C3AED'
    }
  ),
  pathShape(
    'mind-main',
    'Main topic',
    M,
    150,
    52,
    (w, h) => rect(0, 0, w, h, Math.min(w, h) * 0.25),
    (w, h) => pad(w, h, 10, 4),
    { keywords: ['mind map', 'main topic', 'branch', 'idea', 'topic'], defaultLabel: 'Main topic', defaultStyle: { bold: true } }
  ),
  shape(
    'mind-subtopic',
    'Subtopic',
    M,
    130,
    36,
    (w, h) => ({ parts: [none(bounds(w, h)), stroke(line(0, h - 1, w, h - 1))], text: pad(w, h, 4, 2, 4, 4) }),
    {
      keywords: ['mind map', 'subtopic', 'leaf', 'underline', 'child', 'detail'],
      defaultLabel: 'Subtopic',
      outline: bounds,
      ports: [
        [0, 1],
        [1, 1],
        [0.5, 0],
        [0.5, 1]
      ],
      defaultStyle: { fill: 'none' }
    }
  ),
  pathShape(
    'mind-floating',
    'Floating topic',
    M,
    140,
    48,
    (w, h) => rect(0, 0, w, h, Math.min(w, h) * 0.5),
    (w, h) => pad(w, h, Math.min(w, h) * 0.35, 4),
    { keywords: ['mind map', 'floating topic', 'free topic', 'detached', 'pill'], defaultLabel: 'Floating topic', defaultStyle: { strokeDash: 'dashed' } }
  ),
  pathShape(
    'mind-callout',
    'Callout topic',
    M,
    150,
    70,
    (w, h) => {
      const bh = h * 0.78
      return poly([[0, 0], [w, 0], [w, bh], [w * 0.36, bh], [w * 0.2, h], [w * 0.24, bh], [0, bh]])
    },
    (w, h) => pad(w, h, 8, 4, 8, h * 0.22 + 4),
    { keywords: ['mind map', 'callout', 'comment', 'note topic'], defaultLabel: 'Callout' }
  ),
  shape(
    'mind-boundary',
    'Boundary',
    M,
    320,
    220,
    (w, h) => ({ parts: [fill(cloudPath(w, h, 12))], text: box(w, h, w * 0.25, h * 0.14, w * 0.5, h * 0.14) }),
    {
      keywords: ['mind map', 'boundary', 'group', 'cluster', 'cloud', 'enclose'],
      container: true,
      defaultLabel: 'Group',
      ports: PORTS_8,
      defaultStyle: { strokeDash: 'dashed', fillOpacity: 0.15 }
    }
  ),
  pathShape(
    'mind-summary',
    'Summary topic',
    M,
    140,
    48,
    (w, h) => rect(0, 0, w, h, 4),
    (w, h) => pad(w, h, 8, 4),
    { keywords: ['mind map', 'summary', 'conclusion', 'roll up'], defaultLabel: 'Summary', defaultStyle: { bold: true } }
  )
]
