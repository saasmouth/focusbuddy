// diagrams.net (draw.io) ⇄ PlexiDiagrams. Pure string ⇄ MapNode/MapEdge; no DOM
// (the main process has no DOMParser), so a small tolerant XML parser lives here.
//
// Import (drawioToMap):
//   • <mxfile> with one <diagram> per page; each page is either a plain
//     <mxGraphModel> or compressed text (base64 → raw deflate → URI-encoded XML);
//     a bare <mxGraphModel> is accepted as a single page
//   • mxCell vertices/edges, <object>/<UserObject> wrappers (label, link,
//     tooltip, custom attributes → data), visible="0" → hidden
//   • mxGeometry x/y/width/height; children of a vertex are relative to it and
//     converted to absolute; swimlanes become 'lane' containers (parentId),
//     style "group" cells dissolve into a shared groupId
//   • style strings: shape names (rect, ellipse, rhombus, cylinder3, document,
//     parallelogram, hexagon, triangle, cloud, umlActor, note, card, process,
//     step, trapezoid, star, cross, singleArrow, callout, mxgraph.flowchart.*),
//     rounded/arcSize, fillColor, strokeColor, fontColor, fontSize, fontStyle,
//     fontFamily, dashed/dashPattern, strokeWidth, opacity, rotation, flipH/V,
//     align/verticalAlign, shadow, locked, image
//   • edges: source/target, endArrow/startArrow (+ endFill/startFill), ER
//     crow's feet, edgeStyle → routing, curved, waypoints from <Array as="points">,
//     exit/entry points → ports, labels from value or child edgeLabel cells
//   • HTML labels: tags stripped, entities decoded, <br>/<div>/<p> → newlines
//
// Export (mapToDrawio) writes an uncompressed mxfile that diagrams.net opens:
// native shape styles, colours, fonts, dash, arrows, waypoints, labels, ports,
// containers as swimlanes with child geometry relative to the parent. The exact
// registry id rides along as `plexiShape=<id>` (draw.io ignores unknown keys),
// so a PlexiDiagrams → draw.io → PlexiDiagrams round trip is lossless on shape.

import { inflateSync, strFromU8 } from 'fflate'
import type { MapArrowHead, MapEdge, MapNode, MapNodeStyle, MapRouting, MapLayer } from '../types'
import { getShape, isShapeId } from './shapes'
import { nodeSize, parsePort, portId } from './geom'

export interface DrawioPage {
  name: string
  nodes: MapNode[]
  edges: MapEdge[]
  // draw.io layers beyond the default one, as PlexiiDiagrams layers. A hidden
  // draw.io layer stays hidden here, but as a LAYER the user can show again
  // from the Layers panel (it used to mark every shape on it hidden, with no
  // way back).
  layers?: MapLayer[]
}

export interface DrawioImport {
  pages: DrawioPage[]
  warnings: string[]
}

const DEFAULT_COLOR = '#2563eb'

function pick(...ids: string[]): string {
  for (const id of ids) if (isShapeId(id)) return id
  return ids[ids.length - 1] ?? 'process'
}

// ── tolerant XML ────────────────────────────────────────────────────────────

export interface XmlEl {
  name: string
  attrs: Record<string, string>
  children: XmlEl[]
  text: string
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return XML_ENTITIES[body.toLowerCase()] ?? m
  })
}

// Parses XML into an element tree. Never throws: unknown constructs are skipped,
// unclosed elements are closed at the end, mismatched end tags close back to the
// nearest matching open element (or are ignored).
export function parseXml(src: string, warnings: string[] = []): XmlEl {
  const root: XmlEl = { name: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlEl[] = [root]
  const s = String(src ?? '')
  let i = 0
  const n = s.length
  while (i < n) {
    const lt = s.indexOf('<', i)
    if (lt < 0) {
      stack[stack.length - 1]!.text += decodeEntities(s.slice(i))
      break
    }
    if (lt > i) stack[stack.length - 1]!.text += decodeEntities(s.slice(i, lt))
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const end = s.indexOf(']]>', lt + 9)
      stack[stack.length - 1]!.text += s.slice(lt + 9, end < 0 ? n : end)
      i = end < 0 ? n : end + 3
      continue
    }
    if (s.startsWith('<?', lt)) {
      const end = s.indexOf('?>', lt + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    if (s.startsWith('<!', lt)) {
      // DOCTYPE (possibly with an internal subset)
      let depth = 0
      let j = lt + 2
      for (; j < n; j++) {
        if (s[j] === '[') depth++
        else if (s[j] === ']') depth--
        else if (s[j] === '>' && depth <= 0) break
      }
      i = j + 1
      continue
    }
    if (s[lt + 1] === '/') {
      const end = s.indexOf('>', lt + 2)
      const name = s.slice(lt + 2, end < 0 ? n : end).trim()
      i = end < 0 ? n : end + 1
      let k = stack.length - 1
      while (k > 0 && stack[k]!.name !== name) k--
      if (k > 0) stack.length = k
      else warnings.push(`XML: unexpected closing tag </${name}>`)
      continue
    }
    // Start tag: name, then attributes, then > or />. Quoted values may contain '>'.
    let j = lt + 1
    while (j < n && /[^\s/>]/.test(s[j]!)) j++
    const name = s.slice(lt + 1, j)
    if (!name) {
      stack[stack.length - 1]!.text += '<'
      i = lt + 1
      continue
    }
    const attrs: Record<string, string> = {}
    let selfClose = false
    for (;;) {
      while (j < n && /\s/.test(s[j]!)) j++
      if (j >= n) break
      if (s[j] === '>') {
        j++
        break
      }
      if (s[j] === '/' && s[j + 1] === '>') {
        selfClose = true
        j += 2
        break
      }
      const a0 = j
      while (j < n && /[^\s=/>]/.test(s[j]!)) j++
      const an = s.slice(a0, j)
      while (j < n && /\s/.test(s[j]!)) j++
      if (s[j] === '=') {
        j++
        while (j < n && /\s/.test(s[j]!)) j++
        const q = s[j]
        if (q === '"' || q === "'") {
          const e = s.indexOf(q, j + 1)
          attrs[an] = decodeEntities(s.slice(j + 1, e < 0 ? n : e))
          j = e < 0 ? n : e + 1
        } else {
          const v0 = j
          while (j < n && /[^\s>]/.test(s[j]!) && !(s[j] === '/' && s[j + 1] === '>')) j++
          attrs[an] = decodeEntities(s.slice(v0, j))
        }
      } else if (an) {
        attrs[an] = ''
      } else {
        j++ // stray character; skip it
      }
    }
    const el: XmlEl = { name, attrs, children: [], text: '' }
    stack[stack.length - 1]!.children.push(el)
    if (!selfClose) stack.push(el)
    i = j
  }
  if (stack.length > 1) warnings.push(`XML: ${stack.length - 1} element(s) were not closed`)
  return root
}

function find(el: XmlEl, name: string): XmlEl | undefined {
  for (const c of el.children) {
    if (c.name === name) return c
    const deep = find(c, name)
    if (deep) return deep
  }
  return undefined
}

// ── compressed page payloads ────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/_-]/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let buf = 0
  let bits = 0
  let o = 0
  for (let i = 0; i < clean.length; i++) {
    const v = B64.indexOf(clean[i]!)
    if (v < 0) continue
    buf = (buf << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (buf >> bits) & 0xff
    }
  }
  return out.subarray(0, o)
}

// diagrams.net page text → graph-model XML.
function decodePagePayload(text: string, warnings: string[], page: string): string | null {
  const t = text.trim()
  if (!t) return null
  if (t.startsWith('<')) return t
  try {
    if (/^%3C/i.test(t)) return decodeURIComponent(t)
    const raw = inflateSync(base64ToBytes(t))
    const str = strFromU8(raw, true) // latin1: the payload is URI-encoded ASCII
    // Very old files deflate the XML itself (UTF-8) without URI-encoding it.
    if (str.trimStart().startsWith('<')) return strFromU8(raw)
    try {
      return decodeURIComponent(str)
    } catch {
      return str
    }
  } catch (err) {
    warnings.push(`${page}: could not decompress the diagram (${err instanceof Error ? err.message : String(err)})`)
    return null
  }
}

// ── style strings ───────────────────────────────────────────────────────────

type Style = Record<string, string>

export function parseStyle(style: string | undefined): { base: string[]; s: Style } {
  const base: string[] = []
  const s: Style = {}
  for (const part of (style ?? '').split(';')) {
    const p = part.trim()
    if (!p) continue
    const eq = p.indexOf('=')
    if (eq < 0) base.push(p)
    else s[p.slice(0, eq).trim()] = p.slice(eq + 1).trim()
  }
  return { base, s }
}

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function colour(v: string | undefined): string | undefined {
  if (!v || v === 'default' || v === 'inherit') return undefined
  return v
}

// ── labels ──────────────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  let s = html
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(div|p|li|h[1-6]|tr)>\s*/gi, '\n')
  s = s.replace(/<(div|p|li|h[1-6]|tr)(\s[^>]*)?>/gi, (_m: string, _t: string, _a: string, off: number) => (off > 0 ? '\n' : ''))
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s).replace(/ /g, ' ')
  s = s.replace(/\n{2,}/g, '\n')
  return s.replace(/^\n+|\n+$/g, '')
}

