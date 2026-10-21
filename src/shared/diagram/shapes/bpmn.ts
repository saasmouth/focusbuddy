// BPMN 2.0: activities, events, gateways, data and artifacts, pools and lanes.
// Type markers (envelopes, clocks, gears…) are drawn as inner parts so the
// symbols read correctly in exports with no icon font. Ids are saved in
// documents — never rename.

import { type ShapeDef, ellipse, line, poly, r, rect } from './types'
import { P, PORTS_THIRDS, bounds, box, circle, ellipseRev, fill, folded, none, pad, shape, shade, solid, stroke } from './kit'

const B = 'BPMN' as const
const GREEN = '#16A34A'
const RED = '#DC2626'
const AMBER = '#D97706'

type Pt = [number, number]
type Part = ReturnType<typeof fill>

// Points given in a unit square, placed into the sub-box (x, y, s×s).
const place = (pts: Pt[], x: number, y: number, sw: number, sh = sw): Pt[] => pts.map(([u, v]) => [x + u * sw, y + v * sh])

// ── markers ────────────────────────────────────────────────────────────────
function envelope(x: number, y: number, ew: number, eh: number): string {
  return `${rect(x, y, ew, eh)} M${P(x, y)} L${P(x + ew / 2, y + eh * 0.55)} L${P(x + ew, y)}`
}
function personMark(x: number, y: number, s: number): string {
  return `${circle(x + s / 2, y + s * 0.28, s * 0.22)} M${P(x + s * 0.1, y + s)} Q${P(x + s * 0.1, y + s * 0.55)} ${P(x + s / 2, y + s * 0.55)} Q${P(x + s * 0.9, y + s * 0.55)} ${P(x + s * 0.9, y + s)} Z`
}
function gearMark(x: number, y: number, s: number): string {
  const cx = x + s / 2
  const cy = y + s / 2
  const spokes: string[] = []
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4
    spokes.push(line(cx + Math.cos(a) * s * 0.3, cy + Math.sin(a) * s * 0.3, cx + Math.cos(a) * s * 0.5, cy + Math.sin(a) * s * 0.5))
  }
  return `${circle(cx, cy, s * 0.32)} ${circle(cx, cy, s * 0.12)} ${spokes.join(' ')}`
}
function scriptMark(x: number, y: number, s: number): string {
  const ls: string[] = []
  for (const f of [0.3, 0.5, 0.7]) ls.push(line(x + s * 0.3, y + s * f, x + s * 0.75, y + s * f))
  return `M${P(x + s * 0.15, y)} H${r(x + s * 0.85)} Q${P(x + s * 0.7, y + s * 0.5)} ${P(x + s * 0.85, y + s)} H${r(x + s * 0.15)} Q${P(x + s * 0.3, y + s * 0.5)} ${P(x + s * 0.15, y)} Z ${ls.join(' ')}`
}
function handMark(x: number, y: number, s: number): string {
  // Open palm: four fingers and a thumb over a palm outline.
  const fingers: string[] = []
  for (let i = 0; i < 4; i++) {
    const fx = x + s * (0.3 + i * 0.16)
    fingers.push(line(fx, y + s * 0.5, fx, y + s * (i === 0 || i === 3 ? 0.18 : 0.05)))
  }
  return `M${P(x + s * 0.22, y + s * 0.5)} L${P(x, y + s * 0.38)} M${P(x + s * 0.22, y + s * 0.5)} V${r(y + s * 0.85)} Q${P(x + s * 0.3, y + s)} ${P(x + s * 0.55, y + s)} Q${P(x + s * 0.8, y + s)} ${P(x + s * 0.8, y + s * 0.8)} V${r(y + s * 0.5)} ${fingers.join(' ')}`
}
function tableMark(x: number, y: number, s: number): string {
  const eh = s * 0.75
  return `${rect(x, y, s, eh)} ${line(x, y + eh / 3, x + s, y + eh / 3)} ${line(x, y + (2 * eh) / 3, x + s, y + (2 * eh) / 3)} ${line(x + s * 0.3, y + eh / 3, x + s * 0.3, y + eh)}`
}
function plusBox(cx: number, by: number, s: number): string {
  const x = cx - s / 2
  const y = by - s
  return `${rect(x, y, s, s)} ${line(cx, y + s * 0.2, cx, y + s * 0.8)} ${line(x + s * 0.2, y + s / 2, x + s * 0.8, y + s / 2)}`
}

