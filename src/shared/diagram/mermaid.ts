// Mermaid ⇄ PlexiDiagrams. Pure string ⇄ MapNode/MapEdge — no DOM, so it runs in
// the renderer and the main process alike.
//
// Import (mermaidToMap) understands:
//   flowchart / graph  TD TB LR RL BT
//     node shapes  [rect] (rounded) ([stadium]) [[subroutine]] [(database)]
//                  ((circle)) (((double circle))) >asymmetric] {decision}
//                  {{hexagon}} [/parallelogram/] [\alt\] [/trapezoid\] [\inv/]
//                  and the v11 form  A@{ shape: rect, label: "Text" }
//     edges        --> --- -.-> -.- ==> === --o --x <--> o--o x--x ~~~,
//                  longer variants (---->), |label| and -- label --> forms,
//                  chains A-->B-->C, & fan-out/fan-in
//     subgraph id [Title] … end  → 'lane' container, members get parentId
//     classDef / class / ::: / style  → fill, stroke, colour, stroke-width, dash
//     click id "url"  → node.link;  %% comments, ; separators, front matter
//   erDiagram    entities, attribute blocks, relationships with crow's-foot ends
//   classDiagram classes, members, all relationship arrows, cardinality labels
// Anything not understood becomes a warning; the parser never throws.
//
// Export (mapToMermaid) emits a flowchart with matching shapes, quoted/escaped
// labels, edge labels, dashed/thick/arrowhead styles, subgraphs for containers,
// and style lines for fill/stroke colours.

import type { MapArrowHead, MapEdge, MapNode, MapNodeStyle } from '../types'
import { getShape, isShapeId } from './shapes'
import { layoutDiagram, type LayoutDirection } from './layout'
import { nodeSize } from './geom'

export interface MermaidImport {
  nodes: MapNode[]
  edges: MapEdge[]
  warnings: string[]
}

const DEFAULT_COLOR = '#2563eb'
const LANE_PAD = 24
const LANE_BAND = 32 // the lane's title band on its left edge (legacy 'lane' draws it 28px wide)

// First registered id from a preference list; the last entry is always a legacy id.
function pick(...ids: string[]): string {
  for (const id of ids) if (isShapeId(id)) return id
  return ids[ids.length - 1] ?? 'process'
}

// ── Mermaid shape vocabulary ────────────────────────────────────────────────

type MShape =
  | 'rect'
  | 'rounded'
  | 'stadium'
  | 'subroutine'
  | 'database'
  | 'circle'
  | 'doublecircle'
  | 'asymmetric'
  | 'decision'
  | 'hexagon'
  | 'parallelogram'
  | 'parallelogram-alt'
  | 'trapezoid'
  | 'trapezoid-alt'
  | 'document'

interface ShapeChoice {
  shape: string
  flipX?: boolean
  flipY?: boolean
  style?: MapNodeStyle
}

function shapeFor(m: MShape): ShapeChoice {
  switch (m) {
    case 'rect':
      return { shape: 'process' }
    case 'rounded': {
      const s = pick('fc-alternate-process', 'basic-rounded-rectangle', 'process')
      return s === 'process' ? { shape: s, style: { radius: 14 } } : { shape: s }
    }
    case 'stadium':
      return { shape: 'terminator' }
    case 'subroutine':
      return { shape: pick('fc-predefined-process', 'fc-predefined', 'fc-subroutine', 'predefined-process', 'subroutine', 'process') }
    case 'database':
      return { shape: pick('fc-database', 'database') }
    case 'circle':
      return { shape: 'circle' }
    case 'doublecircle':
      return { shape: pick('fc-double-circle', 'double-circle', 'doublecircle', 'circle') }
    case 'asymmetric':
      return { shape: pick('fc-asymmetric', 'asymmetric', 'process') }
    case 'decision':
      return { shape: 'decision' }
    case 'hexagon':
      return { shape: 'hexagon' }
    case 'parallelogram':
      return { shape: 'data' }
    case 'parallelogram-alt': {
      const s = pick('fc-data-alt', 'parallelogram-alt', 'data')
      return s === 'data' ? { shape: s, flipX: true } : { shape: s }
    }
    case 'trapezoid':
      return { shape: 'trapezoid' }
    case 'trapezoid-alt': {
      const s = pick('fc-manual-operation', 'trapezoid-alt', 'trapezoid')
      return s === 'trapezoid' ? { shape: s, flipY: true } : { shape: s }
    }
    case 'document':
      return { shape: pick('fc-document', 'document', 'process') }
  }
}

// v11 `@{ shape: … }` names → classic shapes.
const V11_SHAPES: Record<string, MShape> = {
  rect: 'rect',
  rectangle: 'rect',
  proc: 'rect',
  process: 'rect',
  rounded: 'rounded',
  event: 'rounded',
  stadium: 'stadium',
  pill: 'stadium',
  terminal: 'stadium',
  subproc: 'subroutine',
  subroutine: 'subroutine',
  'framed-rectangle': 'subroutine',
  cyl: 'database',
  cylinder: 'database',
  database: 'database',
  db: 'database',
  circle: 'circle',
  circ: 'circle',
  'dbl-circ': 'doublecircle',
  'double-circle': 'doublecircle',
  diam: 'decision',
  diamond: 'decision',
  decision: 'decision',
  question: 'decision',
  hex: 'hexagon',
  hexagon: 'hexagon',
  prepare: 'hexagon',
  'lean-r': 'parallelogram',
  'in-out': 'parallelogram',
  'lean-l': 'parallelogram-alt',
  'out-in': 'parallelogram-alt',
  'trap-b': 'trapezoid',
  priority: 'trapezoid',
  'trap-t': 'trapezoid-alt',
  manual: 'trapezoid-alt',
  doc: 'document',
  document: 'document',
  odd: 'asymmetric'
}