function labelOf(value: string | undefined, style: Style): string {
  if (!value) return ''
  const looksHtml = style.html === '1' || /<\/?[a-z][^>]*>/i.test(value)
  return looksHtml ? htmlToText(value) : value
}

// ── shape mapping (draw.io → registry) ──────────────────────────────────────

interface ShapePick {
  shape: string
  known: boolean
  flipY?: boolean
}

// draw.io shape name (lower-cased; mxgraph.flowchart.* → 'fc:*') → registry
// candidates, best first. The last candidate is always a legacy id.
const DRAWIO_SHAPES: Record<string, string[]> = {
  rhombus: ['decision'],
  'fc:decision': ['decision'],
  cylinder: ['database'],
  cylinder2: ['database'],
  cylinder3: ['database'],
  datastore: ['bpmn-data-store', 'database'],
  'fc:database': ['database'],
  document: ['fc-document', 'process'],
  'fc:document': ['fc-document', 'process'],
  'fc:multi-document': ['fc-multi-document', 'fc-document', 'process'],
  parallelogram: ['data'],
  'fc:data': ['data'],
  hexagon: ['hexagon'],
  'fc:preparation': ['hexagon'],
  triangle: ['triangle'],
  'fc:extract_or_measurement': ['fc-extract', 'triangle'],
  'fc:merge_or_storage': ['fc-merge', 'triangle'],
  trapezoid: ['trapezoid'],
  manualinput: ['fc-manual-input', 'process'],
  'fc:manual_input': ['fc-manual-input', 'process'],
  process: ['fc-predefined-process', 'process'],
  'fc:predefined_process': ['fc-predefined-process', 'process'],
  'fc:terminator': ['terminator'],
  'fc:process': ['process'],
  'fc:alternate_process': ['fc-alternate-process', 'process'],
  delay: ['fc-delay', 'process'],
  'fc:delay': ['fc-delay', 'process'],
  display: ['fc-display', 'process'],
  'fc:display': ['fc-display', 'process'],
  internalstorage: ['fc-internal-storage', 'process'],
  'fc:internal_storage': ['fc-internal-storage', 'process'],
  datastorage: ['fc-stored-data', 'database'],
  'fc:stored_data': ['fc-stored-data', 'database'],
  'fc:direct_data': ['fc-direct-access-storage', 'database'],
  'fc:sequential_data': ['fc-sequential-access', 'circle'],
  offpageconnector: ['fc-off-page-connector', 'pentagon'],
  'fc:off-page_reference': ['fc-off-page-connector', 'pentagon'],
  'fc:on-page_reference': ['fc-on-page-reference', 'circle'],
  'fc:start_1': ['fc-start-circle', 'circle'],
  'fc:start_2': ['fc-start-circle', 'circle'],
  card: ['fc-card', 'process'],
  'fc:card': ['fc-card', 'process'],
  tape: ['fc-punched-tape', 'fc-paper-tape', 'process'],
  'fc:paper_tape': ['fc-paper-tape', 'process'],
  'fc:punched_tape': ['fc-punched-tape', 'process'],
  'fc:collate': ['fc-collate', 'process'],
  'fc:sort': ['fc-sort', 'decision'],
  'fc:or': ['fc-or', 'circle'],
  'fc:summing_function': ['fc-summing-junction', 'circle'],
  'fc:loop_limit': ['fc-loop-limit', 'process'],
  'fc:annotation_1': ['fc-annotation', 'note'],
  'fc:annotation_2': ['fc-annotation', 'note'],
  'fc:offline_storage': ['fc-offline-storage', 'triangle'],
  'fc:transfer': ['fc-transfer', 'arrow'],
  'fc:parallel_mode': ['fc-parallel-mode', 'process'],
  doubleellipse: ['circle'],
  cloud: ['basic-cloud', 'process'],
  cube: ['basic-cube', 'process'],
  umlactor: ['uml-actor', 'process'],
  umllifeline: ['uml-lifeline', 'process'],
  component: ['uml-component', 'process'],
  module: ['uml-component', 'process'],
  folder: ['uml-package', 'lane'],
  umlframe: ['uml-frame', 'lane'],
  note: ['uml-note', 'callout'],
  note2: ['uml-note', 'callout'],
  step: ['chevron'],
  star: ['star'],
  pentagon: ['pentagon'],
  cross: ['cross'],
  plus: ['cross'],
  singlearrow: ['arrow'],
  doublearrow: ['arrow-left-right', 'arrow'],
  callout: ['callout'],
  text: ['note'],
  swimlane: ['lane'],
  table: ['lane'],
  image: ['image', 'process'],
  heart: ['basic-heart', 'process'],
  donut: ['basic-donut', 'circle'],
  moon: ['basic-moon', 'circle'],
  'flash': ['basic-lightning', 'process'],
  'wave2': ['basic-wave', 'process'],
  'octagon2': ['basic-octagon', 'hexagon'],
  'tee': ['process'],
  'or': ['fc-or', 'circle'],
  'xor': ['fc-summing-junction', 'circle'],
  'and': ['process'],
  'lineellipse': ['circle'],
  'mxgraph.bpmn.shape': ['bpmn-gateway', 'decision']
}