// ── activities ───────────────────────────────────────────────────────────────
const TASK_W = 130
const TASK_H = 80
const taskRadius = (w: number, h: number): number => Math.min(10, w * 0.12, h * 0.15)
const markSize = (w: number, h: number): number => Math.min(16, w * 0.16, h * 0.24)

function task(
  id: string,
  label: string,
  marker: ((w: number, h: number, m: number) => Part[]) | null,
  extra: Partial<ShapeDef> & { keywords: string[] }
): ShapeDef {
  return shape(
    id,
    label,
    B,
    TASK_W,
    TASK_H,
    (w, h) => {
      const m = markSize(w, h)
      const parts: Part[] = [fill(rect(0, 0, w, h, taskRadius(w, h)))]
      if (marker) parts.push(...marker(w, h, m))
      return { parts, text: pad(w, h, 6, marker ? m + 6 : 4, 6, 4) }
    },
    { defaultLabel: 'Task', ports: PORTS_THIRDS, ...extra, keywords: ['bpmn', 'activity', 'task', ...extra.keywords] }
  )
}
const at = (w: number, h: number): [number, number] => [Math.min(6, w * 0.06), Math.min(6, h * 0.08)]

// ── events ───────────────────────────────────────────────────────────────────
type EventKind = 'start' | 'intermediate' | 'end'
function event(
  id: string,
  label: string,
  kind: EventKind,
  marker: ((w: number, h: number) => Part[]) | null,
  keywords: string[]
): ShapeDef {
  return shape(
    id,
    label,
    B,
    40,
    40,
    (w, h) => {
      const parts: Part[] = [fill(ellipse(w / 2, h / 2, w / 2, h / 2))]
      if (kind === 'intermediate') parts.push(stroke(ellipse(w / 2, h / 2, w * 0.42, h * 0.42)))
      if (marker) parts.push(...marker(w, h))
      return { parts, text: box(w, h, w * 0.2, h * 0.2, w * 0.6, h * 0.6) }
    },
    {
      keywords: ['bpmn', 'event', 'circle', kind, ...keywords],
      aspectLocked: true,
      color: kind === 'start' ? GREEN : kind === 'end' ? RED : AMBER,
      defaultStyle: kind === 'end' ? { strokeWidth: 4 } : kind === 'start' ? { strokeWidth: 1.5 } : undefined
    }
  )
}
const evEnvelope = (filled: boolean) => (w: number, h: number): Part[] => {
  const d = envelope(w * 0.28, h * 0.34, w * 0.44, h * 0.32)
  return filled ? [solid(rect(w * 0.28, h * 0.34, w * 0.44, h * 0.32))] : [stroke(d)]
}
const evClock = (w: number, h: number): Part[] => [
  stroke(`${ellipse(w / 2, h / 2, w * 0.3, h * 0.3)} M${P(w / 2, h * 0.28)} L${P(w / 2, h / 2)} L${P(w * 0.66, h * 0.58)}`)
]
const evSignal = (filled: boolean) => (w: number, h: number): Part[] => {
  const d = poly(place([[0.5, 0], [1, 0.86], [0, 0.86]], w * 0.28, h * 0.26, w * 0.44, h * 0.44))
  return [filled ? solid(d) : stroke(d)]
}
const evError = (w: number, h: number): Part[] => [
  solid(poly(place([[0, 1], [0.3, 0.1], [0.62, 0.55], [1, 0], [0.7, 0.9], [0.38, 0.45]], w * 0.26, h * 0.26, w * 0.48, h * 0.48)))
]
const evConditional = (w: number, h: number): Part[] => {
  const x = w * 0.3
  const y = h * 0.28
  const s = w * 0.4
  const sh = h * 0.44
  return [stroke(`${rect(x, y, s, sh)} ${[0.25, 0.5, 0.75].map((f) => line(x + s * 0.15, y + sh * f, x + s * 0.85, y + sh * f)).join(' ')}`)]
}
const evTerminate = (w: number, h: number): Part[] => [solid(ellipse(w / 2, h / 2, w * 0.3, h * 0.3))]
const evEscalation = (w: number, h: number): Part[] => [
  stroke(poly(place([[0.5, 0], [0.9, 1], [0.5, 0.6], [0.1, 1]], w * 0.28, h * 0.24, w * 0.44, h * 0.5)))
]