// Bracket openers, longest first, with their closer and shape. The two slanted
// openers have two possible closers each.
const OPENERS: { open: string; close: string; shape: MShape }[] = [
  { open: '(((', close: ')))', shape: 'doublecircle' },
  { open: '([', close: '])', shape: 'stadium' },
  { open: '[[', close: ']]', shape: 'subroutine' },
  { open: '[(', close: ')]', shape: 'database' },
  { open: '((', close: '))', shape: 'circle' },
  { open: '{{', close: '}}', shape: 'hexagon' },
  { open: '[/', close: '/]', shape: 'parallelogram' },
  { open: '[/', close: '\\]', shape: 'trapezoid' },
  { open: '[\\', close: '\\]', shape: 'parallelogram-alt' },
  { open: '[\\', close: '/]', shape: 'trapezoid-alt' },
  { open: '[', close: ']', shape: 'rect' },
  { open: '(', close: ')', shape: 'rounded' },
  { open: '{', close: '}', shape: 'decision' },
  { open: '>', close: ']', shape: 'asymmetric' }
]

// ── text helpers ────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  amp: '&',
  lt: '<',
  gt: '>',
  apos: "'",
  nbsp: ' ',
  num: '#',
  semi: ';',
  colon: ':',
  vert: '|',
  lpar: '(',
  rpar: ')',
  lsqb: '[',
  rsqb: ']',
  lcub: '{',
  rcub: '}'
}

// Mermaid label text → plain text: #quot; / #35; entities, <br> → newline,
// markdown-string backticks and remaining tags removed.
function cleanLabel(raw: string): string {
  let s = raw.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1)
  if (s.length >= 2 && s.startsWith('`') && s.endsWith('`')) s = s.slice(1, -1)
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/\\n/g, '\n')
  s = s.replace(/<\/?[a-z][^>]*>/gi, '')
  s = s.replace(/[#&](\w+);/g, (m, name: string) => {
    if (/^\d+$/.test(name)) return String.fromCodePoint(Number(name))
    if (/^x[0-9a-f]+$/i.test(name)) return String.fromCodePoint(parseInt(name.slice(1), 16))
    return NAMED_ENTITIES[name.toLowerCase()] ?? m
  })
  s = s.replace(/\*\*(.+?)\*\*/g, '$1')
  return s
}

// Split a line on `;` outside quotes and brackets.
function splitStatements(line: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = false
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '"') quote = !quote
    else if (!quote) {
      if ('([{'.includes(ch)) depth++
      else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1)
      else if (ch === ';' && depth === 0) {
        // `#quot;`-style entities end in ';' — keep those.
        if (!/#\w+$/.test(cur)) {
          out.push(cur)
          cur = ''
          continue
        }
      }
    }
    cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

// Strip %% comments (outside quotes) and directives.
function stripComment(line: string): string {
  let quote = false
  for (let i = 0; i < line.length - 1; i++) {
    if (line[i] === '"') quote = !quote
    else if (!quote && line[i] === '%' && line[i + 1] === '%') return line.slice(0, i)
  }
  return line
}

function preprocess(src: string): string[] {
  let lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n')
  // YAML front matter (--- … ---) at the top.
  const first = lines.findIndex((l) => l.trim())
  if (first >= 0 && lines[first]!.trim() === '---') {
    const end = lines.findIndex((l, i) => i > first && l.trim() === '---')
    if (end > first) lines = lines.slice(end + 1)
  }
  return lines.map((l) => stripComment(l).trim()).filter(Boolean)
}

// ── style parsing (classDef / style) ────────────────────────────────────────

function parseCssStyle(spec: string, warnings: string[], where: string): MapNodeStyle {
  const style: MapNodeStyle = {}
  for (const part of spec.split(',')) {
    const [kRaw, ...rest] = part.split(':')
    const k = (kRaw ?? '').trim().toLowerCase()
    const v = rest.join(':').trim().replace(/;$/, '')
    if (!k || !v) continue
    if (k === 'fill') style.fill = v
    else if (k === 'stroke') style.stroke = v
    else if (k === 'color') style.textColor = v
    else if (k === 'stroke-width') {
      const n = parseFloat(v)
      if (Number.isFinite(n)) style.strokeWidth = n
    } else if (k === 'stroke-dasharray') style.strokeDash = 'dashed'
    else if (k === 'font-size') {
      const n = parseFloat(v)
      if (Number.isFinite(n)) style.fontSize = n
    } else if (k === 'font-weight') {
      if (v === 'bold' || parseInt(v, 10) >= 600) style.bold = true
    } else if (k === 'font-style') {
      if (v === 'italic') style.italic = true
    } else if (k === 'opacity') {
      const n = parseFloat(v)
      if (Number.isFinite(n)) style.opacity = n
    } else if (k === 'rx' || k === 'ry') {
      const n = parseFloat(v)
      if (Number.isFinite(n)) style.radius = n
    } else warnings.push(`${where}: style property "${k}" is not supported and was ignored`)
  }
  return style
}

// ── flowchart parser ────────────────────────────────────────────────────────

interface Ctx {
  nodes: Map<string, MapNode>
  order: string[]
  edges: MapEdge[]
  warnings: string[]
  subgraphStack: string[]
  classDefs: Map<string, MapNodeStyle>
  pendingClasses: Map<string, string[]> // node id → class names (applied at end)
  explicitShape: Set<string>
  edgeN: number
  subN: number
}