function drawioShape(base: string[], s: Style, square: boolean): ShapePick {
  const plexi = s.plexiShape
  if (plexi && isShapeId(plexi)) return { shape: plexi, known: true }
  let key = (s.shape ?? base[0] ?? '').trim()
  // A named base style ("ellipse;shape=cloud") is overridden by shape=.
  if (key.startsWith('mxgraph.flowchart.')) key = `fc:${key.slice('mxgraph.flowchart.'.length)}`
  else if (key.startsWith('mxgraph.basic.')) {
    const b = key.slice('mxgraph.basic.'.length)
    if (isShapeId(`basic-${b}`)) return { shape: `basic-${b}`, known: true }
    key = b
  }
  const k = key.toLowerCase()
  const known = (shape: string, flipY?: boolean): ShapePick => ({ shape, known: true, ...(flipY ? { flipY } : {}) })
  switch (k) {
    case '':
    case 'rect':
    case 'rectangle':
    case 'label':
      if (s.rounded === '1' && s.absoluteArcSize !== '1' && (num(s.arcSize) ?? 0) >= 40) return known('terminator')
      return known('process')
    case 'ellipse':
      return known(square ? 'circle' : pick('basic-ellipse', 'circle'))
    case 'fc:manual_operation':
      return known('trapezoid', true)
  }
  const cands = DRAWIO_SHAPES[k]
  if (cands) return known(pick(...cands))
  if (k.startsWith('fc:')) {
    const guess = `fc-${k.slice(3).replace(/_/g, '-')}`
    if (isShapeId(guess)) return known(guess)
  }
  if (isShapeId(key)) return { shape: key, known: true }
  return { shape: 'process', known: false }
}

// ── arrows ──────────────────────────────────────────────────────────────────

function drawioArrow(name: string | undefined, fill: string | undefined, dflt: MapArrowHead): MapArrowHead {
  if (name === undefined || name === '') return dflt
  const open = fill === '0'
  switch (name) {
    case 'none':
      return 'none'
    case 'classic':
    case 'classicThin':
    case 'block':
    case 'blockThin':
      if (open) return name.startsWith('block') ? 'triangle' : 'open'
      return 'arrow'
    case 'open':
    case 'openThin':
    case 'openAsync':
    case 'async':
      return 'open'
    case 'oval':
    case 'circle':
    case 'circlePlus':
      return open ? 'circleOpen' : 'circle'
    case 'diamond':
    case 'diamondThin':
      return open ? 'diamondOpen' : 'diamond'
    case 'dash':
    case 'cross':
    case 'halfCircle':
      return 'bar'
    case 'ERmandOne':
    case 'ERone':
    case 'mandOne':
      return 'crowOne'
    case 'ERmany':
    case 'many':
      return 'crowMany'
    case 'ERoneToMany':
    case 'oneToMany':
      return 'crowOneOrMany'
    case 'ERzeroToOne':
    case 'zeroToOne':
      return 'crowZeroOrOne'
    case 'ERzeroToMany':
    case 'zeroToMany':
      return 'crowZeroOrMany'
    default:
      return 'arrow'
  }
}

function toDrawioArrow(h: MapArrowHead): { name: string; fill: '0' | '1' } {
  switch (h) {
    case 'none':
      return { name: 'none', fill: '1' }
    case 'arrow':
      return { name: 'classic', fill: '1' }
    case 'open':
      return { name: 'open', fill: '1' }
    case 'triangle':
      return { name: 'block', fill: '0' }
    case 'diamond':
      return { name: 'diamond', fill: '1' }
    case 'diamondOpen':
      return { name: 'diamond', fill: '0' }
    case 'circle':
      return { name: 'oval', fill: '1' }
    case 'circleOpen':
      return { name: 'oval', fill: '0' }
    case 'bar':
      return { name: 'dash', fill: '1' }
    case 'crowOne':
      return { name: 'ERmandOne', fill: '0' }
    case 'crowMany':
      return { name: 'ERmany', fill: '0' }
    case 'crowOneOrMany':
      return { name: 'ERoneToMany', fill: '0' }
    case 'crowZeroOrOne':
      return { name: 'ERzeroToOne', fill: '0' }
    case 'crowZeroOrMany':
      return { name: 'ERzeroToMany', fill: '0' }
  }
}

// ── import ──────────────────────────────────────────────────────────────────

interface Cell {
  id: string
  el: XmlEl // the mxCell
  wrapper?: XmlEl // <object>/<UserObject>
  parent?: string
  vertex: boolean
  edge: boolean
  value?: string
  style: { base: string[]; s: Style }
  geo?: XmlEl
}

