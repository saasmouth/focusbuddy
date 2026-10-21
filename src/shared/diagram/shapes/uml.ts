// UML 2: class, structure, use-case, activity, state and sequence notation plus
// the robustness (boundary / control / entity) icons. Ids are saved in
// documents — never rename.

import { type ShapeDef, ellipse, fpoly, line, poly, r, rect } from './types'
import {
  P,
  PORTS_THIRDS,
  arc,
  bounds,
  box,
  circle,
  fill,
  folded,
  none,
  pad,
  pathShape,
  shade,
  shape,
  solid,
  stroke
} from './kit'

const U = 'UML' as const

// Manually dashed vertical line (independent of the node's stroke style).
export function dashedV(x: number, y0: number, y1: number, dash = 6, gap = 4): string {
  const out: string[] = []
  const len = y1 - y0
  if (len <= 0) return line(x, y0, x, y0)
  const step = Math.max(dash + gap, len / 200)
  for (let y = y0; y < y1; y += step) out.push(line(x, y, x, Math.min(y + dash, y1)))
  return out.join(' ')
}
export function dashedH(y: number, x0: number, x1: number, dash = 6, gap = 4): string {
  const out: string[] = []
  const len = x1 - x0
  if (len <= 0) return line(x0, y, x0, y)
  const step = Math.max(dash + gap, len / 200)
  for (let x = x0; x < x1; x += step) out.push(line(x, y, Math.min(x + dash, x1), y))
  return out.join(' ')
}

// Classifier box with compartment dividers at the given fractions.
function classifier(
  id: string,
  label: string,
  dividers: number[],
  extra: Partial<ShapeDef> & { keywords: string[] },
  w = 180,
  h = 140
): ShapeDef {
  return shape(
    id,
    label,
    U,
    w,
    h,
    (W, H) => ({
      parts: [fill(rect(0, 0, W, H)), stroke(dividers.map((f) => line(0, H * f, W, H * f)).join(' '))],
      text: box(W, H, 4, 0, W - 8, H * dividers[0])
    }),
    { special: 'umlClass', ports: PORTS_THIRDS, minW: 40, minH: 30, ...extra }
  )
}

// Tag (pentagon) used on sequence frames and fragments.
function tagPath(w: number, h: number): { d: string; tw: number; th: number } {
  const tw = Math.min(w * 0.35, 70)
  const th = Math.min(h * 0.25, 22)
  const s = Math.min(th * 0.4, tw * 0.2)
  return { d: `M${r(tw)},0 V${r(th - s)} L${P(tw - s, th)} H0`, tw, th }
}

const iconArea = (h: number): number => h * 0.72