function applyStyle(n: MapNode, s: MapNodeStyle): void {
  n.style = { ...(n.style ?? {}), ...s }
  if (s.stroke && /^#|^rgb|^[a-z]+$/i.test(s.stroke)) n.color = s.stroke
}

function ensureNode(ctx: Ctx, id: string): MapNode {
  let n = ctx.nodes.get(id)
  if (!n) {
    n = { id, x: 0, y: 0, label: id, shape: 'process', color: DEFAULT_COLOR }
    const parent = ctx.subgraphStack[ctx.subgraphStack.length - 1]
    if (parent && parent !== id) n.parentId = parent
    ctx.nodes.set(id, n)
    ctx.order.push(id)
  } else if (!n.parentId && n.shape !== 'lane') {
    // Mermaid puts a node into the subgraph it is mentioned in, even when it was
    // first used outside it.
    const parent = ctx.subgraphStack[ctx.subgraphStack.length - 1]
    if (parent && parent !== id) n.parentId = parent
  }
  return n
}

const ID_RE = /[A-Za-z0-9_À-￿][A-Za-z0-9_À-￿]*(?:[-.][A-Za-z0-9_À-￿]+)*/y

interface Cursor {
  s: string
  i: number
}

function skipWs(c: Cursor): void {
  while (c.i < c.s.length && /\s/.test(c.s[c.i]!)) c.i++
}

// Read bracketed label text up to `close`, honouring a quoted label.
function readUntil(c: Cursor, close: string): string | null {
  const start = c.i
  let j = c.i
  while (j < c.s.length && c.s[j] === ' ') j++
  if (c.s[j] === '"') {
    const endQ = c.s.indexOf('"', j + 1)
    if (endQ >= 0) {
      let k = endQ + 1
      while (k < c.s.length && c.s[k] === ' ') k++
      if (c.s.startsWith(close, k)) {
        c.i = k + close.length
        return c.s.slice(j, endQ + 1)
      }
    }
  }
  const end = c.s.indexOf(close, start)
  if (end < 0) return null
  c.i = end + close.length
  return c.s.slice(start, end)
}

// Parse one node reference with optional shape + :::class. Returns its id.
function parseNodeRef(ctx: Ctx, c: Cursor, where: string): string | null {
  skipWs(c)
  ID_RE.lastIndex = c.i
  const m = ID_RE.exec(c.s)
  if (!m) return null
  // The id regex only joins '-' or '.' when a word character follows, so an
  // edge glued to an id (`A-->B`, `A-.->B`) is never swallowed.
  const id = m[0]
  c.i += id.length
  const n = ensureNode(ctx, id)
  // v11 shape syntax: A@{ shape: rect, label: "x" }
  if (c.s.startsWith('@{', c.i)) {
    const end = c.s.indexOf('}', c.i)
    if (end < 0) {
      ctx.warnings.push(`${where}: unterminated @{ … } on node "${id}"`)
      c.i = c.s.length
    } else {
      const body = c.s.slice(c.i + 2, end)
      c.i = end + 1
      const props = new Map<string, string>()
      for (const pm of body.matchAll(/(\w+)\s*:\s*("([^"]*)"|[^,]+)/g)) props.set(pm[1]!.toLowerCase(), (pm[3] ?? pm[2]!).trim())
      const shapeName = props.get('shape')
      if (shapeName) {
        const ms = V11_SHAPES[shapeName.toLowerCase()]
        if (ms) setShape(n, shapeFor(ms))
        else {
          ctx.warnings.push(`${where}: shape "${shapeName}" is not supported; using a rectangle`)
          setShape(n, shapeFor('rect'))
        }
        ctx.explicitShape.add(id)
      }
      const label = props.get('label')
      if (label !== undefined) n.label = cleanLabel(label)
    }
  } else {
    for (const op of OPENERS) {
      if (!c.s.startsWith(op.open, c.i)) continue
      const save = c.i
      c.i += op.open.length
      const text = readUntil(c, op.close)
      if (text === null) {
        c.i = save
        continue
      }
      // `[/a/]` vs `[/a\]`: readUntil finds the first closer; if the other closer
      // of the same opener appears earlier, prefer that one.
      if (op.open === '[/' || op.open === '[\\') {
        const alt = OPENERS.find((o) => o.open === op.open && o.close !== op.close)!
        const altEnd = c.s.indexOf(alt.close, save + op.open.length)
        const thisEnd = c.i - op.close.length
        if (altEnd >= 0 && altEnd < thisEnd) {
          c.i = save
          continue
        }
      }
      n.label = cleanLabel(text)
      setShape(n, shapeFor(op.shape))
      ctx.explicitShape.add(id)
      break
    }
  }
  // :::className
  const cm = /^:::([\w-]+)/.exec(c.s.slice(c.i))
  if (cm) {
    c.i += cm[0].length
    const list = ctx.pendingClasses.get(id) ?? []
    list.push(cm[1]!)
    ctx.pendingClasses.set(id, list)
  }
  return id
}

function setShape(n: MapNode, ch: ShapeChoice): void {
  n.shape = ch.shape
  delete n.flipX
  delete n.flipY
  if (ch.flipX) n.flipX = true
  if (ch.flipY) n.flipY = true
  if (ch.style) n.style = { ...(n.style ?? {}), ...ch.style }
}

// An `&`-separated group of nodes.
function parseGroup(ctx: Ctx, c: Cursor, where: string): string[] | null {
  const first = parseNodeRef(ctx, c, where)
  if (!first) return null
  const ids = [first]
  for (;;) {
    const save = c.i
    skipWs(c)
    if (c.s[c.i] !== '&') {
      c.i = save
      break
    }
    c.i++
    const next = parseNodeRef(ctx, c, where)
    if (!next) {
      ctx.warnings.push(`${where}: expected a node after "&"`)
      break
    }
    ids.push(next)
  }
  return ids
}

interface EdgeOp {
  kind: 'solid' | 'thick' | 'dotted' | 'invisible'
  start: 'none' | 'arrow' | 'circle' | 'cross'
  end: 'none' | 'arrow' | 'circle' | 'cross'
  label?: string
}

const MARK: Record<string, EdgeOp['end']> = { '>': 'arrow', '<': 'arrow', o: 'circle', x: 'cross' }

// Try to read an edge operator (with optional text/pipe label) at the cursor.
function parseEdgeOp(c: Cursor): EdgeOp | null {
  skipWs(c)
  const rest = c.s.slice(c.i)
  // Full operator: optional start mark, body, optional end mark.
  const full = /^([<ox])?(-{2,}|={2,}|-\.+-|~{3,})([>ox])?/.exec(rest)
  // Start marks o/x are only operators when glued to the body and preceded by
  // whitespace (`A o--o B`); `<` always is.
  let m = full
  if (m && (m[1] === 'o' || m[1] === 'x')) {
    const prev = c.s[c.i - 1]
    if (prev !== undefined && !/\s/.test(prev)) m = null
  }
  // An end mark o/x directly followed by a word char is the next node's id
  // (`A---oB`… Mermaid reads that as a circle edge too, but `A-->xray` must not).
  if (m && (m[3] === 'o' || m[3] === 'x') && /[\w]/.test(rest[m[0].length] ?? '')) {
    m = [m[0].slice(0, -1), m[1], m[2], undefined] as unknown as RegExpExecArray
  }
  if (!m) return null
  const body = m[2]!
  const kind: EdgeOp['kind'] = body.startsWith('=') ? 'thick' : body.startsWith('~') ? 'invisible' : body.includes('.') ? 'dotted' : 'solid'
  const op: EdgeOp = { kind, start: m[1] ? MARK[m[1]]! : 'none', end: m[3] ? MARK[m[3]]! : 'none' }
  let consumed = m[0].length

  // Text-label form: `-- text -->`, `== text ==>` (dotted: parseDottedText).
  const isOpener = !m[3] && (body === '--' || body === '==')
  if (isOpener && /^\s+[^\s>|-]/.test(rest.slice(consumed))) {
    const closeRe = kind === 'thick' ? /(={2,})([>ox])?/g : /(-{2,})([>ox])?/g
    closeRe.lastIndex = consumed
    const cm = closeRe.exec(rest)
    if (cm) {
      op.label = cleanLabel(rest.slice(consumed, cm.index))
      op.end = cm[2] ? MARK[cm[2]]! : 'none'
      consumed = cm.index + cm[0].length
    }
  }
  c.i += consumed
  return withPipe(c, op)
}

// Dotted text form `-. text .->` (the main regex cannot see it: `-.` + space).
function parseDottedText(c: Cursor): EdgeOp | null {
  skipWs(c)
  const rest = c.s.slice(c.i)
  const m = /^([<ox])?-\.\s+/.exec(rest)
  if (!m) return null
  const close = /\.+-([>ox])?/g
  close.lastIndex = m[0].length
  const cm = close.exec(rest)
  if (!cm) return null
  const op: EdgeOp = {
    kind: 'dotted',
    start: m[1] ? MARK[m[1]]! : 'none',
    end: cm[1] ? MARK[cm[1]]! : 'none',
    label: cleanLabel(rest.slice(m[0].length, cm.index))
  }
  c.i += cm.index + cm[0].length
  return withPipe(c, op)
}

function withPipe(c: Cursor, op: EdgeOp): EdgeOp {
  const save = c.i
  skipWs(c)
  if (c.s[c.i] === '|') {
    // A quoted pipe label may itself contain '|'.
    if (c.s[c.i + 1] === '"') {
      const q = c.s.indexOf('"', c.i + 2)
      if (q > 0 && c.s[q + 1] === '|') {
        op.label = cleanLabel(c.s.slice(c.i + 1, q + 1))
        c.i = q + 2
        return op
      }
    }
    const end = c.s.indexOf('|', c.i + 1)
    if (end > c.i) {
      op.label = cleanLabel(c.s.slice(c.i + 1, end))
      c.i = end + 1
      return op
    }
  }
  c.i = save
  return op
}

function arrowOf(m: EdgeOp['end']): MapArrowHead {
  return m === 'arrow' ? 'arrow' : m === 'circle' ? 'circle' : m === 'cross' ? 'bar' : 'none'
}

function addEdge(ctx: Ctx, s: string, t: string, op: EdgeOp): void {
  const e: MapEdge = { id: `e${++ctx.edgeN}`, source: s, target: t }
  if (op.label) e.label = op.label
  e.endArrow = arrowOf(op.end)
  if (op.start !== 'none') e.startArrow = arrowOf(op.start)
  if (op.kind === 'dotted') {
    e.dash = 'dashed'
    e.style = 'dashed'
  } else if (op.kind === 'thick') e.strokeWidth = 3
  else if (op.kind === 'invisible') e.dash = 'none'
  ctx.edges.push(e)
}

function parseFlowStatement(ctx: Ctx, stmt: string, where: string): void {
  const c: Cursor = { s: stmt, i: 0 }
  let left = parseGroup(ctx, c, where)
  if (!left) {
    ctx.warnings.push(`${where}: could not parse "${stmt}"`)
    return
  }
  for (;;) {
    skipWs(c)
    if (c.i >= c.s.length) return
    const op = parseDottedText(c) ?? parseEdgeOp(c)
    if (!op) {
      ctx.warnings.push(`${where}: ignored unexpected text "${c.s.slice(c.i)}"`)
      return
    }
    const right = parseGroup(ctx, c, where)
    if (!right) {
      ctx.warnings.push(`${where}: edge has no target in "${stmt}"`)
      return
    }
    for (const s of left) for (const t of right) addEdge(ctx, s, t, op)
    left = right
  }
}

function parseFlowchart(lines: string[], headerIdx: number, dirRaw: string | undefined, warnings: string[]): MermaidImport {
  const ctx: Ctx = {
    nodes: new Map(),
    order: [],
    edges: [],
    warnings,
    subgraphStack: [],
    classDefs: new Map(),
    pendingClasses: new Map(),
    explicitShape: new Set(),
    edgeN: 0,
    subN: 0
  }
  const containers = new Set<string>()
  const styleLines: { id: string; spec: string; where: string }[] = []
  for (let li = headerIdx + 1; li < lines.length; li++) {
    for (const stmt of splitStatements(lines[li]!)) {
      const where = `line ${li + 1}`
      let m: RegExpExecArray | null
      if ((m = /^subgraph\b\s*(.*)$/i.exec(stmt))) {
        const rest = m[1]!.trim()
        let id: string
        let title: string
        const sm = /^([\wÀ-￿-]+)\s*\[\s*(.*?)\s*\]$/.exec(rest)
        if (sm) {
          id = sm[1]!
          title = cleanLabel(sm[2]!)
        } else if (/^"[^"]*"$/.test(rest)) {
          title = cleanLabel(rest)
          id = `subgraph${++ctx.subN}`
        } else if (/^[\wÀ-￿-]+$/.test(rest)) {
          id = rest
          title = rest
        } else if (rest) {
          title = cleanLabel(rest)
          id = `subgraph${++ctx.subN}`
        } else {
          id = `subgraph${++ctx.subN}`
          title = ''
        }
        const n = ensureNode(ctx, id)
        n.shape = 'lane'
        n.label = title
        n.color = '#64748b'
        containers.add(id)
        ctx.subgraphStack.push(id)
      } else if (/^end$/i.test(stmt)) {
        if (!ctx.subgraphStack.pop()) warnings.push(`${where}: "end" without a matching subgraph`)
      } else if ((m = /^direction\s+(TB|TD|BT|LR|RL)$/i.exec(stmt))) {
        // Per-subgraph direction: the overall layout direction applies.
      } else if ((m = /^classDef\s+([\w-]+(?:\s*,\s*[\w-]+)*)\s+(.+)$/i.exec(stmt))) {
        const style = parseCssStyle(m[2]!, warnings, where)
        for (const name of m[1]!.split(',')) ctx.classDefs.set(name.trim(), style)
      } else if ((m = /^class\s+(.+?)\s+([\w-]+)$/i.exec(stmt))) {
        for (const id of m[1]!.split(',').map((s) => s.trim()).filter(Boolean)) {
          const list = ctx.pendingClasses.get(id) ?? []
          list.push(m[2]!)
          ctx.pendingClasses.set(id, list)
        }
      } else if ((m = /^style\s+([\wÀ-￿-]+)\s+(.+)$/i.exec(stmt))) {
        styleLines.push({ id: m[1]!, spec: m[2]!, where })
      } else if (/^linkStyle\b/i.test(stmt)) {
        warnings.push(`${where}: linkStyle is not supported and was ignored`)
      } else if ((m = /^click\s+([\wÀ-￿-]+)\s+(?:href\s+)?"([^"]+)"/i.exec(stmt))) {
        const n = ctx.nodes.get(m[1]!)
        if (n && /^(https?:|mailto:)/i.test(m[2]!)) n.link = m[2]!
        else warnings.push(`${where}: click handler ignored (only href links to known nodes are imported)`)
      } else if (/^click\b/i.test(stmt)) {
        warnings.push(`${where}: click callback ignored`)
      } else if (/^(accTitle|accDescr|title)\b/i.test(stmt)) {
        // accessibility metadata — nothing to draw
      } else {
        parseFlowStatement(ctx, stmt, where)
      }
    }
  }
  if (ctx.subgraphStack.length) warnings.push(`${ctx.subgraphStack.length} subgraph(s) were not closed with "end"`)

  // Classes then explicit styles (explicit wins, as in Mermaid).
  for (const [id, names] of ctx.pendingClasses) {
    const n = ctx.nodes.get(id)
    if (!n) {
      warnings.push(`class applied to unknown node "${id}"`)
      continue
    }
    for (const name of names) {
      const st = ctx.classDefs.get(name)
      if (st) applyStyle(n, st)
      else if (name !== 'default') warnings.push(`class "${name}" is not defined`)
    }
  }
  const def = ctx.classDefs.get('default')
  if (def) for (const n of ctx.nodes.values()) if (!containers.has(n.id)) applyStyle(n, def)
  for (const { id, spec, where } of styleLines) {
    const n = ctx.nodes.get(id)
    if (!n) warnings.push(`${where}: style for unknown node "${id}"`)
    else applyStyle(n, parseCssStyle(spec, warnings, where))
  }
  // A subgraph id must not have become its own parent through re-mention.
  for (const n of ctx.nodes.values()) if (n.parentId === n.id) delete n.parentId

  const nodes = ctx.order.map((id) => ctx.nodes.get(id)!)
  const dir = toLayoutDir(dirRaw)
  return { nodes: layoutNested(nodes, ctx.edges, dir), edges: ctx.edges, warnings }
}

