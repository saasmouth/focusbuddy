// Containers: swimlanes, pools, groups and frames that other shapes sit inside.
// Labels live in the header band, never in the body. Ids are saved in
// documents — never rename.

import { type ShapeDef, ellipse, line, r, rect } from './types'
import { P, PORTS_THIRDS, box, fill, pad, shade, shape, stroke } from './kit'

const C = 'Containers' as const

// Header band rounded only on its outer corners.
export function topBand(w: number, hb: number, k: number): string {
  const c = Math.min(k, w / 2, hb)
  return `M0,${r(hb)} V${r(c)} A${r(c)},${r(c)} 0 0 1 ${r(c)},0 H${r(w - c)} A${r(c)},${r(c)} 0 0 1 ${r(w)},${r(c)} V${r(hb)} Z`
}
export function leftBand(h: number, bw: number, k: number): string {
  const c = Math.min(k, h / 2, bw)
  return `M${r(bw)},0 H${r(c)} A${r(c)},${r(c)} 0 0 0 0,${r(c)} V${r(h - c)} A${r(c)},${r(c)} 0 0 0 ${r(c)},${r(h)} H${r(bw)} Z`
}

const band = (n: number, frac: number, max: number): number => Math.min(max, n * frac)

const base: Partial<ShapeDef> = { container: true, ports: PORTS_THIRDS }