// ── gateways ─────────────────────────────────────────────────────────────────
const diamond = (w: number, h: number): string => poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]])
function gateway(id: string, label: string, marker: ((w: number, h: number) => Part[]) | null, keywords: string[]): ShapeDef {
  return shape(
    id,
    label,
    B,
    50,
    50,
    (w, h) => {
      const parts: Part[] = [fill(diamond(w, h))]
      if (marker) parts.push(...marker(w, h))
      return { parts, text: box(w, h, w * 0.3, h * 0.3, w * 0.4, h * 0.4) }
    },
    { keywords: ['bpmn', 'gateway', 'diamond', 'split', 'merge', ...keywords], aspectLocked: true, color: AMBER }
  )
}
const plusPts = (t: number): Pt[] => [
  [0.5 - t, 0],
  [0.5 + t, 0],
  [0.5 + t, 0.5 - t],
  [1, 0.5 - t],
  [1, 0.5 + t],
  [0.5 + t, 0.5 + t],
  [0.5 + t, 1],
  [0.5 - t, 1],
  [0.5 - t, 0.5 + t],
  [0, 0.5 + t],
  [0, 0.5 - t],
  [0.5 - t, 0.5 - t]
]
const xPts = (t: number): Pt[] => [
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
]
const gwPlus = (w: number, h: number): Part[] => [solid(poly(place(plusPts(0.07), w * 0.27, h * 0.27, w * 0.46, h * 0.46)))]
const gwX = (w: number, h: number): Part[] => [solid(poly(place(xPts(0.1), w * 0.31, h * 0.31, w * 0.38, h * 0.38)))]
const gwO = (w: number, h: number): Part[] => [
  solid(`${ellipse(w / 2, h / 2, w * 0.22, h * 0.22)} ${ellipseRev(w / 2, h / 2, w * 0.16, h * 0.16)}`)
]
const gwEvent = (w: number, h: number): Part[] => [
  stroke(
    `${ellipse(w / 2, h / 2, w * 0.26, h * 0.26)} ${ellipse(w / 2, h / 2, w * 0.21, h * 0.21)} ` +
      poly(place([[0.5, 0], [1, 0.38], [0.81, 1], [0.19, 1], [0, 0.38]], w * 0.4, h * 0.39, w * 0.2, h * 0.2))
  )
]
const gwComplex = (w: number, h: number): Part[] => [
  solid(poly(place(plusPts(0.06), w * 0.27, h * 0.27, w * 0.46, h * 0.46))),
  solid(poly(place(xPts(0.085), w * 0.32, h * 0.32, w * 0.36, h * 0.36)))
]