function toLayoutDir(d: string | undefined): LayoutDirection {
  switch ((d ?? 'TB').toUpperCase()) {
    case 'LR':
      return 'LR'
    case 'RL':
      return 'RL'
    case 'BT':
      return 'BT'
    default:
      return 'TB'
  }
}

// Lay out containers bottom-up: each container's members are laid out inside it
// and the container sized to fit; then each level is laid out with containers
// treated as single blocks, and members translated with their container.
export function layoutNested(nodes: MapNode[], edges: MapEdge[], dir: LayoutDirection): MapNode[] {
  const byId = new Map(nodes.map((n) => [n.id, { ...n }]))
  const kids = new Map<string, string[]>()
  const top: string[] = []
  for (const n of nodes) {
    const p = n.parentId && byId.has(n.parentId) ? n.parentId : undefined
    if (p) {
      if (!kids.has(p)) kids.set(p, [])
      kids.get(p)!.push(n.id)
    } else top.push(n.id)
  }
  // Which top-level-of-this-scope ancestor a node belongs to.
  const scopeOf = (id: string, members: Set<string>): string | undefined => {
    let cur: string | undefined = id
    const seen = new Set<string>()
    while (cur && !seen.has(cur)) {
      if (members.has(cur)) return cur
      seen.add(cur)
      cur = byId.get(cur)?.parentId
    }
    return undefined
  }
  const translate = (id: string, dx: number, dy: number): void => {
    const n = byId.get(id)!
    n.x = Math.round(n.x + dx)
    n.y = Math.round(n.y + dy)
    for (const k of kids.get(id) ?? []) translate(k, dx, dy)
  }
  // Lays out `members` (one scope) at origin; returns the scope's bounds.
  const layoutScope = (members: string[], visiting: Set<string>): void => {
    for (const id of members) {
      if (kids.get(id)?.length && !visiting.has(id)) {
        visiting.add(id)
        layoutScope(kids.get(id)!, visiting)
        // Size the container around its laid-out members.
        let x1 = Infinity
        let y1 = Infinity
        let x2 = -Infinity
        let y2 = -Infinity
        const walk = (k: string): void => {
          const n = byId.get(k)!
          const s = nodeSize(n)
          x1 = Math.min(x1, n.x)
          y1 = Math.min(y1, n.y)
          x2 = Math.max(x2, n.x + s.w)
          y2 = Math.max(y2, n.y + s.h)
          for (const g of kids.get(k) ?? []) walk(g)
        }
        for (const k of kids.get(id)!) walk(k)
        const c = byId.get(id)!
        c.width = Math.round(x2 - x1 + LANE_BAND + LANE_PAD * 2)
        c.height = Math.round(y2 - y1 + LANE_PAD * 2)
        c.x = 0
        c.y = 0
        for (const k of kids.get(id)!) translate(k, LANE_BAND + LANE_PAD - x1, LANE_PAD - y1)
      } else if (kids.has(id) === false && getShape(byId.get(id)!.shape).container && !byId.get(id)!.width) {
        // Empty subgraph: give it a modest size.
        const c = byId.get(id)!
        c.width = 240
        c.height = 120
      }
    }
    const set = new Set(members)
    // Temporary stand-ins: containers become plain boxes of their fitted size so
    // the layout engine treats them as movable blocks.
    const temp: MapNode[] = members.map((id) => {
      const n = byId.get(id)!
      const s = nodeSize(n)
      const { parentId: _p, ...rest } = n
      void _p
      return { ...rest, shape: 'process', width: s.w, height: s.h, locked: false, hidden: false }
    })
    const scopedEdges: MapEdge[] = []
    for (const e of edges) {
      const s = scopeOf(e.source, set)
      const t = scopeOf(e.target, set)
      if (s && t && s !== t) scopedEdges.push({ ...e, source: s, target: t })
    }
    const laid = layoutDiagram(temp, scopedEdges, { algorithm: 'layered', direction: dir, origin: { x: 0, y: 0 } })
    for (const l of laid) {
      const n = byId.get(l.id)!
      translate(l.id, l.x - n.x, l.y - n.y)
    }
  }
  layoutScope(top, new Set())
  // Final offset so the diagram starts at a comfortable margin.
  for (const id of top) translate(id, 80, 60)
  return nodes.map((n) => byId.get(n.id)!)
}