function collectCells(rootEl: XmlEl): Cell[] {
  const out: Cell[] = []
  const visit = (el: XmlEl): void => {
    for (const c of el.children) {
      if (c.name === 'mxCell') out.push(cellFrom(c))
      else if (c.name === 'object' || c.name === 'UserObject') {
        const inner = c.children.find((x) => x.name === 'mxCell')
        const cell = cellFrom(inner ?? { name: 'mxCell', attrs: {}, children: [], text: '' })
        cell.id = c.attrs.id ?? cell.id
        cell.wrapper = c
        cell.value = c.attrs.label ?? cell.value
        out.push(cell)
      } else visit(c)
    }
  }
  visit(rootEl)
  return out
}

function cellFrom(el: XmlEl): Cell {
  return {
    id: el.attrs.id ?? '',
    el,
    parent: el.attrs.parent,
    vertex: el.attrs.vertex === '1',
    edge: el.attrs.edge === '1',
    value: el.attrs.value,
    style: parseStyle(el.attrs.style),
    geo: el.children.find((c) => c.name === 'mxGeometry')
  }
}

function pageFromModel(model: XmlEl, name: string, warnings: string[]): DrawioPage {
  const cells = collectCells(model)
  const byId = new Map<string, Cell>()
  let anon = 0
  for (const c of cells) {
    if (!c.id) c.id = `cell-${++anon}`
    if (byId.has(c.id)) {
      warnings.push(`${name}: duplicate cell id "${c.id}" — later cell ignored`)
      continue
    }
    byId.set(c.id, c)
  }
  const unique = [...byId.values()]
  // Layers: cells without vertex/edge whose parent is the root (or missing).
  const isLayerish = (c: Cell): boolean => !c.vertex && !c.edge
  const isGroup = (c: Cell): boolean => c.vertex && c.style.base.includes('group')
  const isEdgeLabel = (c: Cell): boolean => {
    const p = c.parent ? byId.get(c.parent) : undefined
    return c.vertex && !!p && p.edge
  }

  // Absolute origin of a cell's coordinate frame (sum of vertex ancestors).
  const absCache = new Map<string, { x: number; y: number }>()
  const geoXY = (c: Cell): { x: number; y: number } => ({ x: num(c.geo?.attrs.x) ?? 0, y: num(c.geo?.attrs.y) ?? 0 })
  const frameOf = (c: Cell, depth = 0): { x: number; y: number } => {
    const p = c.parent ? byId.get(c.parent) : undefined
    if (!p || !p.vertex || depth > 64) return { x: 0, y: 0 }
    const hit = absCache.get(p.id)
    if (hit) return hit
    const f = frameOf(p, depth + 1)
    const g = geoXY(p)
    const abs = { x: f.x + g.x, y: f.y + g.y }
    absCache.set(p.id, abs)
    return abs
  }

  const nodes: MapNode[] = []
  const nodeIds = new Set<string>()
  const unknownShapes = new Map<string, number>()
  const groupOf = new Map<string, string>() // group cell id → groupId used
  const hiddenLayers = new Set(unique.filter((c) => isLayerish(c) && c.el.attrs.visible === '0').map((c) => c.id))
  const lockedLayers = new Set(unique.filter((c) => isLayerish(c) && c.style.s.locked === '1').map((c) => c.id))
  const layerOf = (c: Cell): string | undefined => {
    let cur: Cell | undefined = c
    for (let d = 0; cur && d < 64; d++) {
      const p: Cell | undefined = cur.parent ? byId.get(cur.parent) : undefined
      if (!p) return undefined
      if (isLayerish(p)) return p.id
      cur = p
    }
    return undefined
  }
  // draw.io layers are the layer-ish children of the root. The first is the
  // default layer (our base layer) unless it is hidden or locked; every other
  // one becomes a real layer, keeping its name, visibility and lock.
  const rootIds = new Set(unique.filter((c) => isLayerish(c) && (!c.parent || !byId.has(c.parent))).map((c) => c.id))
  const drawioLayers = unique.filter((c) => isLayerish(c) && !!c.parent && rootIds.has(c.parent))
  const layerMap = new Map<string, MapLayer>()
  drawioLayers.forEach((c, i) => {
    const hidden = hiddenLayers.has(c.id)
    const locked = lockedLayers.has(c.id)
    if (i === 0 && !hidden && !locked) return
    layerMap.set(c.id, { id: `layer-${c.id}`, name: labelOf(c.value, c.style.s) || (i === 0 ? 'Default layer' : `Layer ${i + 1}`), visible: !hidden, locked })
  })

  for (const c of unique) {
    if (!c.vertex || isEdgeLabel(c)) continue
    if (isGroup(c)) {
      groupOf.set(c.id, `g-${c.id}`)
      continue
    }
    const { base, s } = c.style
    const f = frameOf(c)
    const g = geoXY(c)
    const gw0 = num(c.geo?.attrs.width)
    const gh0 = num(c.geo?.attrs.height)
    const pickRes = drawioShape(base, s, gw0 !== undefined && gw0 === gh0)
    if (!pickRes.known) {
      const key = s.shape ?? base[0] ?? '?'
      unknownShapes.set(key, (unknownShapes.get(key) ?? 0) + 1)
    }
    const st: MapNodeStyle = {}
    const fill = s.fillColor
    if (fill === 'none') st.fill = 'none'
    else if (colour(fill)) st.fill = fill
    const fc = colour(s.fontColor)
    if (fc) st.textColor = fc
    const fs = num(s.fontSize)
    if (fs) st.fontSize = fs
    const fst = num(s.fontStyle)
    if (fst) {
      if (fst & 1) st.bold = true
      if (fst & 2) st.italic = true
      if (fst & 4) st.underline = true
      if (fst & 8) st.strike = true
    }
    if (s.fontFamily) st.fontFamily = s.fontFamily
    const sw = num(s.strokeWidth)
    if (sw !== undefined) st.strokeWidth = sw
    if (s.strokeColor === 'none') st.strokeDash = 'none'
    else if (s.dashed === '1') st.strokeDash = s.dashPattern && /^1\s/.test(s.dashPattern) ? 'dotted' : 'dashed'
    const op = num(s.opacity)
    if (op !== undefined && op < 100) st.opacity = Math.max(0, op) / 100
    const fop = num(s.fillOpacity)
    if (fop !== undefined && fop < 100) st.fillOpacity = Math.max(0, fop) / 100
    if (s.rounded === '1' && pickRes.shape === 'process') {
      // absoluteArcSize: arcSize is a diameter in px; otherwise a % of the short side.
      const arc = num(s.arcSize)
      const gw = num(c.geo?.attrs.width) ?? 120
      const gh = num(c.geo?.attrs.height) ?? 48
      st.radius = Math.round(s.absoluteArcSize === '1' ? (arc ?? 20) / 2 : (Math.min(gw, gh) * (arc ?? 15)) / 100)
    }
    if (s.shadow === '1') st.shadow = true
    if (s.align === 'left' || s.align === 'right' || s.align === 'center') st.textAlign = s.align
    if (s.verticalAlign === 'top' || s.verticalAlign === 'bottom' || s.verticalAlign === 'middle') st.vAlign = s.verticalAlign
    const node: MapNode = {
      id: c.id,
      x: round2(f.x + g.x),
      y: round2(f.y + g.y),
      label: labelOf(c.value, s),
      shape: pickRes.shape,
      color: colour(s.plexiColor) ?? (colour(s.strokeColor) && s.strokeColor !== 'none' ? s.strokeColor! : DEFAULT_COLOR)
    }
    const w = num(c.geo?.attrs.width)
    const h = num(c.geo?.attrs.height)
    if (w && w > 0) node.width = round2(w)
    if (h && h > 0) node.height = round2(h)
    if (Object.keys(st).length) node.style = st
    let rot = num(s.rotation) ?? 0
    // draw.io triangles point east by default; ours points north.
    if (pickRes.shape === 'triangle' && !s.plexiShape) {
      const turn: Record<string, number> = { east: 90, south: 180, west: 270, north: 0 }
      rot += turn[s.direction ?? 'east'] ?? 90
    }
    rot = ((rot % 360) + 360) % 360
    if (rot) node.rotation = rot
    const flipY = s.flipV === '1' ? !pickRes.flipY : !!pickRes.flipY
    if (s.flipH === '1') node.flipX = true
    if (flipY) node.flipY = true
    // Visibility and lock that come from a draw.io layer live on our layer;
    // only a cell's OWN visible="0" / locked marks the shape itself.
    const ownLayer = layerOf(c)
    const mapped = ownLayer ? layerMap.get(ownLayer) : undefined
    if (mapped) node.layerId = mapped.id
    if (s.locked === '1' || (!mapped && ownLayer && lockedLayers.has(ownLayer))) node.locked = true
    if (c.el.attrs.visible === '0' || (!mapped && ownLayer && hiddenLayers.has(ownLayer))) node.hidden = true
    if (s.image) node.image = s.image
    // Parent: a container vertex → parentId; a group → groupId.
    const p = c.parent ? byId.get(c.parent) : undefined
    if (p && p.vertex) {
      if (isGroup(p)) node.groupId = `g-${p.id}`
      else node.parentId = p.id
    }
    // Wrapper attributes.
    if (c.wrapper) {
      const a = c.wrapper.attrs
      if (a.link && !a.link.startsWith('data:')) node.link = a.link
      if (a.tooltip) node.description = a.tooltip
      const data: Record<string, string> = {}
      for (const [k, v] of Object.entries(a)) {
        if (['id', 'label', 'link', 'tooltip', 'placeholders'].includes(k)) continue
        data[k] = v
      }
      if (Object.keys(data).length) node.data = data
    }
    nodes.push(node)
    nodeIds.add(node.id)
  }
  // A child of a container that maps to a non-container shape keeps parentId only
  // when the parent is a real node; nested groups resolve to the outermost node.
  for (const n of nodes) {
    if (n.parentId && !nodeIds.has(n.parentId)) delete n.parentId
    if (n.parentId) {
      const p = nodes.find((m) => m.id === n.parentId)!
      if (!getShape(p.shape).container) {
        // Children of plain shapes (draw.io allows it): keep them grouped instead.
        n.groupId = n.groupId ?? `g-${p.id}`
        p.groupId = p.groupId ?? `g-${p.id}`
        delete n.parentId
      }
    }
  }
  for (const [k, count] of unknownShapes) {
    warnings.push(`${name}: ${count} shape(s) of type "${k}" are not supported and were imported as rectangles`)
  }

  // Edge labels from child label cells.
  const childLabels = new Map<string, { text: string; pos?: number }>()
  for (const c of unique) {
    if (!isEdgeLabel(c)) continue
    const text = labelOf(c.value, c.style.s)
    if (!text) continue
    const gx = num(c.geo?.attrs.x)
    const prev = childLabels.get(c.parent!)
    childLabels.set(c.parent!, {
      text: prev ? `${prev.text}\n${text}` : text,
      ...(gx !== undefined && c.geo?.attrs.relative === '1' ? { pos: clamp01((gx + 1) / 2) } : {})
    })
  }

  const edges: MapEdge[] = []
  let dangling = 0
  for (const c of unique) {
    if (!c.edge) continue
    const src = c.el.attrs.source
    const tgt = c.el.attrs.target
    if (!src || !tgt || !nodeIds.has(src) || !nodeIds.has(tgt)) {
      // An edge into a dissolved group attaches to nothing we can represent.
      dangling++
      continue
    }
    const { base, s } = c.style
    const e: MapEdge = { id: c.id, source: src, target: tgt }
    const own = labelOf(c.value, s)
    const child = childLabels.get(c.id)
    const label = [own, child?.text].filter(Boolean).join('\n')
    if (label) e.label = label
    const gx = num(c.geo?.attrs.x)
    if (own && gx !== undefined && gx !== 0) e.labelPos = clamp01((gx + 1) / 2)
    else if (child?.pos !== undefined && child.pos !== 0.5) e.labelPos = child.pos
    let routing: MapRouting = 'straight'
    if (s.curved === '1') routing = 'curved'
    else if (s.edgeStyle && s.edgeStyle !== 'none') routing = 'orthogonal'
    else if (base.includes('orthogonal') || s.orthogonal === '1') routing = 'orthogonal'
    e.routing = routing
    e.endArrow = drawioArrow(s.endArrow, s.endFill, 'arrow')
    e.startArrow = drawioArrow(s.startArrow, s.startFill, 'none')
    if (s.dashed === '1') {
      e.dash = s.dashPattern && /^1\s/.test(s.dashPattern) ? 'dotted' : 'dashed'
      e.style = 'dashed'
    }
    if (s.strokeColor === 'none') e.dash = 'none'
    else if (colour(s.strokeColor)) e.stroke = s.strokeColor
    const sw = num(s.strokeWidth)
    if (sw !== undefined) e.strokeWidth = sw
    const fs = num(s.fontSize)
    if (fs) e.fontSize = fs
    if (colour(s.fontColor)) e.textColor = s.fontColor
    if (s.locked === '1') e.locked = true
    const ex = num(s.exitX)
    const ey = num(s.exitY)
    if (ex !== undefined && ey !== undefined) e.sourceHandle = portId(clamp01(ex), clamp01(ey))
    const nx = num(s.entryX)
    const ny = num(s.entryY)
    if (nx !== undefined && ny !== undefined) e.targetHandle = portId(clamp01(nx), clamp01(ny))
    // Waypoints are in the edge parent's frame.
    const arr = c.geo?.children.find((x) => x.name === 'Array' && x.attrs.as === 'points')
    if (arr) {
      const f = frameOf(c)
      const pts = arr.children
        .filter((p) => p.name === 'mxPoint')
        .map((p) => ({ x: round2(f.x + (num(p.attrs.x) ?? 0)), y: round2(f.y + (num(p.attrs.y) ?? 0)) }))
      if (pts.length) e.waypoints = pts
    }
    if (c.wrapper?.attrs.tooltip) e.description = c.wrapper.attrs.tooltip
    const edgeLayer = layerOf(c)
    if (edgeLayer && layerMap.has(edgeLayer)) e.layerId = layerMap.get(edgeLayer)!.id
    edges.push(e)
  }
  if (dangling) warnings.push(`${name}: ${dangling} edge(s) without both a source and a target shape were skipped`)
  const layers = [...layerMap.values()]
  return { name, nodes, edges, ...(layers.length ? { layers } : {}) }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

export function drawioToMap(xml: string): DrawioImport {
  const warnings: string[] = []
  const pages: DrawioPage[] = []
  try {
    const text = String(xml ?? '')
    if (!text.trim()) {
      warnings.push('The draw.io file is empty')
      return { pages, warnings }
    }
    const doc = parseXml(text, warnings)
    const mxfile = find(doc, 'mxfile')
    if (mxfile) {
      const diagrams = mxfile.children.filter((c) => c.name === 'diagram')
      if (!diagrams.length) warnings.push('The file has no <diagram> pages')
      diagrams.forEach((d, i) => {
        const name = d.attrs.name || `Page-${i + 1}`
        let model = d.children.find((c) => c.name === 'mxGraphModel')
        if (!model) {
          const payload = decodePagePayload(d.text, warnings, name)
          if (payload) {
            const inner = parseXml(payload, warnings)
            model = find(inner, 'mxGraphModel')
          }
        }
        if (!model) {
          warnings.push(`${name}: no graph model found; page skipped`)
          return
        }
        pages.push(pageFromModel(model, name, warnings))
      })
    } else {
      const model = find(doc, 'mxGraphModel')
      if (model) pages.push(pageFromModel(model, 'Page-1', warnings))
      else warnings.push('Not a draw.io file: no <mxfile> or <mxGraphModel> element found')
    }
  } catch (err) {
    warnings.push(`draw.io import failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { pages, warnings }
}

// ── export ──────────────────────────────────────────────────────────────────

function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#xa;')
    .replace(/\r/g, '&#xd;')
    .replace(/\t/g, '&#x9;')
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Style values cannot contain ';' or '='.
function styleVal(v: string): string {
  return v.replace(/[;=]/g, '')
}

// Native draw.io styles for registry ids (so diagrams.net draws the real
// shape); anything not listed falls back to keyword rules, then a rectangle.
const DRAWIO_STYLE: Record<string, string> = {
  terminator: 'rounded=1;arcSize=50;',
  decision: 'rhombus;',
  data: 'shape=parallelogram;perimeter=parallelogramPerimeter;fixedSize=1;',
  database: 'shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=12;',
  circle: 'ellipse;',
  note: 'text;strokeColor=none;fillColor=none;',
  hexagon: 'shape=hexagon;perimeter=hexagonPerimeter2;fixedSize=1;',
  trapezoid: 'shape=trapezoid;perimeter=trapezoidPerimeter;fixedSize=1;',
  chevron: 'shape=step;perimeter=stepPerimeter;fixedSize=1;',
  triangle: 'triangle;direction=north;',
  pentagon: 'shape=mxgraph.basic.pentagon;',
  star: 'shape=mxgraph.basic.star;',
  cross: 'shape=cross;',
  arrow: 'shape=singleArrow;',
  callout: 'shape=callout;perimeter=calloutPerimeter;',
  lane: 'swimlane;horizontal=0;startSize=28;',
  widget: 'rounded=1;arcSize=4;',
  image: 'shape=image;imageAspect=0;aspect=fixed;',
  'fc-document': 'shape=document;boundedLbl=1;',
  'fc-multi-document': 'shape=mxgraph.flowchart.multi-document;',
  'fc-predefined-process': 'shape=process;',
  'fc-internal-storage': 'shape=internalStorage;',
  'fc-manual-input': 'shape=manualInput;',
  'fc-delay': 'shape=delay;',
  'fc-display': 'shape=display;',
  'fc-stored-data': 'shape=dataStorage;',
  'fc-direct-access-storage': 'shape=mxgraph.flowchart.direct_data;',
  'fc-sequential-access': 'shape=mxgraph.flowchart.sequential_data;',
  'fc-off-page-connector': 'shape=offPageConnector;',
  'fc-on-page-reference': 'ellipse;',
  'fc-start-circle': 'ellipse;',
  'fc-card': 'shape=card;',
  'fc-paper-tape': 'shape=tape;',
  'fc-punched-tape': 'shape=tape;',
  'fc-collate': 'shape=mxgraph.flowchart.collate;',
  'fc-sort': 'shape=mxgraph.flowchart.sort;',
  'fc-merge': 'shape=mxgraph.flowchart.merge_or_storage;',
  'fc-extract': 'shape=mxgraph.flowchart.extract_or_measurement;',
  'fc-summing-junction': 'shape=mxgraph.flowchart.summing_function;',
  'fc-or': 'shape=mxgraph.flowchart.or;',
  'fc-loop-limit': 'shape=mxgraph.flowchart.loop_limit;',
  'fc-annotation': 'shape=mxgraph.flowchart.annotation_1;',
  'fc-alternate-process': 'rounded=1;',
  'basic-rounded-rectangle': 'rounded=1;',
  'basic-ellipse': 'ellipse;',
  'basic-diamond': 'rhombus;',
  'basic-parallelogram': 'shape=parallelogram;perimeter=parallelogramPerimeter;fixedSize=1;',
  'basic-trapezoid': 'shape=trapezoid;perimeter=trapezoidPerimeter;fixedSize=1;',
  'basic-hexagon': 'shape=hexagon;perimeter=hexagonPerimeter2;fixedSize=1;',
  'basic-cloud': 'ellipse;shape=cloud;',
  'basic-cube': 'shape=cube;',
  'basic-can': 'shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=12;',
  'basic-folded-corner': 'shape=note;',
  'basic-heart': 'shape=mxgraph.basic.heart;',
  'basic-donut': 'shape=mxgraph.basic.donut;',
  'basic-moon': 'shape=mxgraph.basic.moon;',
  'basic-octagon': 'shape=mxgraph.basic.octagon2;',
  'basic-capsule': 'rounded=1;arcSize=50;',
  'arrow-left-right': 'shape=doubleArrow;',
  'uml-actor': 'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;',
  'uml-note': 'shape=note;size=14;',
  'uml-component': 'shape=component;',
  'uml-package': 'shape=folder;tabWidth=60;tabHeight=16;tabPosition=left;',
  'uml-lifeline': 'shape=umlLifeline;perimeter=lifelinePerimeter;',
  'uml-use-case': 'ellipse;',
  'uml-initial': 'ellipse;fillColor=#000000;',
  'uml-decision': 'rhombus;',
  'bpmn-data-store': 'shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=12;',
  'bpmn-data-object': 'shape=note;size=14;',
  'erd-relationship': 'rhombus;',
  'erd-attribute': 'ellipse;',
  'erd-key-attribute': 'ellipse;fontStyle=4;'
}

// The draw.io base style for a registry shape.
function baseStyleFor(n: MapNode): string {
  const id = n.shape
  if (id === 'process') {
    return (n.style?.radius ?? 0) > 0 ? `rounded=1;absoluteArcSize=1;arcSize=${Math.round(n.style!.radius! * 2)};` : 'rounded=0;'
  }
  const direct = DRAWIO_STYLE[id]
  if (direct) return direct
  const def = getShape(id)
  if (def.container) return 'swimlane;startSize=28;'
  const has = (...w: string[]): boolean => w.some((x) => id.includes(x))
  if (has('gateway', 'decision', 'diamond')) return 'rhombus;'
  if (has('-event', 'circle', 'ellipse', 'oval')) return 'ellipse;'
  if (has('task', 'rounded', 'capsule', 'mind-')) return 'rounded=1;'
  if (has('document')) return 'shape=document;boundedLbl=1;'
  if (has('actor', 'person', 'user')) return 'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;'
  if (has('cloud')) return 'ellipse;shape=cloud;'
  if (has('database', 'cylinder', 'storage')) return 'shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=12;'
  if (has('note', 'sticky')) return 'shape=note;size=14;'
  if (has('hexagon')) return 'shape=hexagon;perimeter=hexagonPerimeter2;fixedSize=1;'
  if (has('triangle')) return 'triangle;direction=north;'
  if (def.special === 'text') return 'text;strokeColor=none;fillColor=none;'
  if (def.special === 'image') return 'shape=image;imageAspect=0;'
  return 'rounded=0;'
}

function nodeStyle(n: MapNode): string {
  const st = n.style ?? {}
  let s = baseStyleFor(n) + 'whiteSpace=wrap;html=1;'
  if (n.shape !== 'note') {
    // Shapes with a built-in fill (stickies, BPMN, …) carry it across explicitly.
    const fill = st.fill ?? getShape(n.shape).defaultStyle?.fill
    if (fill) s += `fillColor=${styleVal(fill)};`
    if (st.strokeDash === 'none') s += 'strokeColor=none;'
    else s += `strokeColor=${styleVal(st.stroke ?? n.color ?? DEFAULT_COLOR)};`
  } else if (n.color) {
    // Free text has no outline in draw.io; keep the accent colour for the trip back.
    s += `plexiColor=${styleVal(n.color)};`
  }
  if (st.strokeDash === 'dashed' || st.strokeDash === 'dashdot') s += 'dashed=1;'
  if (st.strokeDash === 'dotted') s += 'dashed=1;dashPattern=1 4;'
  if (st.strokeWidth !== undefined) s += `strokeWidth=${st.strokeWidth};`
  if (st.textColor) s += `fontColor=${styleVal(st.textColor)};`
  if (st.fontSize) s += `fontSize=${st.fontSize};`
  if (st.fontFamily) s += `fontFamily=${styleVal(st.fontFamily)};`
  const fstyle = (st.bold ? 1 : 0) | (st.italic ? 2 : 0) | (st.underline ? 4 : 0) | (st.strike ? 8 : 0)
  if (fstyle) s += `fontStyle=${fstyle};`
  if (st.opacity !== undefined && st.opacity < 1) s += `opacity=${Math.round(st.opacity * 100)};`
  if (st.fillOpacity !== undefined && st.fillOpacity < 1) s += `fillOpacity=${Math.round(st.fillOpacity * 100)};`
  if (st.shadow) s += 'shadow=1;'
  if (st.textAlign) s += `align=${st.textAlign};`
  if (st.vAlign) s += `verticalAlign=${st.vAlign};`
  if (n.rotation) s += `rotation=${n.rotation};`
  if (n.flipX) s += 'flipH=1;'
  if (n.flipY) s += 'flipV=1;'
  if (n.locked) s += 'locked=1;'
  if (n.image && !n.image.startsWith('data:')) s += `image=${styleVal(n.image)};`
  s += `plexiShape=${styleVal(n.shape)};`
  return s
}

function edgeStyle(e: MapEdge): string {
  let s = ''
  const routing = e.routing ?? 'orthogonal'
  if (routing === 'orthogonal') s += 'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;'
  else if (routing === 'curved') s += 'curved=1;'
  s += 'html=1;'
  const end = toDrawioArrow(e.endArrow ?? 'arrow')
  const start = toDrawioArrow(e.startArrow ?? 'none')
  s += `endArrow=${end.name};endFill=${end.fill};startArrow=${start.name};startFill=${start.fill};`
  const dash = e.dash ?? (e.style === 'dashed' ? 'dashed' : 'solid')
  if (dash === 'dashed' || dash === 'dashdot') s += 'dashed=1;'
  else if (dash === 'dotted') s += 'dashed=1;dashPattern=1 4;'
  if (dash === 'none') s += 'strokeColor=none;'
  else if (e.stroke) s += `strokeColor=${styleVal(e.stroke)};`
  if (e.strokeWidth !== undefined) s += `strokeWidth=${e.strokeWidth};`
  if (e.fontSize) s += `fontSize=${e.fontSize};`
  if (e.textColor) s += `fontColor=${styleVal(e.textColor)};`
  if (e.locked) s += 'locked=1;'
  const sp = parsePort(e.sourceHandle)
  if (sp) s += `exitX=${sp.fx};exitY=${sp.fy};exitDx=0;exitDy=0;`
  const tp = parsePort(e.targetHandle)
  if (tp) s += `entryX=${tp.fx};entryY=${tp.fy};entryDx=0;entryDy=0;`
  return s
}

function labelHtml(label: string): string {
  return escHtml(label).replace(/\n/g, '<br>')
}

function fmt(v: number): string {
  return String(Math.round(v * 100) / 100)
}

export function mapToDrawio(pages: DrawioPage[]): string {
  const out: string[] = ['<mxfile host="PlexiiDiagrams" type="device" compressed="false">']
  pages.forEach((page, pi) => {
    const nodes = page.nodes ?? []
    const edges = page.edges ?? []
    const rootId = '__plx_root'
    const layerId = '__plx_layer'
    const used = new Set([rootId, layerId])
    const cid = new Map<string, string>()
    const uniq = (raw: string): string => {
      let id = raw || 'cell'
      let k = 2
      while (used.has(id)) id = `${raw}-${k++}`
      used.add(id)
      return id
    }
    for (const n of nodes) cid.set(n.id, uniq(n.id))
    const edgeIds = edges.map((e) => uniq(e.id))
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const isContainerNode = (n: MapNode | undefined): boolean => !!n && !!getShape(n.shape).container
    const parentOf = (n: MapNode): MapNode | undefined => {
      const p = n.parentId ? byId.get(n.parentId) : undefined
      return p && p !== n && isContainerNode(p) ? p : undefined
    }
    // Parents must precede children: order by container depth (cycle-safe).
    const depth = (n: MapNode): number => {
      let d = 0
      const seen = new Set<string>([n.id])
      let p = parentOf(n)
      while (p && !seen.has(p.id)) {
        d++
        seen.add(p.id)
        p = parentOf(p)
      }
      return p ? -1 : d // -1 marks a parent cycle → export flat
    }
    const depths = new Map(nodes.map((n) => [n.id, depth(n)]))
    const ordered = [...nodes].sort((a, b) => Math.max(0, depths.get(a.id)!) - Math.max(0, depths.get(b.id)!))

    out.push(`  <diagram id="page-${pi + 1}" name="${escAttr(page.name || `Page-${pi + 1}`)}">`)
    out.push(
      '    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">'
    )
    out.push('      <root>')
    out.push(`        <mxCell id="${rootId}" />`)
    out.push(`        <mxCell id="${layerId}" parent="${rootId}" />`)
    // A shape on a hidden layer exports hidden, as it was drawn.
    const hiddenLayerIds = new Set((page.layers ?? []).filter((l) => !l.visible).map((l) => l.id))
    for (const n of ordered) {
      const p = depths.get(n.id)! > 0 ? parentOf(n) : undefined
      const { w, h } = nodeSize(n)
      const x = p ? n.x - p.x : n.x
      const y = p ? n.y - p.y : n.y
      const parentAttr = p ? cid.get(p.id)! : layerId
      const visible = n.hidden || (n.layerId && hiddenLayerIds.has(n.layerId)) ? ' visible="0"' : ''
      const geo = `<mxGeometry x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" as="geometry" />`
      const style = escAttr(nodeStyle(n))
      const value = escAttr(labelHtml(n.label ?? ''))
      const extra: string[] = []
      if (n.link) extra.push(`link="${escAttr(n.link)}"`)
      if (n.description) extra.push(`tooltip="${escAttr(n.description)}"`)
      for (const [k, v] of Object.entries(n.data ?? {})) {
        const key = k.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^(?=[^A-Za-z_])/, '_')
        if (['id', 'label', 'link', 'tooltip', 'placeholders'].includes(key)) continue
        extra.push(`${key}="${escAttr(String(v))}"`)
      }
      if (extra.length) {
        out.push(`        <UserObject label="${value}" ${extra.join(' ')} id="${escAttr(cid.get(n.id)!)}">`)
        out.push(`          <mxCell style="${style}" vertex="1" parent="${escAttr(parentAttr)}"${visible}>`)
        out.push(`            ${geo}`)
        out.push('          </mxCell>')
        out.push('        </UserObject>')
      } else {
        out.push(
          `        <mxCell id="${escAttr(cid.get(n.id)!)}" value="${value}" style="${style}" vertex="1" parent="${escAttr(parentAttr)}"${visible}>`
        )
        out.push(`          ${geo}`)
        out.push('        </mxCell>')
      }
    }
    edges.forEach((e, ei) => {
      const s = cid.get(e.source)
      const t = cid.get(e.target)
      if (!s || !t) return
      const value = escAttr(labelHtml(e.label ?? ''))
      const lp = e.labelPos !== undefined && e.labelPos !== 0.5 ? ` x="${fmt(e.labelPos * 2 - 1)}"` : ''
      out.push(
        `        <mxCell id="${escAttr(edgeIds[ei]!)}" value="${value}" style="${escAttr(edgeStyle(e))}" edge="1" parent="${layerId}" source="${escAttr(s)}" target="${escAttr(t)}">`
      )
      if (e.waypoints?.length) {
        out.push(`          <mxGeometry${lp} relative="1" as="geometry">`)
        out.push('            <Array as="points">')
        for (const p of e.waypoints) out.push(`              <mxPoint x="${fmt(p.x)}" y="${fmt(p.y)}" />`)
        out.push('            </Array>')
        out.push('          </mxGeometry>')
      } else {
        out.push(`          <mxGeometry${lp} relative="1" as="geometry" />`)
      }
      out.push('        </mxCell>')
    })
    out.push('      </root>')
    out.push('    </mxGraphModel>')
    out.push('  </diagram>')
  })
  out.push('</mxfile>')
  return out.join('\n') + '\n'
}

