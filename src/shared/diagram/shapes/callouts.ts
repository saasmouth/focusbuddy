// Callouts and annotation balloons. The tail is part of the single silhouette
// so connectors and hit tests follow it. Ids are saved in documents — never
// rename.

import { type ShapeDef, line, poly, r, rect, star } from './types'
import { P, bounds, box, circle, fill, fit, none, onEllipse, pad, pathShape, shape, stroke } from './kit'
import { cloudPath } from './basic'

const K = 'Callouts' as const
const BODY = 0.76 // fraction of the height taken by the balloon body

export const CALLOUT_SHAPES: ShapeDef[] = [
  pathShape(
    'callout-rect',
    'Rectangular callout',
    K,
    150,
    90,
    (w, h) => {
      const bh = h * BODY
      return poly([[0, 0], [w, 0], [w, bh], [w * 0.4, bh], [w * 0.14, h], [w * 0.22, bh], [0, bh]])
    },
    (w, h) => pad(w, h, 8, 6, 8, h * (1 - BODY) + 6),
    { keywords: ['speech', 'balloon', 'comment', 'say', 'box callout'], defaultLabel: 'Comment' }
  ),
  pathShape(
    'callout-rounded',
    'Rounded callout',
    K,
    150,
    90,
    (w, h) => {
      const bh = h * BODY
      const k = Math.min(w, bh) * 0.2
      return (
        `M${r(k)},0 H${r(w - k)} A${r(k)},${r(k)} 0 0 1 ${r(w)},${r(k)} V${r(bh - k)} ` +
        `A${r(k)},${r(k)} 0 0 1 ${P(w - k, bh)} H${r(w * 0.42)} L${P(w * 0.16, h)} L${P(w * 0.24, bh)} ` +
        `H${r(k)} A${r(k)},${r(k)} 0 0 1 0,${r(bh - k)} V${r(k)} A${r(k)},${r(k)} 0 0 1 ${r(k)},0 Z`
      )
    },
    (w, h) => pad(w, h, 10, 6, 10, h * (1 - BODY) + 6),
    { keywords: ['speech', 'balloon', 'chat', 'message', 'comment', 'rounded'], defaultLabel: 'Comment' }
  ),
  pathShape(
    'callout-oval',
    'Oval callout',
    K,
    150,
    96,
    (w, h) => {
      const bh = h * BODY
      const cx = w / 2
      const cy = bh / 2
      const [x0, y0] = onEllipse(cx, cy, w / 2, bh / 2, 100)
      const [x1, y1] = onEllipse(cx, cy, w / 2, bh / 2, 125)
      return `M${P(x1, y1)} A${r(w / 2)},${r(bh / 2)} 0 1 1 ${P(x0, y0)} L${P(w * 0.18, h)} Z`
    },
    (w, h) => box(w, h, w * 0.16, h * BODY * 0.16, w * 0.68, h * BODY * 0.68),
    { keywords: ['speech', 'balloon', 'ellipse', 'say', 'comment', 'oval'], defaultLabel: 'Hello' }
  ),
  shape(
    'callout-cloud',
    'Thought bubble',
    K,
    160,
    110,
    (w, h) => {
      const bh = h * 0.78
      const m = Math.min(w, h)
      return {
        parts: [fill(cloudPath(w, bh)), fill(circle(w * 0.2, h * 0.86, m * 0.05)), fill(circle(w * 0.1, h * 0.96, m * 0.03))],
        text: box(w, h, w * 0.22, bh * 0.26, w * 0.56, bh * 0.48)
      }
    },
    {
      keywords: ['thought', 'think', 'cloud', 'idea', 'dream', 'bubble'],
      defaultLabel: 'Idea',
      outline: (w, h) => cloudPath(w, h * 0.78)
    }
  ),
  shape(
    'callout-line',
    'Line callout',
    K,
    170,
    90,
    (w, h) => {
      const bx = w * 0.3
      const bh = h * 0.6
      return {
        parts: [fill(rect(bx, 0, w - bx, bh)), stroke(`M${P(bx, bh)} L0,${r(h)}`)],
        text: pad(w, h, bx + 6, 4, 6, h - bh + 4)
      }
    },
    {
      keywords: ['leader line', 'label', 'annotation', 'pointer', 'line callout'],
      defaultLabel: 'Label',
      outline: (w, h) => rect(w * 0.3, 0, w * 0.7, h * 0.6)
    }
  ),
  shape(
    'callout-line-accent',
    'Accent line callout',
    K,
    170,
    90,
    (w, h) => {
      const bx = w * 0.3
      const bh = h * 0.6
      return {
        parts: [
          fill(rect(bx, 0, w - bx, bh)),
          stroke(`${line(bx - Math.min(6, bx * 0.3), 0, bx - Math.min(6, bx * 0.3), bh)} M${P(bx - Math.min(6, bx * 0.3), bh / 2)} L0,${r(h)}`)
        ],
        text: pad(w, h, bx + 6, 4, 6, h - bh + 4)
      }
    },
    {
      keywords: ['leader line', 'accent', 'annotation', 'label', 'pointer'],
      defaultLabel: 'Label',
      outline: (w, h) => rect(w * 0.3, 0, w * 0.7, h * 0.6)
    }
  ),
  shape(
    'callout-double-bracket',
    'Double-bracket annotation',
    K,
    160,
    64,
    (w, h) => {
      const k = Math.min(w * 0.08, 10)
      return {
        parts: [
          none(bounds(w, h)),
          stroke(`M${r(k)},0 H0 V${r(h)} H${r(k)} M${r(w - k)},0 H${r(w)} V${r(h)} H${r(w - k)}`)
        ],
        text: pad(w, h, k + 4, 4)
      }
    },
    { keywords: ['bracket', 'annotation', 'note', 'remark', 'brackets'], defaultLabel: 'Note', outline: bounds }
  ),
  pathShape(
    'callout-tail-right',
    'Callout (tail right)',
    K,
    170,
    80,
    (w, h) => {
      const bw = w * 0.82
      return poly([[0, 0], [bw, 0], [bw, h * 0.3], [w, h * 0.7], [bw, h * 0.55], [bw, h], [0, h]])
    },
    (w, h) => pad(w, h, 8, 6, w * 0.18 + 8, 6),
    { keywords: ['speech', 'reply', 'balloon', 'side tail'], defaultLabel: 'Reply' }
  ),
  pathShape(
    'callout-tail-top',
    'Callout (tail up)',
    K,
    150,
    90,
    (w, h) => {
      const t = h * (1 - BODY)
      return poly([[0, t], [w * 0.6, t], [w * 0.75, 0], [w * 0.78, t], [w, t], [w, h], [0, h]])
    },
    (w, h) => pad(w, h, 8, h * (1 - BODY) + 6, 8, 6),
    { keywords: ['tooltip', 'speech', 'popover', 'balloon', 'up'], defaultLabel: 'Tip' }
  ),
  pathShape(
    'callout-shout',
    'Shout callout',
    K,
    160,
    120,
    (w, h) => {
      const pts = fit(w, h * 0.85, star(1, 1, 14, 0.8))
      // Stretch one spike down to the corner as the tail.
      pts[19] = [w * 0.08, h]
      return poly(pts)
    },
    (w, h) => box(w, h, w * 0.22, h * 0.22, w * 0.56, h * 0.4),
    { keywords: ['shout', 'burst', 'exclaim', 'alert', 'bang', 'explosion'], defaultLabel: 'Wow!' }
  ),
  pathShape(
    'callout-banner',
    'Banner',
    K,
    180,
    56,
    (w, h) => {
      const k = Math.min(w * 0.08, h * 0.5)
      return poly([[0, 0], [w, 0], [w - k, h / 2], [w, h], [0, h], [k, h / 2]])
    },
    (w, h) => pad(w, h, Math.min(w * 0.08, h * 0.5) + 4, 4),
    { keywords: ['ribbon', 'banner', 'title', 'heading', 'flag'], defaultLabel: 'Banner' }
  )
]