// ── erDiagram ───────────────────────────────────────────────────────────────

const ER_LEFT: Record<string, MapArrowHead> = {
  '||': 'crowOne',
  '|o': 'crowZeroOrOne',
  'o|': 'crowZeroOrOne',
  '}o': 'crowZeroOrMany',
  'o{': 'crowZeroOrMany',
  '}|': 'crowOneOrMany',
  '|{': 'crowOneOrMany'
}

function parseEr(lines: string[], headerIdx: number, warnings: string[]): MermaidImport {
  const entityShape = pick('erd-entity', 'process')
  const nodes = new Map<string, MapNode>()
  const order: string[] = []
  const attrs = new Map<string, string[]>()
  const edges: MapEdge[] = []
  const ensure = (id: string, alias?: string): MapNode => {
    let n = nodes.get(id)
    if (!n) {
      n = { id, x: 0, y: 0, label: alias ?? id, shape: entityShape, color: '#0f766e' }
      nodes.set(id, n)
      order.push(id)
      attrs.set(id, [])
    } else if (alias) n.label = alias
    return n
  }
  const ENT = '([\\w\\u00C0-\\uFFFF-]+|"[^"]+")'
  const relRe = new RegExp(`^${ENT}\\s*(\\|\\||\\|o|o\\||\\}o|\\}\\||)(--|\\.\\.)(\\|\\||o\\||\\|o|o\\{|\\|\\{|)\\s*${ENT}\\s*(?::\\s*(.*))?$`)
  let open: string | null = null
  for (let li = headerIdx + 1; li < lines.length; li++) {
    const where = `line ${li + 1}`
    const line = lines[li]!
    if (open) {
      if (line === '}') {
        open = null
        continue
      }
      const am = /^([\wÀ-￿()[\],-]+)\s+([\wÀ-￿*-]+)((?:\s+(?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)?)\s*(?:"([^"]*)")?$/.exec(line)
      if (am) {
        const keys = (am[3] ?? '').trim().replace(/\s*,\s*/g, ', ')
        attrs.get(open)!.push(`${keys ? keys + ' ' : ''}${am[2]}: ${am[1]}`)
      }
      else warnings.push(`${where}: could not parse attribute "${line}"`)
      continue
    }
    let m: RegExpExecArray | null
    if ((m = /^([\wÀ-￿-]+)(?:\s*\[\s*"?([^"\]]*)"?\s*\])?\s*\{\s*(\})?$/.exec(line))) {
      ensure(m[1]!, m[2])
      if (!m[3]) open = m[1]!
    } else if ((m = relRe.exec(line))) {
      const a = m[1]!.replace(/^"|"$/g, '')
      const b = m[5]!.replace(/^"|"$/g, '')
      ensure(a)
      ensure(b)
      const e: MapEdge = { id: `e${edges.length + 1}`, source: a, target: b, startArrow: ER_LEFT[m[2]!] ?? 'none', endArrow: ER_LEFT[m[4]!] ?? 'none' }
      if (!m[2] || !m[4]) warnings.push(`${where}: relationship without cardinality markers`)
      if (m[3] === '..') {
        e.dash = 'dashed'
        e.style = 'dashed'
      }
      const label = m[6] ? cleanLabel(m[6]) : ''
      if (label) e.label = label
      edges.push(e)
    } else if ((m = /^([\wÀ-￿-]+)$/.exec(line))) {
      ensure(m[1]!)
    } else if (/^(direction|title|accTitle|accDescr)\b/i.test(line)) {
      // ignored metadata
    } else {
      warnings.push(`${where}: could not parse "${line}"`)
    }
  }
  if (open) warnings.push(`entity "${open}" attribute block was not closed with "}"`)
  for (const id of order) finishRecord(nodes.get(id)!, attrs.get(id)!, entityShape !== 'process')
  const list = order.map((id) => nodes.get(id)!)
  return { nodes: layoutNested(list, edges, 'TB'), edges, warnings }
}