export const BPMN_SHAPES: ShapeDef[] = [
  task('bpmn-task', 'Task', null, { keywords: ['step', 'work'] }),
  task('bpmn-user-task', 'User task', (w, h, m) => [stroke(personMark(...at(w, h), m))], { keywords: ['user', 'human', 'person'] }),
  task('bpmn-service-task', 'Service task', (w, h, m) => [stroke(gearMark(...at(w, h), m))], {
    keywords: ['service', 'automated', 'system', 'api', 'gear']
  }),
  task('bpmn-script-task', 'Script task', (w, h, m) => [stroke(scriptMark(...at(w, h), m))], { keywords: ['script', 'code', 'automation'] }),
  task('bpmn-manual-task', 'Manual task', (w, h, m) => [stroke(handMark(...at(w, h), m))], { keywords: ['manual', 'hand', 'offline', 'physical'] }),
  task(
    'bpmn-send-task',
    'Send task',
    (w, h, m) => {
      const [x, y] = at(w, h)
      return [solid(rect(x, y, m, m * 0.7))]
    },
    { keywords: ['send', 'message', 'email', 'notify', 'envelope'] }
  ),
  task(
    'bpmn-receive-task',
    'Receive task',
    (w, h, m) => {
      const [x, y] = at(w, h)
      return [stroke(envelope(x, y, m, m * 0.7))]
    },
    { keywords: ['receive', 'message', 'wait', 'inbox', 'envelope'] }
  ),
  task('bpmn-business-rule-task', 'Business rule task', (w, h, m) => [stroke(tableMark(...at(w, h), m))], {
    keywords: ['business rule', 'decision table', 'dmn', 'rule']
  }),
  task(
    'bpmn-subprocess',
    'Subprocess',
    (w, h, m) => [stroke(plusBox(w / 2, h - Math.min(4, h * 0.05), Math.min(m, 14)))],
    { keywords: ['subprocess', 'sub-process', 'collapsed', 'plus'], defaultLabel: 'Subprocess' }
  ),
  shape(
    'bpmn-subprocess-expanded',
    'Expanded subprocess',
    B,
    360,
    220,
    (w, h) => ({ parts: [fill(rect(0, 0, w, h, taskRadius(w, h)))], text: box(w, h, 10, 4, w - 20, Math.min(26, h * 0.3)) }),
    {
      keywords: ['bpmn', 'subprocess', 'expanded', 'container', 'sub-process'],
      container: true,
      ports: PORTS_THIRDS,
      defaultLabel: 'Subprocess',
      defaultStyle: { textAlign: 'left' },
      minW: 60,
      minH: 40
    }
  ),
  task('bpmn-call-activity', 'Call activity', (w, h, m) => [stroke(plusBox(w / 2, h - Math.min(5, h * 0.06), Math.min(m, 14)))], {
    keywords: ['call activity', 'reusable', 'global process', 'thick border'],
    defaultLabel: 'Call activity',
    defaultStyle: { strokeWidth: 4 }
  }),
  shape(
    'bpmn-transaction',
    'Transaction',
    B,
    TASK_W,
    TASK_H,
    (w, h) => {
      const k = Math.min(4, w * 0.05, h * 0.06)
      return {
        parts: [fill(rect(0, 0, w, h, taskRadius(w, h))), stroke(rect(k, k, w - 2 * k, h - 2 * k, Math.max(0, taskRadius(w, h) - k)))],
        text: pad(w, h, k + 6, k + 4)
      }
    },
    { keywords: ['bpmn', 'transaction', 'double border', 'atomic', 'compensation'], defaultLabel: 'Transaction', ports: PORTS_THIRDS }
  ),
  shape(
    'bpmn-event-subprocess',
    'Event subprocess',
    B,
    300,
    180,
    (w, h) => ({ parts: [fill(rect(0, 0, w, h, taskRadius(w, h)))], text: box(w, h, 10, 4, w - 20, Math.min(26, h * 0.3)) }),
    {
      keywords: ['bpmn', 'event subprocess', 'dotted', 'triggered', 'interrupting'],
      container: true,
      ports: PORTS_THIRDS,
      defaultLabel: 'Event subprocess',
      defaultStyle: { strokeDash: 'dotted', textAlign: 'left' },
      minW: 60,
      minH: 40
    }
  ),

  event('bpmn-start-event', 'Start event', 'start', null, ['start', 'begin', 'trigger']),
  event('bpmn-start-message', 'Message start event', 'start', evEnvelope(false), ['message', 'email', 'envelope', 'start']),
  event('bpmn-start-timer', 'Timer start event', 'start', evClock, ['timer', 'clock', 'schedule', 'time', 'cron']),
  event('bpmn-start-signal', 'Signal start event', 'start', evSignal(false), ['signal', 'broadcast', 'triangle']),
  event('bpmn-start-conditional', 'Conditional start event', 'start', evConditional, ['conditional', 'condition', 'rule']),
  event('bpmn-intermediate-event', 'Intermediate event', 'intermediate', null, ['intermediate', 'double ring', 'catch', 'throw']),
  event('bpmn-intermediate-message', 'Message intermediate event', 'intermediate', evEnvelope(false), ['message', 'catch', 'envelope']),
  event('bpmn-intermediate-timer', 'Timer intermediate event', 'intermediate', evClock, ['timer', 'wait', 'delay', 'clock']),
  event('bpmn-intermediate-signal', 'Signal intermediate event', 'intermediate', evSignal(true), ['signal', 'throw', 'broadcast']),
  event('bpmn-intermediate-escalation', 'Escalation event', 'intermediate', evEscalation, ['escalation', 'escalate']),
  event('bpmn-end-event', 'End event', 'end', null, ['end', 'stop', 'finish', 'thick ring']),
  event('bpmn-end-error', 'Error end event', 'end', evError, ['error', 'exception', 'failure', 'lightning']),
  event('bpmn-end-message', 'Message end event', 'end', evEnvelope(true), ['message', 'send', 'envelope', 'notify']),
  event('bpmn-end-terminate', 'Terminate end event', 'end', evTerminate, ['terminate', 'kill', 'abort', 'stop all']),

  gateway('bpmn-gateway-exclusive', 'Exclusive gateway', gwX, ['exclusive', 'xor', 'decision', 'x', 'either']),
  gateway('bpmn-gateway-parallel', 'Parallel gateway', gwPlus, ['parallel', 'and', 'fork', 'join', 'plus']),
  gateway('bpmn-gateway-inclusive', 'Inclusive gateway', gwO, ['inclusive', 'or', 'circle', 'any']),
  gateway('bpmn-gateway-event', 'Event-based gateway', gwEvent, ['event based', 'event-based', 'race', 'pentagon']),
  gateway('bpmn-gateway-complex', 'Complex gateway', gwComplex, ['complex', 'asterisk', 'custom']),
  gateway('bpmn-gateway', 'Gateway', null, ['gateway', 'plain', 'unspecified']),

  shape(
    'bpmn-data-object',
    'Data object',
    B,
    48,
    64,
    (w, h) => {
      const f = folded(w, h, Math.min(w, h) * 0.3)
      return { parts: [fill(f.body), shade(f.fold)], text: box(w, h, 0, h * 0.35, w, h * 0.5) }
    },
    { keywords: ['bpmn', 'data object', 'document', 'file', 'data', 'artifact'] }
  ),
  shape(
    'bpmn-data-input',
    'Data input',
    B,
    48,
    64,
    (w, h) => {
      const f = folded(w, h, Math.min(w, h) * 0.3)
      const s = Math.min(w, h) * 0.3
      return {
        parts: [
          fill(f.body),
          shade(f.fold),
          stroke(poly(place([[0, 0.3], [0.5, 0.3], [0.5, 0], [1, 0.5], [0.5, 1], [0.5, 0.7], [0, 0.7]], w * 0.08, h * 0.06, s, s * 0.8)))
        ],
        text: box(w, h, 0, h * 0.4, w, h * 0.5)
      }
    },
    { keywords: ['bpmn', 'data input', 'input', 'parameter', 'data object'] }
  ),
  shape(
    'bpmn-data-output',
    'Data output',
    B,
    48,
    64,
    (w, h) => {
      const f = folded(w, h, Math.min(w, h) * 0.3)
      const s = Math.min(w, h) * 0.3
      return {
        parts: [
          fill(f.body),
          shade(f.fold),
          solid(poly(place([[0, 0.3], [0.5, 0.3], [0.5, 0], [1, 0.5], [0.5, 1], [0.5, 0.7], [0, 0.7]], w * 0.08, h * 0.06, s, s * 0.8)))
        ],
        text: box(w, h, 0, h * 0.4, w, h * 0.5)
      }
    },
    { keywords: ['bpmn', 'data output', 'output', 'result', 'data object'] }
  ),
  shape(
    'bpmn-data-store',
    'Data store',
    B,
    64,
    60,
    (w, h) => {
      const ry = Math.min(h * 0.14, w * 0.25)
      const body = `M0,${r(ry)} A${r(w / 2)},${r(ry)} 0 0 1 ${r(w)},${r(ry)} V${r(h - ry)} A${r(w / 2)},${r(ry)} 0 0 1 0,${r(h - ry)} Z`
      const lid = (y: number): string => `M0,${r(y)} A${r(w / 2)},${r(ry)} 0 0 0 ${r(w)},${r(y)}`
      return {
        parts: [fill(body), stroke(`${lid(ry)} ${lid(ry * 1.6)} ${lid(ry * 2.2)}`)],
        text: pad(w, h, 4, ry * 3.2, 4, ry + 2)
      }
    },
    { keywords: ['bpmn', 'data store', 'database', 'storage', 'persistence', 'cylinder'] }
  ),
  shape(
    'bpmn-message',
    'Message',
    B,
    50,
    34,
    (w, h) => ({ parts: [fill(rect(0, 0, w, h)), stroke(`M0,0 L${P(w / 2, h * 0.55)} L${r(w)},0`)], text: box(w, h, 0, 0, 0, 0) }),
    { keywords: ['bpmn', 'message', 'envelope', 'mail', 'letter'] }
  ),
  shape(
    'bpmn-group',
    'Group',
    B,
    300,
    200,
    (w, h) => ({ parts: [fill(rect(0, 0, w, h, Math.min(10, w * 0.05, h * 0.05)))], text: box(w, h, 10, 4, w - 20, Math.min(24, h * 0.3)) }),
    {
      keywords: ['bpmn', 'group', 'category', 'dashed', 'cluster'],
      container: true,
      ports: PORTS_THIRDS,
      defaultLabel: 'Group',
      defaultStyle: { strokeDash: 'dashdot', fill: 'none', textAlign: 'left' },
      minW: 40,
      minH: 30
    }
  ),
  shape(
    'bpmn-text-annotation',
    'Text annotation',
    B,
    140,
    56,
    (w, h) => {
      const bw = Math.min(w * 0.12, 14)
      return { parts: [none(bounds(w, h)), stroke(`M${r(bw)},0 H0 V${r(h)} H${r(bw)}`)], text: box(w, h, 6, 2, w - 8, h - 4) }
    },
    {
      keywords: ['bpmn', 'annotation', 'comment', 'note', 'text'],
      outline: bounds,
      defaultLabel: 'Annotation',
      defaultStyle: { textAlign: 'left' }
    }
  ),
  shape(
    'bpmn-pool',
    'Pool',
    B,
    760,
    250,
    (w, h) => {
      const bw = Math.min(32, w * 0.3)
      return { parts: [fill(rect(0, 0, w, h)), shade(rect(0, 0, bw, h)), stroke(line(bw, 0, bw, h))], text: box(w, h, 0, 4, bw, h - 8) }
    },
    {
      keywords: ['bpmn', 'pool', 'participant', 'swimlane', 'organisation', 'organization'],
      container: true,
      special: 'lane',
      ports: PORTS_THIRDS,
      defaultLabel: 'Pool',
      minW: 160,
      minH: 60
    }
  ),
  shape(
    'bpmn-lane',
    'Lane',
    B,
    728,
    125,
    (w, h) => {
      const bw = Math.min(28, w * 0.3)
      return { parts: [fill(rect(0, 0, w, h)), stroke(line(bw, 0, bw, h))], text: box(w, h, 0, 4, bw, h - 8) }
    },
    {
      keywords: ['bpmn', 'lane', 'swimlane', 'role', 'department'],
      container: true,
      special: 'lane',
      ports: PORTS_THIRDS,
      defaultLabel: 'Lane',
      minW: 120,
      minH: 40
    }
  ),
  shape(
    'bpmn-conversation',
    'Conversation',
    B,
    50,
    44,
    (w, h) => ({
      parts: [fill(poly([[w * 0.25, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [w * 0.25, h], [0, h / 2]]))],
      text: box(w, h, w * 0.25, h * 0.2, w * 0.5, h * 0.6)
    }),
    { keywords: ['bpmn', 'conversation', 'hexagon', 'collaboration', 'exchange'], aspectLocked: true }
  )
]
