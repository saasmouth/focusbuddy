// ANSI / ISO 5807 flowchart symbols. The legacy file already provides process,
// decision, terminator, data (I/O), database (magnetic disk), hexagon
// (preparation) and trapezoid (manual operation); this file adds the rest of the
// standard set. Ids are saved in documents — never rename.

import { type ShapeDef, ellipse, fpoly, line, poly, r, rect } from './types'
import { P, bounds, box, circle, fill, fpath, none, pad, pathShape, shape, stroke } from './kit'

const F = 'Flowchart' as const

// Document with a wavy bottom edge, placed at (x, y) with size dw×dh.
export function docAt(x: number, y: number, dw: number, dh: number): string {
  const X = (f: number): number => x + f * dw
  const Y = (f: number): number => y + f * dh
  return (
    `M${P(X(0), Y(0))} H${r(X(1))} V${r(Y(0.8))} ` +
    `C${P(X(0.8), Y(0.62))} ${P(X(0.6), Y(0.7))} ${P(X(0.5), Y(0.84))} ` +
    `C${P(X(0.38), Y(1))} ${P(X(0.15), Y(1))} ${P(X(0), Y(0.88))} Z`
  )
}

const tape = (w: number, h: number): string =>
  fpath(
    w,
    h,
    'M', 0, 0.12,
    'C', 0.2, 0.26, 0.32, 0.26, 0.5, 0.12,
    'C', 0.68, 0, 0.82, 0, 1, 0.12,
    'V', 0.88,
    'C', 0.82, 0.74, 0.68, 0.74, 0.5, 0.88,
    'C', 0.32, 1, 0.2, 1, 0, 0.88,
    'Z'
  )

const cylH = (w: number, h: number): string => {
  const rx = Math.min(w * 0.16, h * 0.3)
  return (
    `M${r(rx)},0 H${r(w - rx)} A${r(rx)},${r(h / 2)} 0 0 1 ${P(w - rx, h)} ` +
    `H${r(rx)} A${r(rx)},${r(h / 2)} 0 0 1 ${r(rx)},0 Z`
  )
}

const frac = (l: number, t: number, rt = l, b = t) => (w: number, h: number) =>
  pad(w, h, w * l, h * t, w * rt, h * b)