// Entity / class with rows. The registry's record shapes (special 'erdEntity' /
// 'umlClass') draw their compartments from label lines, so rows always become
// extra label lines; the box grows to fit them.
function finishRecord(n: MapNode, rows: string[], dedicated: boolean): void {
  if (!rows.length) return
  n.label = [n.label, ...rows].join('\n')
  const lines = n.label.split('\n')
  const lineH = dedicated ? 22 : 18
  n.height = Math.max(nodeSize(n).h, 36 + rows.length * lineH)
  n.width = Math.max(nodeSize(n).w, Math.ceil(7.5 * Math.max(...lines.map((l) => l.length))) + 24)
}

// ── classDiagram ────────────────────────────────────────────────────────────

// Left/right relation tokens → arrowheads.
const CLASS_LEFT: Record<string, MapArrowHead> = { '<|': 'triangle', '*': 'diamond', o: 'diamondOpen', '<': 'open', '': 'none' }
const CLASS_RIGHT: Record<string, MapArrowHead> = { '|>': 'triangle', '*': 'diamond', o: 'diamondOpen', '>': 'open', '': 'none' }

function parseClass(lines: string[], headerIdx: number, warnings: string[]): MermaidImport {
  const classShape = pick('uml-class', 'process')
  const nodes = new Map<string, MapNode>()
  const order: string[] = []
  const members = new Map<string, string[]>()
  const edges: MapEdge[] = []
  const ensure = (raw: string): MapNode => {
    const id = raw.replace(/~[^~]*~/g, '').replace(/^`|`$/g, '')
    let n = nodes.get(id)
    if (!n) {
      n = { id, x: 0, y: 0, label: raw.replace(/~([^~]*)~/g, '<$1>').replace(/^`|`$/g, ''), shape: classShape, color: '#7c3aed' }
      nodes.set(id, n)
      order.push(id)
      members.set(id, [])
    }
    return n
  }
  const NAME = '([\\w\\u00C0-\\uFFFF~`.-]+)'
  const relRe = new RegExp(
    `^${NAME}\\s*(?:"([^"]*)")?\\s*(<\\||\\*|o|<)?(--|\\.\\.)(\\|>|\\*|o|>)?\\s*(?:"([^"]*)")?\\s*${NAME}\\s*(?::\\s*(.*))?$`
  )
  let open: string | null = null
  for (let li = headerIdx + 1; li < lines.length; li++) {
    const where = `line ${li + 1}`
    const line = lines[li]!
    if (open) {
      if (line === '}') open = null
      else if (/^<<.*>>$/.test(line)) nodes.get(open)!.label = `${line}\n${nodes.get(open)!.label}`
      else members.get(open)!.push(line)
      continue
    }
    let m: RegExpExecArray | null
    if ((m = /^class\s+([\wÀ-￿~`.-]+)(?:\s*\["?([^"\]]*)"?\])?\s*(\{)?\s*(\})?$/.exec(line))) {
      const n = ensure(m[1]!)
      if (m[2]) n.label = cleanLabel(m[2])
      if (m[3] && !m[4]) open = n.id
    } else if ((m = relRe.exec(line))) {
      const a = ensure(m[1]!).id
      const b = ensure(m[7]!).id
      const e: MapEdge = {
        id: `e${edges.length + 1}`,
        source: a,
        target: b,
        startArrow: CLASS_LEFT[m[3] ?? ''] ?? 'none',
        endArrow: CLASS_RIGHT[m[5] ?? ''] ?? 'none'
      }
      if (m[4] === '..') {
        e.dash = 'dashed'
        e.style = 'dashed'
      }
      const parts = [m[2] ? `${m[2]}` : '', m[8] ? cleanLabel(m[8]) : '', m[6] ? `${m[6]}` : ''].filter(Boolean)
      if (parts.length) e.label = parts.join(' ')
      edges.push(e)
    } else if ((m = /^([\wÀ-￿~`.-]+)\s*:\s*(.+)$/.exec(line))) {
      const n = ensure(m[1]!)
      members.get(n.id)!.push(m[2]!.trim())
    } else if ((m = /^<<(.+)>>\s+([\wÀ-￿-]+)$/.exec(line))) {
      const n = ensure(m[2]!)
      n.label = `<<${m[1]}>>\n${n.label}`
    } else if (/^(direction|note|link|click|callback|style|classDef|cssClass|namespace|title|accTitle|accDescr)\b/i.test(line) || line === '}') {
      warnings.push(`${where}: "${line.split(/\s/)[0]}" is not supported in class diagrams and was ignored`)
    } else {
      warnings.push(`${where}: could not parse "${line}"`)
    }
  }
  if (open) warnings.push(`class "${open}" member block was not closed with "}"`)
  // Attributes first, then operations (Mermaid allows them interleaved).
  for (const id of order) {
    const ms = members.get(id)!
    const ops = ms.filter((x) => x.includes('('))
    finishRecord(nodes.get(id)!, [...ms.filter((x) => !x.includes('(')), ...ops], classShape !== 'process')
  }
  const list = order.map((id) => nodes.get(id)!)
  return { nodes: layoutNested(list, edges, 'TB'), edges, warnings }
}