export const UML_SHAPES: ShapeDef[] = [
  classifier('uml-class', 'Class', [0.26, 0.6], {
    keywords: ['class', 'attributes', 'methods', 'operations', 'oop', 'object oriented'],
    defaultLabel: 'ClassName'
  }),
  classifier('uml-interface', 'Interface', [0.34], {
    keywords: ['interface', 'contract', 'protocol', 'stereotype'],
    defaultLabel: '«interface»\nName'
  }),
  classifier('uml-abstract-class', 'Abstract class', [0.26, 0.6], {
    keywords: ['abstract', 'class', 'base class', 'italic'],
    defaultLabel: 'AbstractClass',
    defaultStyle: { italic: true }
  }),
  classifier('uml-enumeration', 'Enumeration', [0.34], {
    keywords: ['enum', 'enumeration', 'values', 'literals'],
    defaultLabel: '«enumeration»\nName'
  }),
  classifier(
    'uml-object',
    'Object',
    [0.36],
    {
      keywords: ['object', 'instance', 'object diagram'],
      defaultLabel: 'obj : Class',
      defaultStyle: { underline: true }
    },
    160,
    90
  ),
  shape(
    'uml-actor',
    'Actor',
    U,
    56,
    100,
    (w, h) => {
      const ih = iconArea(h)
      const rr = Math.min(w * 0.18, ih * 0.13)
      const neck = rr * 2
      const hip = ih * 0.62
      return {
        parts: [
          none(bounds(w, h)),
          fill(circle(w / 2, rr, rr)),
          stroke(
            `${line(w / 2, neck, w / 2, hip)} ${line(w * 0.08, ih * 0.36, w * 0.92, ih * 0.36)} ` +
              `M${P(w * 0.14, ih)} L${P(w / 2, hip)} L${P(w * 0.86, ih)}`
          )
        ],
        text: box(w, h, 0, h * 0.76, w, h * 0.24)
      }
    },
    {
      keywords: ['actor', 'user', 'person', 'stick figure', 'role', 'stakeholder'],
      outline: (w, h) => rect(0, 0, w, iconArea(h)),
      defaultLabel: 'Actor',
      ports: [
        [0.5, 0],
        [1, 0.36],
        [0.5, 0.72],
        [0, 0.36]
      ]
    }
  ),
  pathShape(
    'uml-use-case',
    'Use case',
    U,
    150,
    70,
    (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2),
    (w, h) => pad(w, h, w * 0.14, h * 0.14),
    { keywords: ['use case', 'usecase', 'goal', 'feature', 'ellipse', 'scenario'], defaultLabel: 'Use case' }
  ),
  shape(
    'uml-component',
    'Component',
    U,
    160,
    90,
    (w, h) => {
      const tw = Math.min(w * 0.14, 20)
      const th = Math.min(h * 0.14, 12)
      const x0 = tw / 2
      return {
        parts: [
          fill(rect(x0, 0, w - x0, h)),
          fill(rect(0, h * 0.22, tw, th)),
          fill(rect(0, h * 0.22 + th * 1.6, tw, th))
        ],
        text: pad(w, h, tw + 6, 4)
      }
    },
    {
      keywords: ['component', 'module', 'service', 'library', 'package'],
      defaultLabel: 'Component',
      outline: bounds,
      ports: PORTS_THIRDS
    }
  ),
  shape(
    'uml-package',
    'Package',
    U,
    170,
    110,
    (w, h) => {
      const tw = w * 0.4
      const th = Math.min(h * 0.18, 20)
      return {
        parts: [fill(`M0,0 H${r(tw)} V${r(th)} H${r(w)} V${r(h)} H0 Z`), stroke(line(0, th, tw, th))],
        text: pad(w, h, 6, th + 4, 6, 4)
      }
    },
    { keywords: ['package', 'namespace', 'folder', 'module', 'group'], defaultLabel: 'package', container: true, ports: PORTS_THIRDS }
  ),
  shape(
    'uml-node',
    'Node',
    U,
    150,
    100,
    (w, h) => {
      const d = Math.min(w, h) * 0.14
      return {
        parts: [
          fill(`M0,${r(d)} L${r(d)},0 H${r(w)} V${r(h - d)} L${P(w - d, h)} H0 Z`),
          shade(`M${P(w - d, d)} L${r(w)},0 V${r(h - d)} L${P(w - d, h)} Z`),
          stroke(`M0,${r(d)} H${r(w - d)} L${r(w)},0 M${r(w - d)},${r(d)} V${r(h)}`)
        ],
        text: pad(w, h, 6, d + 4, d + 6, 4)
      }
    },
    { keywords: ['node', 'device', 'execution environment', 'deployment', 'server', '3d box'], defaultLabel: 'Node', container: true }
  ),
  shape(
    'uml-artifact',
    'Artifact',
    U,
    130,
    80,
    (w, h) => {
      const f = folded(w, h, Math.min(w, h) * 0.2)
      return {
        parts: [fill(f.body), shade(f.fold)],
        text: pad(w, h, 6, Math.min(w, h) * 0.2 + 2, 6, 4)
      }
    },
    { keywords: ['artifact', 'file', 'jar', 'executable', 'build', 'deployment'], defaultLabel: '«artifact»\nfile' }
  ),
  shape(
    'uml-note',
    'Note',
    U,
    140,
    80,
    (w, h) => {
      const f = folded(w, h, Math.min(w, h) * 0.2)
      return { parts: [fill(f.body), shade(f.fold)], text: pad(w, h, 8, 6, Math.min(w, h) * 0.2 + 4, 6) }
    },
    { keywords: ['note', 'comment', 'annotation', 'remark'], defaultLabel: 'Note', defaultStyle: { textAlign: 'left' } }
  ),
  shape(
    'uml-lifeline',
    'Lifeline',
    U,
    120,
    320,
    (w, h) => {
      const hh = Math.min(h * 0.18, 40)
      return { parts: [fill(rect(0, 0, w, hh)), stroke(dashedV(w / 2, hh, h))], text: pad(w, h, 4, 2, 4, h - hh + 2) }
    },
    {
      keywords: ['lifeline', 'sequence', 'participant', 'object', 'timeline'],
      defaultLabel: 'Participant',
      minH: 40,
      outline: (w, h) => {
        const hh = Math.min(h * 0.18, 40)
        const s = Math.min(4, w / 4)
        return poly([
          [0, 0],
          [w, 0],
          [w, hh],
          [w / 2 + s, hh],
          [w / 2 + s, h],
          [w / 2 - s, h],
          [w / 2 - s, hh],
          [0, hh]
        ])
      },
      ports: [
        [0.5, 0],
        [0.5, 1],
        [0, 0.06],
        [1, 0.06],
        [0.5, 0.25],
        [0.5, 0.4],
        [0.5, 0.55],
        [0.5, 0.7],
        [0.5, 0.85]
      ]
    }
  ),
  pathShape('uml-activation', 'Activation bar', U, 16, 90, (w, h) => rect(0, 0, w, h), (w, h) => box(w, h, 0, 0, 0, 0), {
    keywords: ['activation', 'execution', 'focus of control', 'sequence'],
    minW: 8,
    minH: 16,
    ports: [
      [0.5, 0],
      [1, 0.25],
      [1, 0.5],
      [1, 0.75],
      [0.5, 1],
      [0, 0.75],
      [0, 0.5],
      [0, 0.25]
    ]
  }),
  pathShape(
    'uml-state',
    'State',
    U,
    130,
    60,
    (w, h) => rect(0, 0, w, h, Math.min(w, h) * 0.3),
    (w, h) => pad(w, h, 10, 4),
    { keywords: ['state', 'status', 'state machine', 'mode'], defaultLabel: 'State' }
  ),
  shape(
    'uml-state-composite',
    'Composite state',
    U,
    260,
    180,
    (w, h) => {
      const hb = Math.min(h * 0.25, 28)
      return { parts: [fill(rect(0, 0, w, h, Math.min(w, h) * 0.12)), stroke(line(0, hb, w, hb))], text: pad(w, h, 10, 2, 10, h - hb + 2) }
    },
    { keywords: ['composite state', 'superstate', 'nested', 'region'], defaultLabel: 'State', container: true, ports: PORTS_THIRDS }
  ),
  shape(
    'uml-initial',
    'Initial state',
    U,
    28,
    28,
    (w, h) => ({ parts: [solid(ellipse(w / 2, h / 2, w / 2, h / 2))], text: box(w, h, 0, 0, 0, 0) }),
    {
      keywords: ['initial', 'start', 'begin', 'initial node', 'pseudostate', 'black circle'],
      aspectLocked: true,
      outline: (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2)
    }
  ),
  shape(
    'uml-final',
    'Final state',
    U,
    32,
    32,
    (w, h) => ({
      parts: [fill(ellipse(w / 2, h / 2, w / 2, h / 2)), solid(ellipse(w / 2, h / 2, w * 0.3, h * 0.3))],
      text: box(w, h, 0, 0, 0, 0)
    }),
    { keywords: ['final', 'end', 'stop', 'final node', 'bullseye', 'activity final'], aspectLocked: true }
  ),
  shape(
    'uml-flow-final',
    'Flow final',
    U,
    32,
    32,
    (w, h) => {
      const k = 0.5 * Math.SQRT1_2
      return {
        parts: [
          fill(ellipse(w / 2, h / 2, w / 2, h / 2)),
          stroke(`${line(w * (0.5 - k), h * (0.5 - k), w * (0.5 + k), h * (0.5 + k))} ${line(w * (0.5 + k), h * (0.5 - k), w * (0.5 - k), h * (0.5 + k))}`)
        ],
        text: box(w, h, 0, 0, 0, 0)
      }
    },
    { keywords: ['flow final', 'end flow', 'x circle', 'terminate flow'], aspectLocked: true }
  ),
  shape(
    'uml-fork',
    'Fork / join bar',
    U,
    140,
    8,
    (w, h) => ({ parts: [solid(rect(0, 0, w, h))], text: box(w, h, 0, 0, 0, 0) }),
    {
      keywords: ['fork', 'join', 'synchronisation', 'synchronization', 'bar', 'parallel'],
      minH: 4,
      outline: (w, h) => rect(0, 0, w, h),
      ports: [
        [0.5, 0],
        [0.25, 0],
        [0.75, 0],
        [0.5, 1],
        [0.25, 1],
        [0.75, 1],
        [0, 0.5],
        [1, 0.5]
      ]
    }
  ),
  shape(
    'uml-fork-vertical',
    'Fork / join bar (vertical)',
    U,
    8,
    140,
    (w, h) => ({ parts: [solid(rect(0, 0, w, h))], text: box(w, h, 0, 0, 0, 0) }),
    {
      keywords: ['fork', 'join', 'synchronisation', 'synchronization', 'bar', 'vertical'],
      minW: 4,
      outline: (w, h) => rect(0, 0, w, h),
      ports: [
        [0, 0.5],
        [0, 0.25],
        [0, 0.75],
        [1, 0.5],
        [1, 0.25],
        [1, 0.75],
        [0.5, 0],
        [0.5, 1]
      ]
    }
  ),
  pathShape(
    'uml-decision',
    'Decision / merge',
    U,
    40,
    40,
    (w, h) => fpoly(w, h, [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]),
    (w, h) => box(w, h, 0, 0, 0, 0),
    { keywords: ['decision', 'merge', 'branch', 'diamond', 'choice', 'guard'], aspectLocked: true }
  ),
  pathShape(
    'uml-action',
    'Action',
    U,
    130,
    56,
    (w, h) => rect(0, 0, w, h, Math.min(w, h) * 0.25),
    (w, h) => pad(w, h, 8, 4),
    { keywords: ['action', 'activity', 'step', 'task'], defaultLabel: 'Action' }
  ),
  pathShape(
    'uml-send-signal',
    'Send signal',
    U,
    140,
    56,
    (w, h) => {
      const k = Math.min(w * 0.25, h * 0.5)
      return poly([[0, 0], [w - k, 0], [w, h / 2], [w - k, h], [0, h]])
    },
    (w, h) => pad(w, h, 6, 4, Math.min(w * 0.25, h * 0.5) * 0.6, 4),
    { keywords: ['send', 'signal', 'emit', 'event', 'message out'], defaultLabel: 'Send' }
  ),
  pathShape(
    'uml-receive-signal',
    'Receive signal',
    U,
    140,
    56,
    (w, h) => {
      const k = Math.min(w * 0.25, h * 0.5)
      return poly([[0, 0], [w, 0], [w, h], [0, h], [k, h / 2]])
    },
    (w, h) => pad(w, h, Math.min(w * 0.25, h * 0.5) + 4, 4, 6, 4),
    { keywords: ['receive', 'accept event', 'signal', 'message in', 'wait'], defaultLabel: 'Receive' }
  ),
  shape(
    'uml-time-event',
    'Time event',
    U,
    40,
    56,
    (w, h) => {
      const ih = iconArea(h)
      return {
        parts: [fill(poly([[0, 0], [w, 0], [w / 2, ih / 2], [w, ih], [0, ih], [w / 2, ih / 2]]))],
        text: box(w, h, 0, h * 0.76, w, h * 0.24)
      }
    },
    { keywords: ['time', 'timer', 'wait', 'hourglass', 'accept time event'], outline: bounds }
  ),
  shape(
    'uml-boundary',
    'Boundary',
    U,
    80,
    80,
    (w, h) => {
      const ih = iconArea(h)
      const rr = Math.min(w * 0.3, ih * 0.45)
      const cx = w - rr - 1
      const cy = ih / 2
      const x0 = Math.min(w * 0.08, cx - rr)
      return {
        parts: [
          none(bounds(w, h)),
          fill(circle(cx, cy, rr)),
          stroke(`${line(x0, cy - rr, x0, cy + rr)} ${line(x0, cy, cx - rr, cy)}`)
        ],
        text: box(w, h, 0, h * 0.74, w, h * 0.26)
      }
    },
    {
      keywords: ['boundary', 'robustness', 'interface', 'ui', 'screen', 'ecb'],
      outline: (w, h) => rect(0, 0, w, iconArea(h)),
      defaultLabel: 'Boundary',
      aspectLocked: true
    }
  ),
  shape(
    'uml-control',
    'Control',
    U,
    80,
    80,
    (w, h) => {
      const ih = iconArea(h)
      const rr = Math.min(w * 0.4, ih * 0.4)
      const cx = w / 2
      const cy = ih / 2 + ih * 0.04
      const a = rr * 0.35
      return {
        parts: [
          fill(circle(cx, cy, rr)),
          stroke(`M${P(cx + a * 0.6, cy - rr - a)} L${P(cx - a * 0.6, cy - rr)} L${P(cx + a * 0.6, cy - rr + a)}`)
        ],
        text: box(w, h, 0, h * 0.74, w, h * 0.26)
      }
    },
    {
      keywords: ['control', 'controller', 'robustness', 'logic', 'ecb'],
      outline: (w, h) => rect(0, 0, w, iconArea(h)),
      defaultLabel: 'Control',
      aspectLocked: true
    }
  ),
  shape(
    'uml-entity',
    'Entity',
    U,
    80,
    80,
    (w, h) => {
      const ih = iconArea(h)
      const rr = Math.min(w * 0.4, ih * 0.44)
      const cx = w / 2
      const cy = ih / 2 - ih * 0.04
      return {
        parts: [fill(circle(cx, cy, rr)), stroke(line(cx - rr, cy + rr, cx + rr, cy + rr))],
        text: box(w, h, 0, h * 0.74, w, h * 0.26)
      }
    },
    {
      keywords: ['entity', 'robustness', 'data', 'model', 'domain object', 'ecb'],
      outline: (w, h) => rect(0, 0, w, iconArea(h)),
      defaultLabel: 'Entity',
      aspectLocked: true
    }
  ),
  shape(
    'uml-frame',
    'Sequence frame',
    U,
    420,
    300,
    (w, h) => {
      const t = tagPath(w, h)
      return { parts: [fill(rect(0, 0, w, h)), stroke(t.d)], text: box(w, h, 4, 0, t.tw - 8, t.th) }
    },
    {
      keywords: ['frame', 'sd', 'sequence diagram', 'interaction', 'diagram frame'],
      defaultLabel: 'sd Name',
      container: true,
      ports: PORTS_THIRDS,
      defaultStyle: { fill: 'none', textAlign: 'left' }
    }
  ),
  shape(
    'uml-fragment',
    'Combined fragment',
    U,
    360,
    200,
    (w, h) => {
      const t = tagPath(w, h)
      return {
        parts: [fill(rect(0, 0, w, h)), stroke(t.d), stroke(dashedH(h * 0.55, 0, w))],
        text: box(w, h, 4, 0, t.tw - 8, t.th)
      }
    },
    {
      keywords: ['fragment', 'alt', 'opt', 'loop', 'par', 'break', 'combined fragment', 'interaction operand'],
      defaultLabel: 'alt',
      container: true,
      ports: PORTS_THIRDS,
      defaultStyle: { fill: 'none', textAlign: 'left' }
    }
  ),
  shape(
    'uml-ref',
    'Interaction use (ref)',
    U,
    300,
    80,
    (w, h) => {
      const t = tagPath(w, h)
      return { parts: [fill(rect(0, 0, w, h)), stroke(t.d)], text: pad(w, h, 8, t.th + 2, 8, 4) }
    },
    { keywords: ['ref', 'reference', 'interaction use', 'sub sequence'], defaultLabel: 'ref Name' }
  ),
  shape(
    'uml-provided-interface',
    'Provided interface',
    U,
    60,
    24,
    (w, h) => {
      const rr = Math.min(h / 2, w * 0.25)
      return {
        parts: [none(bounds(w, h)), fill(circle(w - rr, h / 2, rr)), stroke(line(0, h / 2, w - 2 * rr, h / 2))],
        text: box(w, h, 0, 0, 0, 0)
      }
    },
    { keywords: ['lollipop', 'provided interface', 'ball', 'realisation', 'realization'], outline: bounds }
  ),
  shape(
    'uml-required-interface',
    'Required interface',
    U,
    60,
    24,
    (w, h) => {
      const rr = Math.min(h / 2, w * 0.25)
      return {
        parts: [none(bounds(w, h)), stroke(`${arc(w, h / 2, rr, rr, 90, 270)} ${line(0, h / 2, w - rr, h / 2)}`)],
        text: box(w, h, 0, 0, 0, 0)
      }
    },
    { keywords: ['socket', 'required interface', 'dependency', 'usage'], outline: bounds }
  ),
  pathShape('uml-port', 'Port', U, 16, 16, (w, h) => rect(0, 0, w, h), (w, h) => box(w, h, 0, 0, 0, 0), {
    keywords: ['port', 'interaction point', 'square'],
    aspectLocked: true,
    minW: 8,
    minH: 8
  }),
  pathShape(
    'uml-history',
    'History state',
    U,
    32,
    32,
    (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2),
    (w, h) => pad(w, h, w * 0.15, h * 0.15),
    { keywords: ['history', 'shallow history', 'pseudostate', 'H'], aspectLocked: true, defaultLabel: 'H' }
  ),
  shape(
    'uml-junction',
    'Junction',
    U,
    16,
    16,
    (w, h) => ({ parts: [solid(ellipse(w / 2, h / 2, w / 2, h / 2))], text: box(w, h, 0, 0, 0, 0) }),
    {
      keywords: ['junction', 'pseudostate', 'dot', 'merge point'],
      aspectLocked: true,
      minW: 8,
      minH: 8,
      outline: (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2)
    }
  ),
  shape(
    'uml-terminate',
    'Terminate',
    U,
    28,
    28,
    (w, h) => ({ parts: [none(bounds(w, h)), stroke(`${line(0, 0, w, h)} ${line(w, 0, 0, h)}`)], text: box(w, h, 0, 0, 0, 0) }),
    { keywords: ['terminate', 'destroy', 'x', 'destruction', 'kill'], aspectLocked: true, outline: bounds }
  ),
  shape(
    'uml-part',
    'Composite structure part',
    U,
    160,
    90,
    (w, h) => ({
      parts: [fill(rect(0, 0, w, h)), stroke(rect(Math.min(8, w * 0.1), Math.min(8, h * 0.1), w - 2 * Math.min(8, w * 0.1), h - 2 * Math.min(8, h * 0.1)))],
      text: pad(w, h, Math.min(8, w * 0.1) + 4, Math.min(8, h * 0.1) + 2)
    }),
    { keywords: ['part', 'composite structure', 'property', 'role'], defaultLabel: 'part : Type' }
  ),
  pathShape(
    'uml-entry-point',
    'Entry point',
    U,
    20,
    20,
    (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2),
    (w, h) => box(w, h, 0, 0, 0, 0),
    { keywords: ['entry point', 'connection point', 'pseudostate'], aspectLocked: true, minW: 8, minH: 8 }
  ),
  shape(
    'uml-exit-point',
    'Exit point',
    U,
    20,
    20,
    (w, h) => {
      const k = 0.5 * Math.SQRT1_2
      return {
        parts: [
          fill(ellipse(w / 2, h / 2, w / 2, h / 2)),
          stroke(`${line(w * (0.5 - k), h * (0.5 - k), w * (0.5 + k), h * (0.5 + k))} ${line(w * (0.5 + k), h * (0.5 - k), w * (0.5 - k), h * (0.5 + k))}`)
        ],
        text: box(w, h, 0, 0, 0, 0)
      }
    },
    { keywords: ['exit point', 'connection point', 'pseudostate'], aspectLocked: true, minW: 8, minH: 8 }
  )
]