export const FLOWCHART_SHAPES: ShapeDef[] = [
  pathShape('fc-document', 'Document', F, 120, 72, (w, h) => docAt(0, 0, w, h), (w, h) => pad(w, h, 6, 4, 6, h * 0.2), {
    keywords: ['document', 'report', 'paper', 'file', 'printout'],
    defaultLabel: 'Document'
  }),
  shape(
    'fc-multi-document',
    'Multiple documents',
    F,
    130,
    84,
    (w, h) => {
      const k = Math.min(w, h) * 0.08
      const dw = w - 2 * k
      const dh = h - 2 * k
      return {
        parts: [fill(docAt(2 * k, 0, dw, dh)), fill(docAt(k, k, dw, dh)), fill(docAt(0, 2 * k, dw, dh))],
        text: pad(w, h, 6, 2 * k + 4, 2 * k + 6, h * 0.22)
      }
    },
    {
      keywords: ['documents', 'reports', 'stack', 'multiple', 'files'],
      defaultLabel: 'Documents',
      outline: (w, h) => {
        const k = Math.min(w, h) * 0.08
        const dh = h - 2 * k
        return poly([
          [0, 2 * k],
          [k, 2 * k],
          [k, k],
          [2 * k, k],
          [2 * k, 0],
          [w, 0],
          [w, dh * 0.8],
          [w - k, dh * 0.8 + k * 0.5],
          [w - k, dh * 0.8 + k],
          [w - 2 * k, dh * 0.8 + k * 1.5],
          [w - 2 * k, 2 * k + dh * 0.8],
          [(w - 2 * k) * 0.5, 2 * k + dh * 0.84],
          [0, 2 * k + dh * 0.88]
        ])
      }
    }
  ),
  shape(
    'fc-predefined-process',
    'Predefined process',
    F,
    130,
    56,
    (w, h) => {
      const k = Math.min(w * 0.1, 14)
      return {
        parts: [fill(rect(0, 0, w, h)), stroke(`${line(k, 0, k, h)} ${line(w - k, 0, w - k, h)}`)],
        text: pad(w, h, k + 4, 4)
      }
    },
    { keywords: ['subroutine', 'subprocess', 'function', 'call', 'predefined'], defaultLabel: 'Subroutine' }
  ),
  shape(
    'fc-internal-storage',
    'Internal storage',
    F,
    110,
    72,
    (w, h) => {
      const kx = Math.min(w * 0.14, 16)
      const ky = Math.min(h * 0.2, 16)
      return {
        parts: [fill(rect(0, 0, w, h)), stroke(`${line(kx, 0, kx, h)} ${line(0, ky, w, ky)}`)],
        text: pad(w, h, kx + 4, ky + 3, 4, 3)
      }
    },
    { keywords: ['memory', 'core', 'ram', 'internal'] }
  ),
  pathShape(
    'fc-manual-input',
    'Manual input',
    F,
    130,
    60,
    (w, h) => fpoly(w, h, [[0, 0.32], [1, 0], [1, 1], [0, 1]]),
    (w, h) => pad(w, h, 6, h * 0.3, 6, 4),
    { keywords: ['keyboard', 'manual', 'input', 'form', 'entry'] }
  ),
  pathShape(
    'fc-delay',
    'Delay',
    F,
    110,
    60,
    (w, h) => {
      const rx = Math.min(w * 0.5, h * 0.5)
      return `M0,0 H${r(w - rx)} A${r(rx)},${r(h / 2)} 0 0 1 ${P(w - rx, h)} H0 Z`
    },
    (w, h) => pad(w, h, 6, 4, Math.min(w * 0.3, h * 0.3), 4),
    { keywords: ['wait', 'delay', 'pause', 'hold', 'timer'] }
  ),
  pathShape(
    'fc-display',
    'Display',
    F,
    130,
    60,
    (w, h) => {
      const k = w * 0.15
      const rx = Math.min(w * 0.15, h / 2)
      return `M0,${r(h / 2)} L${r(k)},0 H${r(w - rx)} A${r(rx)},${r(h / 2)} 0 0 1 ${P(w - rx, h)} H${r(k)} Z`
    },
    frac(0.16, 0.06, 0.14),
    { keywords: ['screen', 'monitor', 'display', 'output', 'show'] }
  ),
  pathShape(
    'fc-stored-data',
    'Stored data',
    F,
    130,
    60,
    (w, h) => {
      const k = w * 0.12
      return `M${r(k)},0 H${r(w)} A${r(k)},${r(h / 2)} 0 0 0 ${r(w)},${r(h)} H${r(k)} A${r(k)},${r(h / 2)} 0 0 1 ${r(k)},0 Z`
    },
    frac(0.14, 0.06, 0.16),
    { keywords: ['storage', 'stored', 'data', 'generic storage'] }
  ),
  shape(
    'fc-direct-access-storage',
    'Direct access storage',
    F,
    140,
    64,
    (w, h) => {
      const rx = Math.min(w * 0.16, h * 0.3)
      return {
        parts: [fill(cylH(w, h)), stroke(`M${r(w - rx)},0 A${r(rx)},${r(h / 2)} 0 0 0 ${P(w - rx, h)}`)],
        text: pad(w, h, rx + 4, 4, rx * 2 + 4, 4)
      }
    },
    { keywords: ['magnetic drum', 'drum', 'disk', 'hard drive', 'direct access', 'storage'], outline: cylH }
  ),
  pathShape(
    'fc-sequential-access',
    'Sequential access storage',
    F,
    80,
    80,
    (w, h) => `M${P(w / 2, h)} A${r(w / 2)},${r(h / 2)} 0 1 1 ${P(w, h / 2)} V${r(h)} Z`,
    frac(0.18, 0.18),
    { keywords: ['magnetic tape', 'tape', 'sequential', 'backup', 'reel'], aspectLocked: true }
  ),
  pathShape(
    'fc-off-page-connector',
    'Off-page connector',
    F,
    64,
    70,
    (w, h) => fpoly(w, h, [[0, 0], [1, 0], [1, 0.62], [0.5, 1], [0, 0.62]]),
    frac(0.08, 0.06, 0.08, 0.4),
    { keywords: ['off page', 'page reference', 'continue', 'goto', 'link'], defaultLabel: 'A' }
  ),
  pathShape(
    'fc-on-page-reference',
    'On-page reference',
    F,
    48,
    48,
    (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2),
    frac(0.15, 0.15),
    { keywords: ['connector', 'on page', 'junction', 'reference', 'circle', 'jump'], aspectLocked: true, defaultLabel: '1' }
  ),
  pathShape(
    'fc-card',
    'Punched card',
    F,
    120,
    70,
    (w, h) => {
      const k = Math.min(w, h) * 0.25
      return poly([[k, 0], [w, 0], [w, h], [0, h], [0, k]])
    },
    (w, h) => pad(w, h, Math.min(w, h) * 0.2, Math.min(w, h) * 0.12),
    { keywords: ['card', 'punched card', 'record'] }
  ),
  pathShape('fc-paper-tape', 'Paper tape', F, 130, 64, tape, frac(0.04, 0.26), {
    keywords: ['paper tape', 'punched tape', 'tape', 'flag']
  }),
  shape(
    'fc-punched-tape',
    'Punched tape',
    F,
    130,
    64,
    (w, h) => {
      const rr = Math.min(w, h) * 0.04
      return {
        parts: [
          fill(tape(w, h)),
          stroke(`${circle(w * 0.25, h * 0.5, rr)} ${circle(w * 0.5, h * 0.5, rr)} ${circle(w * 0.75, h * 0.5, rr)}`)
        ],
        text: pad(w, h, w * 0.04, h * 0.6, w * 0.04, h * 0.14)
      }
    },
    { keywords: ['punched tape', 'paper tape', 'holes', 'tape'] }
  ),
  pathShape(
    'fc-collate',
    'Collate',
    F,
    70,
    80,
    (w, h) => fpoly(w, h, [[0, 0], [1, 0], [0.5, 0.5], [1, 1], [0, 1], [0.5, 0.5]]),
    (w, h) => box(w, h, w * 0.25, 0, w * 0.5, h * 0.3),
    { keywords: ['collate', 'hourglass', 'organise', 'organize'] }
  ),
  shape(
    'fc-sort',
    'Sort',
    F,
    80,
    80,
    (w, h) => ({
      parts: [fill(fpoly(w, h, [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]])), stroke(line(0, h / 2, w, h / 2))],
      text: frac(0.25, 0.22, 0.25, 0.52)(w, h)
    }),
    { keywords: ['sort', 'order', 'arrange'] }
  ),
  pathShape(
    'fc-merge',
    'Merge',
    F,
    80,
    70,
    (w, h) => fpoly(w, h, [[0, 0], [1, 0], [0.5, 1]]),
    frac(0.25, 0.06, 0.25, 0.5),
    { keywords: ['merge', 'combine', 'join', 'funnel', 'storage'] }
  ),
  pathShape(
    'fc-extract',
    'Extract',
    F,
    80,
    70,
    (w, h) => fpoly(w, h, [[0.5, 0], [1, 1], [0, 1]]),
    frac(0.25, 0.5, 0.25, 0.06),
    { keywords: ['extract', 'split', 'triangle'] }
  ),
  shape(
    'fc-summing-junction',
    'Summing junction',
    F,
    56,
    56,
    (w, h) => {
      const k = 0.5 * Math.SQRT1_2
      return {
        parts: [
          fill(ellipse(w / 2, h / 2, w / 2, h / 2)),
          stroke(
            `${line(w * (0.5 - k), h * (0.5 - k), w * (0.5 + k), h * (0.5 + k))} ` +
              `${line(w * (0.5 + k), h * (0.5 - k), w * (0.5 - k), h * (0.5 + k))}`
          )
        ],
        text: box(w, h, 0, 0, 0, 0)
      }
    },
    { keywords: ['summing junction', 'and', 'sum', 'x circle'], aspectLocked: true }
  ),
  shape(
    'fc-or',
    'Or',
    F,
    56,
    56,
    (w, h) => ({
      parts: [
        fill(ellipse(w / 2, h / 2, w / 2, h / 2)),
        stroke(`${line(w / 2, 0, w / 2, h)} ${line(0, h / 2, w, h / 2)}`)
      ],
      text: box(w, h, 0, 0, 0, 0)
    }),
    { keywords: ['or', 'plus circle', 'logic', 'junction'], aspectLocked: true }
  ),
  pathShape(
    'fc-loop-limit',
    'Loop limit (start)',
    F,
    130,
    56,
    (w, h) => {
      const k = Math.min(w * 0.2, h * 0.4)
      return poly([[k, 0], [w - k, 0], [w, k], [w, h], [0, h], [0, k]])
    },
    (w, h) => pad(w, h, 8, 4),
    { keywords: ['loop', 'for', 'while', 'repeat', 'iteration', 'loop start'], defaultLabel: 'Loop' }
  ),
  pathShape(
    'fc-loop-limit-end',
    'Loop limit (end)',
    F,
    130,
    56,
    (w, h) => {
      const k = Math.min(w * 0.2, h * 0.4)
      return poly([[0, 0], [w, 0], [w, h - k], [w - k, h], [k, h], [0, h - k]])
    },
    (w, h) => pad(w, h, 8, 4),
    { keywords: ['loop end', 'end loop', 'repeat', 'iteration'], defaultLabel: 'End loop' }
  ),
  shape(
    'fc-annotation',
    'Annotation',
    F,
    140,
    60,
    (w, h) => {
      const bw = Math.min(w * 0.12, 14)
      return {
        parts: [none(bounds(w, h)), stroke(`M${r(bw)},0 H0 V${r(h)} H${r(bw)}`)],
        text: box(w, h, 6, 2, w - 8, h - 4)
      }
    },
    {
      keywords: ['comment', 'note', 'annotation', 'remark', 'bracket'],
      outline: bounds,
      defaultLabel: 'Comment',
      defaultStyle: { textAlign: 'left' }
    }
  ),
  pathShape(
    'fc-alternate-process',
    'Alternate process',
    F,
    120,
    56,
    (w, h) => rect(0, 0, w, h, Math.min(w, h) * 0.25),
    (w, h) => pad(w, h, 8, 4),
    { keywords: ['alternate', 'rounded process', 'alternative'] }
  ),
  shape(
    'fc-offline-storage',
    'Offline storage',
    F,
    80,
    72,
    (w, h) => ({
      parts: [fill(fpoly(w, h, [[0, 0], [1, 0], [0.5, 1]])), stroke(line(w * 0.4, h * 0.8, w * 0.6, h * 0.8))],
      text: frac(0.25, 0.06, 0.25, 0.5)(w, h)
    }),
    { keywords: ['offline', 'archive', 'file', 'storage', 'cold storage'] }
  ),
  pathShape(
    'fc-transfer',
    'Transfer',
    F,
    130,
    60,
    (w, h) => fpoly(w, h, [[0, 0.2], [0.72, 0.2], [0.72, 0], [1, 0.5], [0.72, 1], [0.72, 0.8], [0, 0.8]]),
    frac(0.04, 0.22, 0.3),
    { keywords: ['transfer', 'move', 'send', 'transmit', 'handoff'] }
  ),
  shape(
    'fc-parallel-mode',
    'Parallel mode',
    F,
    140,
    24,
    (w, h) => ({
      parts: [none(bounds(w, h)), stroke(`${line(0, h * 0.3, w, h * 0.3)} ${line(0, h * 0.7, w, h * 0.7)}`)],
      text: box(w, h, 0, 0, w, 0)
    }),
    { keywords: ['parallel', 'synchronise', 'synchronize', 'concurrent', 'fork'], outline: bounds, minH: 8 }
  ),
  shape(
    'fc-communication-link',
    'Communication link',
    F,
    140,
    40,
    (w, h) => ({
      parts: [
        none(bounds(w, h)),
        stroke(`M0,${r(h * 0.2)} L${P(w * 0.55, h * 0.2)} L${P(w * 0.45, h * 0.8)} L${P(w, h * 0.8)}`)
      ],
      text: box(w, h, 0, 0, 0, 0)
    }),
    { keywords: ['communication', 'link', 'telecom', 'zigzag', 'signal'], outline: bounds }
  ),
  pathShape(
    'fc-auxiliary-operation',
    'Auxiliary operation',
    F,
    80,
    80,
    (w, h) => rect(0, 0, w, h),
    (w, h) => pad(w, h, 6),
    { keywords: ['auxiliary', 'offline operation', 'square'], aspectLocked: true }
  ),
  pathShape(
    'fc-start-circle',
    'Start / end (circle)',
    F,
    64,
    64,
    (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2),
    frac(0.15, 0.15),
    { keywords: ['start', 'end', 'begin', 'stop', 'circle terminator'], aspectLocked: true, defaultLabel: 'Start' }
  )
]