export const CONTAINER_SHAPES: ShapeDef[] = [
  shape(
    'cont-lane-vertical',
    'Vertical swimlane',
    C,
    220,
    520,
    (w, h) => {
      const hb = band(h, 0.3, 32)
      return { parts: [fill(rect(0, 0, w, h, 6)), shade(topBand(w, hb, 6))], text: box(w, h, 4, 0, w - 8, hb) }
    },
    {
      ...base,
      keywords: ['swimlane', 'lane', 'column', 'vertical', 'band'],
      special: 'lane',
      minW: 60,
      minH: 120,
      defaultLabel: 'Lane'
    }
  ),
  shape(
    'cont-pool-h',
    'Pool (horizontal)',
    C,
    720,
    260,
    (w, h) => {
      const bw = band(w, 0.3, 32)
      return { parts: [fill(rect(0, 0, w, h, 4)), shade(leftBand(h, bw, 4))], text: box(w, h, 0, 4, bw, h - 8) }
    },
    {
      ...base,
      keywords: ['pool', 'swimlane', 'container', 'participant', 'horizontal'],
      special: 'lane',
      minW: 160,
      minH: 80,
      defaultLabel: 'Pool'
    }
  ),
  shape(
    'cont-pool-v',
    'Pool (vertical)',
    C,
    300,
    600,
    (w, h) => {
      const hb = band(h, 0.3, 32)
      return { parts: [fill(rect(0, 0, w, h, 4)), shade(topBand(w, hb, 4))], text: box(w, h, 4, 0, w - 8, hb) }
    },
    {
      ...base,
      keywords: ['pool', 'swimlane', 'container', 'participant', 'vertical'],
      special: 'lane',
      minW: 80,
      minH: 160,
      defaultLabel: 'Pool'
    }
  ),
  shape(
    'cont-pool-h-lanes',
    'Pool with 3 lanes',
    C,
    720,
    420,
    (w, h) => {
      const bw = band(w, 0.15, 32)
      const lw = band(w, 0.15, 28)
      const x1 = bw + lw
      return {
        parts: [
          fill(rect(0, 0, w, h, 4)),
          shade(leftBand(h, bw, 4)),
          stroke(
            `${line(bw, 0, bw, h)} ${line(x1, 0, x1, h)} ` +
              `${line(bw, h / 3, w, h / 3)} ${line(bw, (2 * h) / 3, w, (2 * h) / 3)}`
          )
        ],
        text: box(w, h, 0, 4, bw, h - 8)
      }
    },
    {
      ...base,
      keywords: ['pool', 'lanes', 'swimlane', 'cross functional', 'process map'],
      special: 'lane',
      minW: 200,
      minH: 120,
      defaultLabel: 'Pool'
    }
  ),
  shape(
    'cont-pool-v-lanes',
    'Vertical pool with 3 lanes',
    C,
    600,
    600,
    (w, h) => {
      const hb = band(h, 0.15, 32)
      const lh = band(h, 0.15, 28)
      const y1 = hb + lh
      return {
        parts: [
          fill(rect(0, 0, w, h, 4)),
          shade(topBand(w, hb, 4)),
          stroke(
            `${line(0, hb, w, hb)} ${line(0, y1, w, y1)} ` +
              `${line(w / 3, hb, w / 3, h)} ${line((2 * w) / 3, hb, (2 * w) / 3, h)}`
          )
        ],
        text: box(w, h, 4, 0, w - 8, hb)
      }
    },
    {
      ...base,
      keywords: ['pool', 'lanes', 'columns', 'swimlane', 'kanban', 'vertical'],
      special: 'lane',
      minW: 120,
      minH: 200,
      defaultLabel: 'Pool'
    }
  ),
  shape(
    'cont-rounded',
    'Rounded container',
    C,
    320,
    220,
    (w, h) => {
      const hb = band(h, 0.3, 28)
      return { parts: [fill(rect(0, 0, w, h, Math.min(w, h) * 0.08))], text: box(w, h, 12, 4, w - 24, hb - 4) }
    },
    { ...base, keywords: ['container', 'box', 'area', 'region', 'section', 'rounded'], minW: 60, minH: 40, defaultLabel: 'Container' }
  ),
  shape(
    'cont-group',
    'Group frame',
    C,
    320,
    220,
    (w, h) => {
      const hb = band(h, 0.3, 26)
      return { parts: [fill(rect(0, 0, w, h, 6))], text: box(w, h, 10, 2, w - 20, hb - 2) }
    },
    {
      ...base,
      keywords: ['group', 'dashed', 'boundary', 'cluster', 'frame', 'scope'],
      minW: 40,
      minH: 30,
      defaultLabel: 'Group',
      defaultStyle: { strokeDash: 'dashed', fill: 'none', textAlign: 'left' }
    }
  ),
  shape(
    'cont-card',
    'Card container',
    C,
    300,
    220,
    (w, h) => {
      const hb = band(h, 0.3, 30)
      return {
        parts: [fill(rect(0, 0, w, h, 8)), shade(topBand(w, hb, 8)), stroke(line(0, hb, w, hb))],
        text: box(w, h, 10, 0, w - 20, hb)
      }
    },
    {
      ...base,
      keywords: ['card', 'panel', 'title bar', 'window', 'container', 'header'],
      minW: 60,
      minH: 40,
      defaultLabel: 'Title',
      defaultStyle: { textAlign: 'left' }
    }
  ),
  shape(
    'cont-tab-frame',
    'Tabbed frame',
    C,
    320,
    220,
    (w, h) => {
      const th = band(h, 0.2, 24)
      const tw = Math.min(w * 0.45, 120)
      const s = Math.min(th * 0.6, tw * 0.2)
      return {
        parts: [
          fill(`M0,0 H${r(tw)} L${P(tw + s, th)} H${r(w)} V${r(h)} H0 Z`),
          shade(`M0,0 H${r(tw)} L${P(tw + s, th)} H0 Z`)
        ],
        text: box(w, h, 6, 0, tw - 6, th)
      }
    },
    {
      ...base,
      keywords: ['frame', 'tab', 'folder', 'section', 'named group'],
      minW: 60,
      minH: 40,
      defaultLabel: 'Frame',
      defaultStyle: { textAlign: 'left' }
    }
  ),
  shape(
    'cont-section',
    'Section',
    C,
    360,
    240,
    (w, h) => {
      const hb = band(h, 0.3, 28)
      return { parts: [fill(rect(0, 0, w, h)), stroke(line(0, hb, w, hb))], text: box(w, h, 8, 0, w - 16, hb) }
    },
    {
      ...base,
      keywords: ['section', 'area', 'zone', 'header', 'region'],
      minW: 60,
      minH: 40,
      defaultLabel: 'Section',
      defaultStyle: { textAlign: 'left' }
    }
  ),
  shape(
    'cont-phase',
    'Phase separator',
    C,
    720,
    120,
    (w, h) => {
      const hb = band(h, 0.3, 28)
      return {
        parts: [fill(rect(0, 0, w, h)), shade(rect(0, 0, w, hb)), stroke(`${line(w / 3, 0, w / 3, h)} ${line((2 * w) / 3, 0, (2 * w) / 3, h)}`)],
        text: box(w, h, 4, 0, w / 3 - 8, hb)
      }
    },
    {
      ...base,
      keywords: ['phase', 'stage', 'milestone', 'column header', 'timeline'],
      minW: 120,
      minH: 40,
      defaultLabel: 'Phase'
    }
  ),
  shape(
    'cont-quadrant',
    '2×2 matrix',
    C,
    400,
    400,
    (w, h) => {
      const hb = band(h, 0.2, 28)
      return {
        parts: [
          fill(rect(0, 0, w, h, 6)),
          stroke(`${line(w / 2, hb, w / 2, h)} ${line(0, hb + (h - hb) / 2, w, hb + (h - hb) / 2)} ${line(0, hb, w, hb)}`)
        ],
        text: box(w, h, 8, 0, w - 16, hb)
      }
    },
    {
      ...base,
      keywords: ['matrix', 'quadrant', 'swot', 'grid', 'four box', 'eisenhower'],
      minW: 80,
      minH: 80,
      defaultLabel: 'Matrix'
    }
  ),
  shape(
    'cont-circle',
    'Circular boundary',
    C,
    300,
    300,
    (w, h) => {
      return {
        parts: [fill(ellipse(w / 2, h / 2, w / 2, h / 2))],
        text: pad(w, h, w * 0.25, h * 0.08, w * 0.25, h * 0.78)
      }
    },
    {
      container: true,
      keywords: ['circle', 'boundary', 'system', 'context', 'scope', 'venn'],
      minW: 60,
      minH: 60,
      aspectLocked: true,
      defaultLabel: 'System'
    }
  )
]