// ── public: import ──────────────────────────────────────────────────────────

export function mermaidToMap(src: string): MermaidImport {
  const warnings: string[] = []
  try {
    const lines = preprocess(src)
    if (!lines.length) {
      warnings.push('The Mermaid text is empty')
      return { nodes: [], edges: [], warnings }
    }
    const header = lines[0]!
    let m: RegExpExecArray | null
    if ((m = /^(?:flowchart|graph)(?:-elk)?(?:\s+(TB|TD|BT|LR|RL))?\s*;?\s*(.*)$/i.exec(header))) {
      // Statements may follow the header on the same line (`graph TD; A-->B`).
      const rest = m[2]?.trim()
      const body = rest ? [header, rest, ...lines.slice(1)] : lines
      return parseFlowchart(body, 0, m[1], warnings)
    }
    if (/^erDiagram\b/i.test(header)) return parseEr(lines, 0, warnings)
    if (/^classDiagram(?:-v2)?\b/i.test(header)) return parseClass(lines, 0, warnings)
    const kind = header.split(/\s/)[0]
    warnings.push(`Mermaid "${kind}" diagrams are not supported; supported types are flowchart/graph, erDiagram and classDiagram`)
    return { nodes: [], edges: [], warnings }
  } catch (err) {
    warnings.push(`Mermaid import failed: ${err instanceof Error ? err.message : String(err)}`)
    return { nodes: [], edges: [], warnings }
  }
}

// ── public: export ──────────────────────────────────────────────────────────

function escLabel(s: string): string {
  return s.replace(/#/g, '#35;').replace(/&/g, '#amp;').replace(/"/g, '#quot;').replace(/\|/g, '#124;').replace(/</g, '#lt;').replace(/>/g, '#gt;').replace(/\n/g, '<br>')
}

function wrapShape(n: MapNode, label: string): string {
  const q = `"${label}"`
  const id = n.shape
  const has = (...words: string[]): boolean => words.some((w) => id.includes(w))
  if (id === 'process') return (n.style?.radius ?? 0) >= 10 ? `(${q})` : `[${q}]`
  if (id === 'terminator' || has('stadium', 'terminal', 'capsule', 'pill')) return `([${q}])`
  if (id === 'decision' || has('decision', 'diamond', 'rhombus', 'gateway')) return `{${q}}`
  if (id === 'data' || has('parallelogram')) return n.flipX ? `[\\${q}\\]` : `[/${q}/]`
  if (id === 'trapezoid' || has('trapezoid')) return n.flipY ? `[\\${q}/]` : `[/${q}\\]`
  if (has('database', 'cylinder', 'basic-can', 'data-store')) return `[(${q})]`
  if (has('double-circle', 'doublecircle')) return `(((${q})))`
  if (id === 'circle' || has('circle', 'ellipse', 'event', 'initial', 'on-page-reference')) return `((${q}))`
  if (id === 'hexagon' || has('hexagon', 'preparation')) return `{{${q}}}`
  if (has('predefined', 'subroutine', 'subprocess')) return `[[${q}]]`
  if (has('asymmetric')) return `>${q}]`
  if (has('document')) return `@{ shape: doc, label: ${q} }`
  if (has('rounded', 'alternate-process', 'task')) return `(${q})`
  return `[${q}]`
}

function edgeOp(e: MapEdge): string {
  const dashed = e.dash ? e.dash === 'dashed' || e.dash === 'dotted' || e.dash === 'dashdot' : e.style === 'dashed'
  const invisible = e.dash === 'none'
  const thick = !dashed && (e.strokeWidth ?? 0) >= 3
  const endHead = e.endArrow ?? 'arrow'
  const startHead = e.startArrow ?? 'none'
  const mark = (h: MapArrowHead, side: 'start' | 'end'): string => {
    if (h === 'none') return ''
    if (h === 'circle' || h === 'circleOpen') return 'o'
    if (h === 'bar') return 'x'
    return side === 'end' ? '>' : '<'
  }
  if (invisible) return '~~~'
  const s = mark(startHead, 'start')
  const t = mark(endHead, 'end')
  if (dashed) return `${s}-.${t ? '-' + t : '-'}`
  if (thick) return `${s}==${t || '='}`
  return `${s}--${t || '-'}`
}

function safeId(raw: string, used: Set<string>): string {
  let base = raw.replace(/[^A-Za-z0-9_]/g, '_')
  if (!base || /^\d/.test(base)) base = `n_${base}`
  if (/^(end|graph|flowchart|subgraph|style|class|classDef|click|linkStyle|direction)$/i.test(base)) base = `${base}_`
  let id = base
  let i = 2
  while (used.has(id)) id = `${base}_${i++}`
  used.add(id)
  return id
}

function cssColour(v: string): string | null {
  return /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i.test(v.trim()) ? v.trim() : null
}

export function mapToMermaid(nodes: MapNode[], edges: MapEdge[], direction: 'TD' | 'LR' = 'TD'): string {
  const used = new Set<string>()
  const mid = new Map<string, string>()
  for (const n of nodes) mid.set(n.id, safeId(n.id, used))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const isContainer = (n: MapNode): boolean => !!getShape(n.shape).container
  const kids = new Map<string, MapNode[]>()
  const roots: MapNode[] = []
  for (const n of nodes) {
    const p = n.parentId ? byId.get(n.parentId) : undefined
    if (p && p !== n && isContainer(p)) {
      if (!kids.has(p.id)) kids.set(p.id, [])
      kids.get(p.id)!.push(n)
    } else roots.push(n)
  }
  const lines: string[] = [`flowchart ${direction}`]
  const styles: string[] = []
  const seen = new Set<string>()
  const emit = (n: MapNode, depth: number): void => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    const pad = '  '.repeat(depth)
    const id = mid.get(n.id)!
    if (isContainer(n)) {
      lines.push(`${pad}subgraph ${id}["${escLabel(n.label ?? '')}"]`)
      for (const k of kids.get(n.id) ?? []) emit(k, depth + 1)
      lines.push(`${pad}end`)
    } else {
      lines.push(`${pad}${id}${wrapShape(n, escLabel(n.label ?? ''))}`)
    }
    const st: string[] = []
    const fill = n.style?.fill && cssColour(n.style.fill)
    const stroke = cssColour(n.style?.stroke ?? '') ?? (n.color && n.color !== DEFAULT_COLOR ? cssColour(n.color) : null)
    if (fill) st.push(`fill:${fill}`)
    if (stroke) st.push(`stroke:${stroke}`)
    if (n.style?.textColor && cssColour(n.style.textColor)) st.push(`color:${n.style.textColor}`)
    if (n.style?.strokeWidth) st.push(`stroke-width:${n.style.strokeWidth}px`)
    if (n.style?.strokeDash && n.style.strokeDash !== 'solid' && n.style.strokeDash !== 'none') st.push('stroke-dasharray:5 5')
    if (st.length) styles.push(`  style ${id} ${st.join(',')}`)
    if (n.link && /^(https?:|mailto:)/i.test(n.link)) styles.push(`  click ${id} href "${n.link.replace(/"/g, '%22')}"`)
  }
  for (const n of roots) emit(n, 1)
  for (const n of nodes) emit(n, 1) // anything only reachable through a parent cycle
  for (const e of edges) {
    const s = mid.get(e.source)
    const t = mid.get(e.target)
    if (!s || !t) continue
    const op = edgeOp(e)
    const label = e.label ? `|"${escLabel(e.label)}"|` : ''
    lines.push(`  ${s} ${op}${label} ${t}`)
  }
  return [...lines, ...styles].join('\n') + '\n'
}
