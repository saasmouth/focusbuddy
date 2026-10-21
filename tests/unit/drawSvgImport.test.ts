import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { DOMParser as XmlDomParser } from '@xmldom/xmldom'
import { drawToSvg, normalizeDrawBody } from '../../src/shared/draw'
import { cubicAt, flattenPath, pathBounds, subpathSegments, transformPath, type DrawPath } from '../../src/shared/drawGeometry'
import { drawDocForStorage } from '../../src/shared/draw/compat'
import { isV1Representable } from '../../src/shared/draw/migrate'
import type { DrawDoc, DrawGroupNode, DrawImageNode, DrawNode, DrawPathNode, DrawTextNode } from '../../src/shared/draw/model'
import { drawDocToSvg } from '../../src/shared/draw/svg'
import {
  arcToCubics,
  importSvgText,
  importedNodes,
  isUserFacingImportError,
  parsePathData,
  resolveFallbacks,
  sanitizeSvgText,
  svgToDrawDoc,
  SvgImportError,
  SvgRefused,
  type SvgImportOutput,
  type XmlDocument
} from '../../src/shared/draw/import/svg'
import { parseColor } from '../../src/shared/draw/import/svg/color'
import { addStyleSheet, cascadedStyle, emptySheets } from '../../src/shared/draw/import/svg/css'
import { parseLength } from '../../src/shared/draw/import/svg/numbers'
import { gradientToV1, stopAt } from '../../src/shared/draw/import/svg/paint'
import { decompose, parseTransform } from '../../src/shared/draw/import/svg/transform'
import { decodeSvgBytes } from '../../src/shared/draw/import/svg/sanitize'
import { actualSize, base64ToBytes, bytesToBase64, rasterInfo, sniffImportKind } from '../../src/shared/draw/import/imageInfo'

// The SVG importer (WP-IMPORT). XML is parsed with @xmldom/xmldom here (a
// standards XML DOM; the app uses Chromium's DOMParser). Both satisfy the
// importer's small XmlDocument interface; everything that keeps hostile input
// inert happens BEFORE the parser (sanitize.ts) or in the importer itself, so
// it does not depend on which parser runs.

function parseXml(s: string): XmlDocument {
  // Like Chromium's DOMParser, malformed XML comes back as a <parsererror> document.
  const errors: string[] = []
  const doc = new XmlDomParser({
    errorHandler: { warning: () => {}, error: (m: string) => errors.push(String(m)), fatalError: (m: string) => errors.push(String(m)) }
  } as never).parseFromString(s, 'image/svg+xml') as unknown as XmlDocument
  if (!errors.length) return doc
  return new XmlDomParser().parseFromString(`<parsererror>${errors[0].replace(/[<&]/g, ' ')}</parsererror>`, 'text/xml') as unknown as XmlDocument
}

let seq = 0
const newId = (p: string): string => `${p}-${++seq}`

function imp(svg: string, opts: Partial<{ mode: 'open' | 'import'; structure: 'v1' | 'v2' }> = {}): SvgImportOutput {
  return importSvgText(svg, parseXml, { mode: opts.mode ?? 'import', structure: opts.structure ?? 'v2', newId })
}

function nodes(svg: string, opts: Partial<{ mode: 'open' | 'import'; structure: 'v1' | 'v2' }> = {}): DrawNode[] {
  return importedNodes(imp(svg, opts))
}

function svg(body: string, attrs = 'viewBox="0 0 200 200" width="200" height="200"'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`
}

function flat(list: DrawNode[]): DrawNode[] {
  return list.flatMap((n) => (n.type === 'group' ? [n, ...flat(n.children)] : [n]))
}

function paths(list: DrawNode[]): DrawPathNode[] {
  return flat(list).filter((n): n is DrawPathNode => n.type === 'path')
}

function box(p: DrawPath): { x: number; y: number; w: number; h: number } {
  const b = pathBounds(p, 0.01)
  return { x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h) }
}

function round(v: number, k = 1000): number {
  const r = Math.round(v * k) / k
  return Object.is(r, -0) ? 0 : r
}

const FIXTURES = join(__dirname, '../fixtures/draw/svg')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

// ── Path data ────────────────────────────────────────────────────────────────

describe('path data: every command', () => {
  it('reads M L H V Z, absolute and relative, with implicit line-tos after a move', () => {
    const { path, error } = parsePathData('M10 10 L20 10 H30 V20 l-10 0 h-5 v-5 z m50 0 10 0 0 10 z')
    expect(error).toBeUndefined()
    expect(path.subpaths).toHaveLength(2)
    expect(path.subpaths[0]).toEqual({
      closed: true,
      nodes: [
        { x: 10, y: 10 },
        { x: 20, y: 10 },
        { x: 30, y: 10 },
        { x: 30, y: 20 },
        { x: 20, y: 20 },
        { x: 15, y: 20 },
        { x: 15, y: 15 }
      ]
    })
    // After z the pen is back at the subpath start (10,10), so m50 0 starts at (60,10).
    expect(path.subpaths[1].nodes).toEqual([
      { x: 60, y: 10 },
      { x: 70, y: 10 },
      { x: 70, y: 20 }
    ])
  })

  it('reads the number grammar exporters actually write', () => {
    // "1.5.5" is 1.5 then .5; "-1-2" is -1 then -2; exponents; no separators.
    const { path } = parsePathData('M1.5.5L-1-2l1e1,2E-1L.5.5')
    expect(path.subpaths[0].nodes.map((n) => [n.x, n.y])).toEqual([
      [1.5, 0.5],
      [-1, -2],
      [9, -1.8],
      [0.5, 0.5]
    ])
  })

  it('C and S: absolute handles, and S reflects the previous control point', () => {
    const { path } = parsePathData('M0 0 C10 0 20 10 20 20 S30 40 40 40')
    const [a, b, c] = path.subpaths[0].nodes
    expect(a).toEqual({ x: 0, y: 0, outX: 10, outY: 0 })
    expect(b).toEqual({ x: 20, y: 20, inX: 20, inY: 10, outX: 20, outY: 30 })
    expect(c).toEqual({ x: 40, y: 40, inX: 30, inY: 40 })
  })

  it('Q and T become the exactly equivalent cubic', () => {
    const { path } = parsePathData('M0 0 Q50 100 100 0 T200 0')
    const segs = subpathSegments(path.subpaths[0])
    // The quadratic's midpoint is (0 + 2*50 + 100)/4, (0 + 2*100 + 0)/4.
    const m = cubicAt(segs[0], 0.5)
    expect([round(m.x), round(m.y)]).toEqual([50, 50])
    // T reflects (50,100) about (100,0): control (150,-100), midpoint (150,-50).
    const m2 = cubicAt(segs[1], 0.5)
    expect([round(m2.x), round(m2.y)]).toEqual([150, -50])
  })

  it('a closing segment that lands on the start folds into the start node (no zero-length segment)', () => {
    const { path } = parsePathData('M10 0 C20 0 20 20 10 20 C0 20 0 0 10 0 Z')
    const sp = path.subpaths[0]
    expect(sp.closed).toBe(true)
    expect(sp.nodes).toHaveLength(2)
    expect(sp.nodes[0]).toMatchObject({ x: 10, y: 0, inX: 0, inY: 0, outX: 20, outY: 0 })
  })

  it('keeps everything before an error, as a browser draws it', () => {
    const r = parsePathData('M0 0 L10 10 L20 # 30 30')
    expect(r.error).toBeTruthy()
    expect(r.path.subpaths[0].nodes).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 10 }
    ])
    expect(parsePathData('L10 10').error).toMatch(/move/)
  })

  it('compact arc flags ("a1 1 0 01 1 1") read as flags, not numbers', () => {
    const { path, error } = parsePathData('M0 0a10 10 0 0110 10')
    expect(error).toBeUndefined()
    const last = path.subpaths[0].nodes.at(-1)!
    expect([round(last.x), round(last.y)]).toEqual([10, 10])
  })
})

// ── Arcs (W3C-style reference cases) ─────────────────────────────────────────

/**
 * An INDEPENDENT reference for an SVG arc, derived geometrically rather than
 * with the spec's algebra: in the frame where the ellipse is a unit circle,
 * the centre is at distance 1 from both endpoints (two candidates, mirror
 * images across the chord); the flags pick one. Radii too small are scaled
 * up until the endpoints are a diameter apart.
 */
function referenceArc(x1: number, y1: number, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, x2: number, y2: number) {
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  const phi = (phiDeg * Math.PI) / 180
  const toUnit = (x: number, y: number, k: number): [number, number] => {
    const c = Math.cos(phi)
    const s = Math.sin(phi)
    return [(c * x + s * y) / (rx * k), (-s * x + c * y) / (ry * k)]
  }
  let k = 1
  let [ax, ay] = toUnit(x1, y1, 1)
  let [bx, by] = toUnit(x2, y2, 1)
  let d = Math.hypot(bx - ax, by - ay)
  if (d > 2) {
    k = d / 2
    ;[ax, ay] = toUnit(x1, y1, k)
    ;[bx, by] = toUnit(x2, y2, k)
    d = 2
  }
  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  const h = Math.sqrt(Math.max(0, 1 - (d / 2) ** 2))
  const nx = -(by - ay) / d
  const ny = (bx - ax) / d
  const candidates = [
    [mx + nx * h, my + ny * h],
    [mx - nx * h, my - ny * h]
  ]
  for (const [cx, cy] of candidates) {
    const t1 = Math.atan2(ay - cy, ax - cx)
    let dt = Math.atan2(by - cy, bx - cx) - t1
    if (sweep && dt < 0) dt += 2 * Math.PI
    if (!sweep && dt > 0) dt -= 2 * Math.PI
    if (Math.abs(dt) > Math.PI + 1e-9 === large || Math.abs(Math.abs(dt) - Math.PI) < 1e-9) {
      const back = (u: number, v: number): [number, number] => {
        const X = u * rx * k
        const Y = v * ry * k
        const c = Math.cos(phi)
        const s = Math.sin(phi)
        return [c * X - s * Y, s * X + c * Y]
      }
      return {
        at: (t: number): [number, number] => back(cx + Math.cos(t1 + dt * t), cy + Math.sin(t1 + dt * t)),
        onEllipse: (x: number, y: number): number => {
          const [u, v] = toUnit(x, y, k)
          // Distance from the ellipse, in user units (radial error times the smaller radius).
          return Math.abs(Math.hypot(u - cx, v - cy) - 1) * Math.min(rx, ry) * k
        }
      }
    }
  }
  throw new Error('no reference centre')
}

const ARCS: Array<[string, number, number, number, number, number, 0 | 1, 0 | 1, number, number]> = [
  // The four arcs between the same two points (the classic arcs-01 picture).
  ['large=0 sweep=0', 125, 75, 100, 50, 0, 0, 0, 225, 125],
  ['large=0 sweep=1', 125, 75, 100, 50, 0, 0, 1, 225, 125],
  ['large=1 sweep=0', 125, 75, 100, 50, 0, 1, 0, 225, 125],
  ['large=1 sweep=1', 125, 75, 100, 50, 0, 1, 1, 225, 125],
  ['rotated 30°', 50, 50, 60, 25, 30, 0, 1, 150, 90],
  ['rotated -45°, large', 300, 200, 80, 40, -45, 1, 0, 340, 260],
  ['radii too small (scaled up to a half circle)', 0, 0, 1, 1, 0, 0, 1, 100, 0],
  ['negative radii mean their absolute value', 10, 10, -40, -20, 0, 1, 1, 70, 30],
  ['rotation past a full turn', 0, 0, 50, 20, 390, 0, 0, 60, 40],
  ['near-full ellipse', 100, 100, 50, 50, 0, 1, 1, 100.5, 100]
]

describe('arcs become cubics within 0.5px of the true ellipse', () => {
  it.each(ARCS)('%s', (_name, x1, y1, rx, ry, phi, large, sweep, x2, y2) => {
    const ref = referenceArc(x1, y1, rx, ry, phi, large === 1, sweep === 1, x2, y2)
    const pieces = arcToCubics(x1, y1, rx, ry, phi, large === 1, sweep === 1, x2, y2)
    expect(pieces.length).toBeGreaterThan(0)
    // Ends exactly where it should.
    expect(pieces.at(-1)!.slice(4)).toEqual([x2, y2])
    let px = x1
    let py = y1
    let maxErr = 0
    const samples: Array<[number, number]> = []
    for (const [c1x, c1y, c2x, c2y, ex, ey] of pieces) {
      const c = { p0: { x: px, y: py }, p1: { x: c1x, y: c1y }, p2: { x: c2x, y: c2y }, p3: { x: ex, y: ey } }
      for (let t = 0; t <= 1; t += 0.125) {
        const p = cubicAt(c, t)
        maxErr = Math.max(maxErr, ref.onEllipse(p.x, p.y))
        samples.push([p.x, p.y])
      }
      px = ex
      py = ey
    }
    expect(maxErr).toBeLessThan(0.5)
    // The arc's own midpoint is on the reference arc (right centre, right direction).
    const [mx, my] = ref.at(0.5)
    const nearest = Math.min(...samples.map(([x, y]) => Math.hypot(x - mx, y - my)))
    expect(nearest).toBeLessThan(0.5 + Math.max(Math.abs(rx), Math.abs(ry)) * 0.05)
  })

  it('zero radius is a straight line, and coincident endpoints draw nothing', () => {
    expect(arcToCubics(0, 0, 0, 10, 0, false, true, 10, 0)).toEqual([[0, 0, 10, 0, 10, 0]])
    expect(arcToCubics(5, 5, 10, 10, 0, false, true, 5, 5)).toEqual([])
  })

  it('an arc in path data imports at the same place (A and a)', () => {
    const p = paths(nodes(svg('<path d="M10 100 A50 50 0 0 1 110 100 a50 50 0 0 1 -100 0" fill="red"/>')))[0]
    expect(box(p.path)).toEqual({ x: 10, y: 50, w: 100, h: 100 })
  })
})

// ── Transforms, units, colours, CSS ──────────────────────────────────────────

describe('transform attributes', () => {
  it('compose left to right, each function in SVG order', () => {
    const m = parseTransform('translate(10,20) rotate(90) scale(2 3)')!
    // A point (1,1): scale -> (2,3), rotate 90 -> (-3,2), translate -> (7,22).
    const x = m[0] * 1 + m[2] * 1 + m[4]
    const y = m[1] * 1 + m[3] * 1 + m[5]
    expect([round(x), round(y)]).toEqual([7, 22])
  })

  it('rotate about a point, skews, matrix, CSS units, and malformed lists', () => {
    const r = parseTransform('rotate(180 50 50)')!
    expect(r.map((v) => round(v))).toEqual([-1, 0, 0, -1, 100, 100])
    expect(parseTransform('skewX(45)')!.map((v) => round(v))).toEqual([1, 0, 1, 1, 0, 0])
    expect(parseTransform('skewY(45)')!.map((v) => round(v))).toEqual([1, 1, 0, 1, 0, 0])
    expect(parseTransform('matrix(1,2,3,4,5,6)')).toEqual([1, 2, 3, 4, 5, 6])
    expect(parseTransform('translate(10px, 5px) rotate(90deg)')!.map((v) => round(v))).toEqual([0, 1, -1, 0, 10, 5])
    expect(parseTransform('rotate(45')).toBeNull()
    expect(parseTransform('translate(1,2) wobble(3)')).toBeNull()
    expect(parseTransform('matrix(1 2 3)')).toBeNull()
  })

  it('decompose splits rotation, scale and shear exactly', () => {
    const q = decompose(parseTransform('translate(5 6) rotate(30) scale(2 3) skewX(10)')!)
    expect(round(q.theta)).toBe(30)
    expect(round(q.sx)).toBe(2)
    expect(round(q.sy)).toBe(3)
    // L = R(30) . [[2, 2 tan 10], [0, 3]]: the shear factor is tan 10 degrees.
    expect(round(q.shear, 1e6)).toBe(round(Math.tan(Math.PI / 18), 1e6))
  })
})

describe('lengths and colours', () => {
  it('units, percentages and font-relative lengths', () => {
    const ctx = { vw: 200, vh: 100, fontSize: 10 }
    expect(parseLength('1in', 'x', ctx)).toBe(96)
    expect(parseLength('72pt', 'x', ctx)).toBe(96)
    expect(round(parseLength('25.4mm', 'x', ctx)!)).toBe(96)
    expect(parseLength('2em', 'x', ctx)).toBe(20)
    expect(parseLength('50%', 'x', ctx)).toBe(100)
    expect(parseLength('50%', 'y', ctx)).toBe(50)
    expect(parseLength('1e400', 'x', ctx)).toBeNull()
    expect(parseLength('10 px', 'x', ctx)).toBe(10)
    expect(parseLength('ten', 'x', ctx)).toBeNull()
  })

  it('every colour syntax exporters use, reduced to #rrggbb + alpha', () => {
    expect(parseColor('#F00')).toEqual({ hex: '#ff0000', alpha: 1 })
    expect(parseColor('#ff000080')).toEqual({ hex: '#ff0000', alpha: 128 / 255 })
    expect(parseColor('#f008')!.alpha).toBeCloseTo(0x88 / 255)
    expect(parseColor('rgb(255, 0, 128)')).toEqual({ hex: '#ff0080', alpha: 1 })
    expect(parseColor('rgb(100%,50%,0%)')).toEqual({ hex: '#ff8000', alpha: 1 })
    expect(parseColor('rgba(0,0,0,.25)')).toEqual({ hex: '#000000', alpha: 0.25 })
    expect(parseColor('rgb(0 0 255 / 50%)')).toEqual({ hex: '#0000ff', alpha: 0.5 })
    expect(parseColor('hsl(120, 100%, 25%)')).toEqual({ hex: '#008000', alpha: 1 })
    expect(parseColor('RebeccaPurple')).toEqual({ hex: '#663399', alpha: 1 })
    expect(parseColor('transparent')).toEqual({ hex: '#000000', alpha: 0 })
    for (const bad of ['', 'url(#x)', 'red;x:y', 'rgb(1,2)', '#12', 'expression(1)', 'notacolour']) expect(parseColor(bad), bad).toBeNull()
  })
})

describe('CSS: style attributes and <style> rules with the real cascade', () => {
  const doc = parseXml(
    svg(
      '<g class="outer"><rect id="r" class="a b" fill="green" style="stroke: blue"/><circle class="a"/></g><rect class="a" style="fill:yellow !important"/>'
    )
  )
  const root = doc.documentElement!
  const sheets = emptySheets()
  addStyleSheet(
    sheets,
    `/* comment */ .a { fill: red; stroke-width: 2 } .a.b { fill: purple } #r { opacity: .5 } .outer > circle { fill: teal }
     g .b { stroke: black } rect:hover { fill: pink } @import url(http://evil.example/x.css); @media print { .a { fill: white } }
     .a { stroke-linecap: round !important } rect { fill: orange }`
  )
  const kids = (el: unknown): Array<{ localName: string }> => Array.from((el as { childNodes: ArrayLike<{ nodeType: number }> }).childNodes).filter((n) => n.nodeType === 1) as never
  const g = kids(root)[0]
  const [rect, circle] = kids(g)
  const lone = kids(root)[1]

  it('specificity, order, and the style attribute over rules', () => {
    const r = cascadedStyle(rect as never, sheets)
    expect(r.get('fill')).toBe('purple') // .a.b beats .a and rect
    expect(r.get('opacity')).toBe('.5')
    expect(r.get('stroke')).toBe('blue') // the style attribute beats g .b
    expect(r.get('stroke-width')).toBe('2')
    expect(cascadedStyle(circle as never, sheets).get('fill')).toBe('teal')
    // !important in a style attribute beats any rule.
    expect(cascadedStyle(lone as never, sheets).get('fill')).toBe('yellow')
  })

  it('skips what it does not evaluate, and never follows @import', () => {
    expect(sheets.skippedSelectors).toBe(1)
    expect(sheets.imports).toBe(1)
    expect(sheets.atRules).toBe(1)
  })

  it('presentation attributes lose to CSS, CSS loses to style=""', () => {
    const p = paths(
      nodes(
        svg(
          '<style>.k{fill:#00ff00}</style><rect class="k" fill="#ff0000" width="10" height="10"/><rect class="k" style="fill:#0000ff" width="10" height="10"/><rect fill="#ff0000" width="10" height="10"/>'
        )
      )
    )
    expect(p.map((x) => (x.fill as { color: string }).color)).toEqual(['#00ff00', '#0000ff', '#ff0000'])
  })
})

// ── Shapes, structure and styling ────────────────────────────────────────────

describe('shapes and their styling', () => {
  it('rect (with rx only), circle, ellipse, line, polyline, polygon', () => {
    const list = paths(
      nodes(
        svg(
          '<rect x="10" y="10" width="40" height="20" rx="5"/><circle cx="100" cy="100" r="10"/><ellipse cx="50" cy="150" rx="20" ry="10"/>' +
            '<line x1="0" y1="0" x2="100" y2="50" stroke="black"/><polyline points="0,0 10,10 20,0" fill="none" stroke="red"/><polygon points="0 0 10 0 5 8 7"/>'
        )
      )
    )
    expect(list.map((p) => p.shapeKind ?? 'path')).toEqual(['roundRect', 'ellipse', 'ellipse', 'line', 'path', 'path'])
    expect(list[0].cornerRadius).toBe(5)
    expect(box(list[0].path)).toEqual({ x: 10, y: 10, w: 40, h: 20 })
    expect(box(list[1].path)).toEqual({ x: 90, y: 90, w: 20, h: 20 })
    expect(box(list[2].path)).toEqual({ x: 30, y: 140, w: 40, h: 20 })
    expect(list[3].fill).toEqual({ type: 'none' })
    expect(list[4].path.subpaths[0].closed).toBe(false)
    // An odd number of coordinates drops the last one.
    expect(list[5].path.subpaths[0].nodes).toHaveLength(3)
    expect(list[5].path.subpaths[0].closed).toBe(true)
  })

  it('fill, stroke and every stroke property, with opacity folded into the paints', () => {
    const [p] = paths(
      nodes(
        svg(
          '<path d="M0 0H10V10Z" fill="#ff0000" fill-opacity="0.5" fill-rule="evenodd" stroke="rgba(0,0,255,0.5)" stroke-opacity="0.5" stroke-width="3" stroke-linecap="round" stroke-linejoin="bevel" stroke-miterlimit="8" stroke-dasharray="4 2 1" opacity="0.75" style="mix-blend-mode:multiply"/>'
        )
      )
    )
    expect(p.fill).toEqual({ type: 'solid', color: '#ff0000', opacity: 0.5 })
    expect(p.path.fillRule).toBe('evenodd')
    expect(p.stroke).toEqual({ paint: { type: 'solid', color: '#0000ff', opacity: 0.25 }, width: 3, cap: 'round', join: 'bevel', miterLimit: 8, dash: [4, 2, 1, 4, 2, 1] })
    expect(p.opacity).toBe(0.75)
    expect(p.blend).toBe('multiply')
  })

  it('inherits paint through groups; currentColor; inherit; display and visibility', () => {
    const list = nodes(
      svg(
        '<g fill="#123456" stroke="#000000" color="#ff00ff"><rect width="1" height="1"/><rect width="1" height="1" fill="currentColor"/><g fill="#00ff00"><rect width="1" height="1" fill="inherit"/></g>' +
          '<rect width="1" height="1" display="none"/><rect width="1" height="1" visibility="hidden"/></g>'
      )
    )
    const p = paths(list)
    expect(p.map((x) => (x.fill as { color: string }).color)).toEqual(['#123456', '#ff00ff', '#00ff00', '#123456'])
    expect(p[3].hidden).toBe(true)
    expect(p.every((x) => x.stroke?.width === 1)).toBe(true)
  })

  it('transforms are baked into path coordinates; strokes scale with them', () => {
    const [p] = paths(nodes(svg('<g transform="translate(100 50) scale(2)"><rect x="0" y="0" width="10" height="5" stroke="#000" stroke-width="1.5"/></g>')))
    expect(box(p.path)).toEqual({ x: 100, y: 50, w: 20, h: 10 })
    expect(p.stroke?.width).toBe(3)
    // A rotated rectangle is a plain path now, not a live rectangle.
    const [r] = paths(nodes(svg('<rect width="10" height="10" transform="rotate(45)"/>')))
    expect(r.shapeKind).toBeUndefined()
  })

  it('a viewBox maps onto width and height (with preserveAspectRatio)', () => {
    const out = imp(svg('<rect x="0" y="0" width="10" height="10"/>', 'viewBox="0 0 10 10" width="100mm" height="50mm"'), { mode: 'open' })
    expect(round(out.width, 100)).toBe(377.95)
    expect(round(out.height, 100)).toBe(188.98)
    const [p] = paths(importedNodes(out))
    // Meet: the 10x10 box scales by the smaller ratio and is centred horizontally.
    expect(box(p.path)).toEqual({ x: round((377.952756 - 188.976378) / 2), y: 0, w: round(188.976378), h: round(188.976378) })
  })

  it('groups keep their names, opacity and blend; Illustrator ids are decoded into names', () => {
    const [g] = nodes(svg('<g id="Big_x20_Logo" opacity="0.5" style="mix-blend-mode:screen"><rect width="1" height="1"/></g><g data-name="Named"><rect width="1" height="1"/></g>'))
    expect(g).toMatchObject({ type: 'group', name: 'Big Logo', opacity: 0.5, blend: 'screen' })
  })

  it('use: symbols with viewBox, plain elements, x/y offsets, transforms, nested uses', () => {
    const list = paths(
      nodes(
        svg(
          '<defs><symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol><rect id="r" width="5" height="5" fill="#ff0000"/><use id="u2" xlink:href="#r" x="1"/></defs>' +
            '<use href="#s" x="20" y="20" width="40" height="40"/><use xlink:href="#r" x="100" transform="translate(0 50)"/><use xlink:href="#u2" x="10"/>'
        )
      )
    )
    expect(box(list[0].path)).toEqual({ x: 20, y: 20, w: 40, h: 40 })
    expect(box(list[1].path)).toEqual({ x: 100, y: 50, w: 5, h: 5 })
    expect(box(list[2].path)).toEqual({ x: 11, y: 0, w: 5, h: 5 })
  })

  it('switch draws its first applicable child; nested svg is a viewport', () => {
    const list = paths(
      nodes(
        svg(
          '<switch><g requiredExtensions="http://example.com/x"><rect width="99" height="99"/></g><rect width="7" height="7"/></switch>' +
            '<svg x="50" y="50" width="20" height="20" viewBox="0 0 2 2"><rect width="1" height="1"/></svg>'
        )
      )
    )
    expect(list.map((p) => box(p.path))).toEqual([
      { x: 0, y: 0, w: 7, h: 7 },
      { x: 50, y: 50, w: 10, h: 10 }
    ])
  })

  it('clip-path becomes a clipping group (user space and objectBoundingBox units)', () => {
    const [g] = nodes(svg('<clipPath id="c"><circle cx="50" cy="50" r="40"/></clipPath><rect width="100" height="100" fill="red" clip-path="url(#c)"/>')) as DrawGroupNode[]
    expect(g.type).toBe('group')
    expect(g.clip).toBe(true)
    const clip = g.children.at(-1) as DrawPathNode
    expect(box(clip.path)).toEqual({ x: 10, y: 10, w: 80, h: 80 })
    const [g2] = nodes(
      svg('<clipPath id="c" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="0.5" height="1"/></clipPath><rect x="20" y="20" width="100" height="50" clip-path="url(#c)"/>')
    ) as DrawGroupNode[]
    expect(box((g2.children.at(-1) as DrawPathNode).path)).toEqual({ x: 20, y: 20, w: 50, h: 50 })
  })

  it('markers are drawn as vector art at the right places and angles', () => {
    const list = nodes(
      svg(
        '<marker id="m" markerWidth="10" markerHeight="10" refX="0" refY="0" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 -2 L4 0 L0 2 Z" fill="#000"/></marker>' +
          '<path d="M10 10 L10 60" stroke="#000" marker-end="url(#m)" marker-start="url(#m)"/>'
      )
    )
    const [grp] = list as DrawGroupNode[]
    expect(grp.type).toBe('group')
    const markers = grp.children.filter((c) => c.type === 'group') as DrawGroupNode[]
    expect(markers).toHaveLength(2)
    // The end marker points down the path (+y): its tip is 4 units past (10,60).
    const end = (markers[1].children[0] as DrawPathNode).path.subpaths[0].nodes
    expect(round(end[1].x)).toBe(10)
    expect(round(end[1].y)).toBe(64)
  })
})

// ── Gradients ────────────────────────────────────────────────────────────────

/** The gradient parameter a model linear paint gives at document point p on a shape with box b. */
function modelLinearAt(paint: { from?: { x: number; y: number }; to?: { x: number; y: number } }, b: { x: number; y: number; w: number; h: number }, p: [number, number]): number {
  const q = [(p[0] - b.x) / b.w, (p[1] - b.y) / b.h]
  const F = paint.from!
  const T = paint.to!
  const dx = T.x - F.x
  const dy = T.y - F.y
  return ((q[0] - F.x) * dx + (q[1] - F.y) * dy) / (dx * dx + dy * dy)
}

describe('gradients', () => {
  it('a userSpaceOnUse linear gradient under transforms converts EXACTLY', () => {
    const src =
      '<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="60" y2="20" gradientTransform="rotate(20 30 30) skewX(10)"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>' +
      '<g transform="translate(20 10) scale(1.5 0.8)"><rect x="0" y="0" width="80" height="60" fill="url(#g)"/></g>'
    const [p] = paths(nodes(svg(src)))
    expect(p.fill.type).toBe('linear')
    const b = pathBounds(p.path, 0.01)
    // Reference: the SVG definition evaluated directly at document points.
    const ctm = parseTransform('translate(20 10) scale(1.5 0.8)')!
    const gt = parseTransform('rotate(20 30 30) skewX(10)')!
    const inv = (m: number[]): number[] => {
      const d = m[0] * m[3] - m[1] * m[2]
      return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]
    }
    const full = [ctm, gt].reduce((a, m) => [a[0] * m[0] + a[2] * m[1], a[1] * m[0] + a[3] * m[1], a[0] * m[2] + a[2] * m[3], a[1] * m[2] + a[3] * m[3], a[0] * m[4] + a[2] * m[5] + a[4], a[1] * m[4] + a[3] * m[5] + a[5]])
    const fi = inv(full)
    for (const pt of [
      [30, 20],
      [100, 50],
      [80, 15],
      [140, 55]
    ] as Array<[number, number]>) {
      const gx = fi[0] * pt[0] + fi[2] * pt[1] + fi[4]
      const gy = fi[1] * pt[0] + fi[3] * pt[1] + fi[5]
      const ref = ((gx - 10) * 50 + (gy - 0) * 20) / (50 * 50 + 20 * 20)
      expect(modelLinearAt(p.fill as never, b, pt)).toBeCloseTo(ref, 5)
    }
  })

  it('objectBoundingBox gradients, percent offsets, stop-opacity, href inheritance, monotonic stops', () => {
    const src =
      '<linearGradient id="base"><stop offset="20%" stop-color="red"/><stop offset="10%" stop-color="blue" stop-opacity=".5"/><stop offset="1" style="stop-color:#00ff00"/></linearGradient>' +
      '<linearGradient id="g" xlink:href="#base" x1="0" y1="0" x2="0" y2="1"/>' +
      '<rect width="100" height="40" fill="url(#g)" fill-opacity="0.5"/>'
    const [p] = paths(nodes(svg(src)))
    const f = p.fill as { type: string; stops: unknown[]; from: unknown; to: unknown }
    expect(f.type).toBe('linear')
    expect(f.from).toEqual({ x: 0, y: 0 })
    expect(f.to).toEqual({ x: 0, y: 1 })
    expect(f.stops).toEqual([
      { offset: 0.2, color: '#ff0000', opacity: 0.5 },
      { offset: 0.2, color: '#0000ff', opacity: 0.25 },
      { offset: 1, color: '#00ff00', opacity: 0.5 }
    ])
  })

  it('radial: exact when it stays round, approximated (and reported) when stretched', () => {
    const exact = imp(svg('<radialGradient id="g" cx="0.5" cy="0.5" r="0.5" fx="0.25" fy="0.5"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient><rect width="50" height="50" fill="url(#g)"/>'))
    expect(paths(importedNodes(exact))[0].fill).toMatchObject({ type: 'radial', center: { x: 0.5, y: 0.5 }, radius: 0.5, focal: { x: 0.25, y: 0.5 } })
    expect(exact.report.lines().join(' ')).not.toMatch(/radial/)
    const stretched = imp(svg('<radialGradient id="g" gradientUnits="userSpaceOnUse" cx="50" cy="50" r="20" gradientTransform="scale(2 1)"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient><rect width="200" height="200" fill="url(#g)"/>'))
    expect(stretched.report.lines().join(' ')).toMatch(/1 radial gradient was stretched/)
  })

  it('one stop is a solid colour; none is no paint; a missing reference uses the fallback colour', () => {
    const p = paths(
      nodes(
        svg(
          '<linearGradient id="one"><stop offset="0" stop-color="#abcdef"/></linearGradient><linearGradient id="none"/>' +
            '<rect width="5" height="5" fill="url(#one)"/><rect width="5" height="5" fill="url(#none)"/><rect width="5" height="5" fill="url(#missing) #00ff00"/><rect width="5" height="5" fill="url(#missing)"/>'
        )
      )
    )
    expect(p.map((x) => x.fill)).toEqual([{ type: 'solid', color: '#abcdef' }, { type: 'none' }, { type: 'solid', color: '#00ff00' }, { type: 'none' }])
  })

  it('reflect / repeat spreads are imported as pad, and reported', () => {
    const out = imp(svg('<linearGradient id="g" spreadMethod="reflect" x2="0.5"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient><rect width="5" height="5" fill="url(#g)"/>'))
    expect(out.report.lines().join(' ')).toMatch(/repeats or reflects/)
  })
})

// ── Text ─────────────────────────────────────────────────────────────────────

describe('text', () => {
  it('Illustrator: text placed by a matrix, PostScript font names, CSS classes', () => {
    const [t] = nodes(svg('<style>.a{font-family:\'MyriadPro-BoldIt\';font-size:12px;fill:#333}</style><text transform="matrix(1 0 0 1 20 130)" class="a">Hello</text>')) as DrawTextNode[]
    expect(t).toMatchObject({ type: 'text', x: 20, y: 118, fontSize: 12, fontFamily: "'Myriad Pro'", fontWeight: 700, italic: true, text: 'Hello', fill: { type: 'solid', color: '#333333' } })
  })

  it('Figma: preserved whitespace, letter-spacing in em, a weight', () => {
    const [t] = nodes(svg('<text fill="#212529" xml:space="preserve" style="white-space: pre" font-family="Inter" font-size="16" font-weight="600" letter-spacing="0.1em"><tspan x="24" y="40">Two  spaces</tspan></text>')) as DrawTextNode[]
    expect(t).toMatchObject({ text: 'Two  spaces', fontFamily: 'Inter', fontWeight: 600, letterSpacing: 1.6, x: 24, y: 24 })
  })

  it('Inkscape: lines as tspans become one text object with their line height', () => {
    const [t] = nodes(
      svg('<text style="font-size:10px;font-family:sans-serif" x="10" y="60"><tspan x="10" y="60">Line one</tspan>\n   <tspan x="10" y="72.5">Line two</tspan></text>')
    ) as DrawTextNode[]
    expect(t).toMatchObject({ text: 'Line one\nLine two', lines: ['Line one', 'Line two'], lineHeight: 1.25, fontFamily: 'sans-serif', y: 50 })
  })

  it('anchors map to alignment; rotation and uniform scale are carried exactly; skew uses a matrix', () => {
    const [a, b, c] = nodes(
      svg(
        '<text x="100" y="50" text-anchor="middle" font-size="10">Mid</text>' +
          '<text x="0" y="0" font-size="10" transform="translate(50 50) rotate(30) scale(2)">Turned</text>' +
          '<text x="0" y="0" font-size="10" transform="skewX(20)">Skewed</text>'
      )
    ) as DrawTextNode[]
    expect(a.align).toBe('center')
    expect(a.x + a.w / 2).toBeCloseTo(100)
    expect(b.rotation).toBeCloseTo(30)
    expect(b.fontSize).toBeCloseTo(20)
    // The baseline start (local 0,0) lands at (50,50): pivot maths checked by
    // re-applying the node's own rotation about its pivot.
    const r = (b.rotation! * Math.PI) / 180
    const px = b.x + b.w / 2
    const py = b.y
    const sx = b.x
    const sy = b.y + b.fontSize
    const bx = px + (sx - px) * Math.cos(r) - (sy - py) * Math.sin(r)
    const by = py + (sx - px) * Math.sin(r) + (sy - py) * Math.cos(r)
    expect([round(bx), round(by)]).toEqual([50, 50])
    expect(c.transform).toBeDefined()
  })

  it('reports what it simplified: per-glyph positions, mixed styles, text on a path', () => {
    const out = imp(
      svg(
        '<path id="p" d="M0 0L100 0"/><text x="0 5 10" y="10">abc</text><text x="0" y="30">a<tspan font-weight="bold">b</tspan></text><text><textPath href="#p">along</textPath></text>'
      )
    )
    const text = out.report.lines().join(' ')
    expect(text).toMatch(/per-character positioning/)
    expect(text).toMatch(/mixes character styles/)
    expect(text).toMatch(/text on a path was imported as plain text/)
  })
})

// ── Images ───────────────────────────────────────────────────────────────────

/** A minimal PNG header of w x h, optionally declaring a resolution (CRC fields are zero; the reader does not check them). */
function png(w: number, h: number, ppi?: number): Uint8Array {
  const parts: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const u32 = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
  const chunk = (type: string, data: number[]): void => {
    parts.push(...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0)
  }
  chunk('IHDR', [...u32(w), ...u32(h), 8, 6, 0, 0, 0])
  if (ppi) chunk('pHYs', [...u32(Math.round(ppi / 0.0254)), ...u32(Math.round(ppi / 0.0254)), 1])
  chunk('IDAT', [0])
  chunk('IEND', [])
  return new Uint8Array(parts)
}

function jpeg(w: number, h: number, opts: { dpi?: number; orientation?: number } = {}): Uint8Array {
  const b: number[] = [0xff, 0xd8]
  if (opts.dpi) b.push(0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, opts.dpi >> 8, opts.dpi & 255, opts.dpi >> 8, opts.dpi & 255, 0, 0)
  if (opts.orientation) {
    // APP1 "Exif\0\0" + little-endian TIFF with one IFD entry: Orientation.
    const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, opts.orientation, 0, 0, 0, 0, 0, 0, 0]
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
    b.push(0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body)
  }
  b.push(0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0)
  b.push(0xff, 0xd9)
  return new Uint8Array(b)
}

describe('what a placed file is, read from its bytes', () => {
  it('sniffs every supported kind and refuses the rest', () => {
    expect(sniffImportKind(png(2, 3))).toBe('png')
    expect(sniffImportKind(jpeg(2, 3))).toBe('jpeg')
    expect(sniffImportKind(new TextEncoder().encode('GIF89a\x05\x00\x07\x00'))).toBe('gif')
    const webp = new Uint8Array(30)
    webp.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0)
    webp.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8)
    webp.set([99, 0, 0, 49, 0, 0], 24)
    expect(sniffImportKind(webp)).toBe('webp')
    expect(rasterInfo(webp, 'webp')).toEqual({ w: 100, h: 50 })
    expect(sniffImportKind(new TextEncoder().encode('%PDF-1.7\n'))).toBe('pdf')
    expect(sniffImportKind(new TextEncoder().encode('﻿<?xml version="1.0"?>\n<!-- x -->\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('svg')
    expect(sniffImportKind(new Uint8Array([0x1f, 0x8b, 8, 0]), 'logo.svgz')).toBe('svgz')
    expect(sniffImportKind(new Uint8Array([0x1f, 0x8b, 8, 0]), 'logo.gz')).toBeNull()
    // A name says nothing: an "image.png" that is HTML is refused.
    expect(sniffImportKind(new TextEncoder().encode('<html><script>x</script></html>'), 'image.png')).toBeNull()
    expect(sniffImportKind(new TextEncoder().encode('II*\0'))).toBeNull() // TIFF: no browser shows it
  })

  it('reads pixel size, declared resolution and EXIF orientation', () => {
    expect(rasterInfo(png(640, 480, 144), 'png')).toEqual({ w: 640, h: 480, ppi: expect.closeTo(144, 1) })
    expect(rasterInfo(jpeg(400, 300, { dpi: 300 }), 'jpeg')).toEqual({ w: 400, h: 300, ppi: 300 })
    // Orientation 6: stored sideways, shown upright -- the placed frame is 300 x 400.
    expect(rasterInfo(jpeg(400, 300, { orientation: 6 }), 'jpeg')).toEqual({ w: 300, h: 400, orientation: 6 })
    expect(rasterInfo(new TextEncoder().encode('GIF89a\x05\x00\x07\x00'), 'gif')).toEqual({ w: 5, h: 7 })
  })

  it('actual size: physical size from a declared resolution, one unit per pixel when undeclared', () => {
    expect(actualSize({ w: 640, h: 480 })).toEqual({ w: 640, h: 480 })
    expect(actualSize({ w: 640, h: 480, ppi: 72 })).toEqual({ w: 640, h: 480 })
    expect(actualSize({ w: 640, h: 480, ppi: 144 })).toEqual({ w: 320, h: 240 })
    // An "A4 at 150 dpi" drawing: a 300 ppi photo 2480 px wide fills its 1240 px width.
    expect(actualSize({ w: 2480, h: 3508, ppi: 300 }, 150)).toEqual({ w: 1240, h: 1754 })
    expect(actualSize({ w: 100, h: 100 }, 150)).toEqual({ w: 100, h: 100 })
  })

  it('base64 round-trips bytes exactly', () => {
    const bytes = new Uint8Array(Array.from({ length: 1000 }, (_, i) => (i * 37) & 255))
    for (const n of [0, 1, 2, 3, 998, 999, 1000]) {
      const s = bytes.slice(0, n)
      expect(bytesToBase64(s)).toBe(Buffer.from(s).toString('base64'))
      expect(Array.from(base64ToBytes(bytesToBase64(s))!)).toEqual(Array.from(s))
    }
  })
})

describe('<image> in an SVG', () => {
  const dataUrl = `data:image/png;base64,${bytesToBase64(png(200, 100))}`

  it('embedded bytes become an image object in the asset store, placed by preserveAspectRatio', () => {
    const out = imp(svg(`<image x="10" y="10" width="100" height="100" xlink:href="${dataUrl}"/>`))
    const [im] = importedNodes(out) as DrawImageNode[]
    expect(im).toMatchObject({ type: 'image', x: 10, y: 35, w: 100, h: 50 })
    expect(out.assets[im.assetId].dataUrl).toBe(dataUrl)
    // SVG 2: no size given -> the picture's own.
    const [own] = nodes(svg(`<image href="${dataUrl}"/>`)) as DrawImageNode[]
    expect(own).toMatchObject({ w: 200, h: 100 })
    // none stretches; slice crops (a clipping group).
    expect(nodes(svg(`<image width="100" height="100" preserveAspectRatio="none" href="${dataUrl}"/>`))[0]).toMatchObject({ w: 100, h: 100 })
    const [crop] = nodes(svg(`<image width="100" height="100" preserveAspectRatio="xMidYMid slice" href="${dataUrl}"/>`)) as DrawGroupNode[]
    expect(crop).toMatchObject({ type: 'group', clip: true })
  })

  it('a rotated, scaled image keeps exact frame fields; a skewed one carries a matrix', () => {
    const [r] = nodes(svg(`<image width="20" height="10" preserveAspectRatio="none" href="${dataUrl}" transform="translate(100 100) rotate(90) scale(2 3)"/>`)) as DrawImageNode[]
    expect(r).toMatchObject({ w: 40, h: 30, rotation: 90 })
    // The frame's centre is where the matrix puts the image's centre (10,5).
    expect([round(r.x + r.w / 2), round(r.y + r.h / 2)]).toEqual([85, 120])
    const [s] = nodes(svg(`<image width="20" height="10" href="${dataUrl}" preserveAspectRatio="none" transform="skewX(30)"/>`)) as DrawImageNode[]
    expect(s.transform).toBeDefined()
  })
})

// ── Fallbacks: what cannot be edited is kept as an image of itself ───────────

describe('unsupported features are kept as images, and listed', () => {
  const src = svg(
    '<filter id="f"><feGaussianBlur stdDeviation="2"/></filter><mask id="m"><rect width="50" height="50" fill="#fff"/></mask>' +
      '<pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="2" height="2"/></pattern>' +
      '<rect id="blurred" x="10" y="10" width="40" height="40" filter="url(#f)" onclick="alert(1)"/><circle cx="100" cy="100" r="20" mask="url(#m)"/>' +
      '<rect x="120" y="10" width="30" height="30" fill="url(#p)"/><foreignObject x="0" y="150" width="50" height="20"><div xmlns="http://www.w3.org/1999/xhtml">hi<script>alert(1)</script></div></foreignObject>' +
      '<rect x="0" y="0" width="5" height="5" fill="#00ff00"/>'
  )

  it('reports each, with counts', () => {
    const out = imp(src)
    expect(out.fallbacks.map((f) => f.reasons[0])).toEqual(['filter', 'mask', 'pattern', 'embedded HTML (foreignObject)'])
    expect(out.report.lines()[0]).toBe('1 filter, 1 mask, 1 pattern and 1 embedded HTML (foreignObject) were not editable here and were rasterised as an embedded image.')
    // The rest is still editable art.
    expect(paths(importedNodes(out))).toHaveLength(1)
  })

  it('the filter region (10% beyond the box by default) is inside the image', () => {
    const f = imp(src).fallbacks[0]
    expect(f.box).toEqual({ x: 6, y: 6, w: 48, h: 48 })
  })

  it('the standalone markup is sanitised: no scripts, no event handlers, defs carried along', () => {
    const out = imp(src)
    for (const f of out.fallbacks) {
      expect(f.markup).not.toMatch(/<script|onclick|alert\(/i)
      expect(f.markup.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
      // It is well-formed XML.
      expect(() => parseXml(f.markup)).not.toThrow()
    }
    expect(out.fallbacks[0].markup).toContain('<filter id="f">')
    expect(out.fallbacks[1].markup).toContain('<mask id="m">')
  })

  it('resolveFallbacks embeds the rasterised pixels, and removes (and reports) any that fail', async () => {
    const out = imp(src)
    const ok = `data:image/png;base64,${bytesToBase64(png(4, 4))}`
    let call = 0
    await resolveFallbacks(out, async (_markup, w, h) => {
      expect(w).toBeGreaterThan(0)
      expect(h).toBeGreaterThan(0)
      return ++call === 2 ? null : ok
    })
    const imgs = flat(importedNodes(out)).filter((n): n is DrawImageNode => n.type === 'image')
    expect(imgs).toHaveLength(3)
    for (const i of imgs) expect(out.assets[i.assetId].dataUrl).toBe(ok)
    expect(out.report.lines().join(' ')).toMatch(/could not be rasterised and was left out/)
  })
})

// ── Hostile input ────────────────────────────────────────────────────────────

describe('hostile SVGs import inert', () => {
  it('scripts and event handlers are never read', () => {
    const out = imp(svg('<script>alert(1)</script><rect width="10" height="10" onload="alert(1)" onclick="x()"/>'))
    const json = JSON.stringify(out)
    expect(json).not.toMatch(/alert|onload|onclick/)
    expect(out.report.lines().join(' ')).toMatch(/1 script was removed/)
  })

  it('javascript: and external links are not followed', () => {
    const out = imp(
      svg(
        '<a href="javascript:alert(1)"><rect width="1" height="1"/></a><use href="javascript:alert(1)"/><use href="http://evil.example/sprite.svg#icon"/>' +
          '<image href="https://tracker.example/pixel.png" width="10" height="10"/><image href="file:///etc/passwd" width="1" height="1"/>' +
          '<rect width="5" height="5" fill="url(http://evil.example/p.svg#g)"/><linearGradient id="g" href="http://evil.example/x.svg#y"/><rect width="5" height="5" fill="url(#g)"/>'
      )
    )
    const json = JSON.stringify(out)
    expect(json).not.toMatch(/javascript|evil\.example|tracker|passwd/)
    const text = out.report.lines().join(' ')
    expect(text).toMatch(/2 linked images were not imported/)
    expect(text).toMatch(/references to external files \(use\) were not followed/)
  })

  it('external entities (XXE) and parameter entities are refused before parsing', () => {
    const xxe = '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&xxe;</text></svg>'
    expect(() => imp(xxe)).toThrow(SvgRefused)
    expect(() => imp('<!DOCTYPE svg [<!ENTITY % p SYSTEM "http://evil.example/x.dtd"> %p;]><svg xmlns="http://www.w3.org/2000/svg"/>')).toThrow(/parameter entity/)
    expect(() => imp('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x" [<!ENTITY e PUBLIC "x" "http://evil.example/e">]><svg xmlns="http://www.w3.org/2000/svg"/>')).toThrow(/external entity/)
  })

  it('"billion laughs" cannot nest, entities cannot carry markup, and expansion is capped', () => {
    const lol = '<!DOCTYPE svg [<!ENTITY a "lol"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg"><text>&b;</text></svg>'
    expect(() => imp(lol)).toThrow(/refers to another entity/)
    expect(() => imp('<!DOCTYPE svg [<!ENTITY s "<script>x</script>">]><svg xmlns="http://www.w3.org/2000/svg">&s;</svg>')).toThrow(/markup/)
    const big = `<!DOCTYPE svg [<!ENTITY a "${'x'.repeat(4000)}">]><svg xmlns="http://www.w3.org/2000/svg"><text>${'&a;'.repeat(2000)}</text></svg>`
    expect(() => sanitizeSvgText(big, 1_000_000)).toThrow(/too large/)
  })

  it('simple entities (as old Illustrator files use) are expanded safely, and quotes stay literal', () => {
    const r = sanitizeSvgText('<!DOCTYPE svg [<!ENTITY ns "http://www.w3.org/2000/svg"><!ENTITY q \'say "hi"\'>]><svg xmlns="&ns;" id="&q;"/>')
    expect(r.text).toBe('<svg xmlns="http://www.w3.org/2000/svg" id="say &quot;hi&quot;"/>')
  })

  it('processing instructions (an external stylesheet) are removed', () => {
    const r = sanitizeSvgText('<?xml version="1.0"?><?xml-stylesheet href="http://evil.example/s.css"?><svg xmlns="http://www.w3.org/2000/svg"/>')
    expect(r.text).not.toMatch(/stylesheet/)
    expect(r.text.startsWith('<?xml version="1.0"?>')).toBe(true)
  })

  it('huge numbers make an element inert instead of breaking geometry', () => {
    const out = imp(svg('<rect width="1e300" height="10"/><path d="M0 0 L1e12 0 L5 5Z"/><circle r="1e9"/><rect width="10" height="10"/>'))
    const p = paths(importedNodes(out))
    // Only the good rect: the path's subpath with the bad coordinate is dropped
    // whole, and nothing usable precedes it.
    expect(p).toHaveLength(1)
    expect(out.report.lines().join(' ')).toMatch(/error in its data/)
    expect(JSON.stringify(out)).not.toMatch(/e\+|Infinity|NaN/)
  })

  it('a "use" bomb and deep nesting stop at their limits', () => {
    let defs = '<rect id="l0" width="1" height="1"/>'
    for (let i = 1; i <= 12; i++) defs += `<g id="l${i}"><use href="#l${i - 1}"/><use href="#l${i - 1}"/><use href="#l${i - 1}"/><use href="#l${i - 1}"/></g>`
    const bomb = imp(svg(`<defs>${defs}</defs><use href="#l12"/>`))
    expect(bomb.report.lines().join(' ')).toMatch(/more than/)
    expect(flat(importedNodes(bomb)).length).toBeLessThanOrEqual(50_001)
    const deep = imp(svg(`${'<g>'.repeat(300)}<rect width="1" height="1"/>${'</g>'.repeat(300)}`))
    expect(deep.report.lines().join(' ')).toMatch(/nested deeper than/)
  })

  it('a self-referencing use is skipped', () => {
    const out = imp(svg('<g id="a"><use href="#a"/><rect width="1" height="1"/></g>'))
    expect(out.report.lines().join(' ')).toMatch(/refer to themselves|refers to itself/)
  })

  it('oversized input and non-SVG are refused with a clear message', () => {
    expect(() => sanitizeSvgText('x'.repeat(2000), 1000)).toThrow(/larger than/)
    expect(() => imp('<html xmlns="http://www.w3.org/1999/xhtml"/>')).toThrow(/not SVG/)
    let err: unknown
    try {
      imp('<svg><')
    } catch (e) {
      err = e
    }
    expect(String(err)).toMatch(/not a readable SVG/)
    expect(isUserFacingImportError(err)).toBe(true)
  })

  it('CSS cannot reach outside: url() to a host, @import, expressions', () => {
    const out = imp(svg('<style>@import url(http://evil.example/a.css); rect { fill: url(http://evil.example/x#y) }</style><rect width="5" height="5"/>'))
    expect(JSON.stringify(out)).not.toMatch(/evil/)
  })

  it('decodes UTF-16 and declared encodings', () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...[...'<svg/>'].flatMap((c) => [c.charCodeAt(0), 0])])
    expect(decodeSvgBytes(utf16)).toBe('<svg/>')
    const latin = new Uint8Array([...new TextEncoder().encode('<?xml version="1.0" encoding="ISO-8859-1"?><svg><text>'), 0xe9, ...new TextEncoder().encode('</text></svg>')])
    expect(decodeSvgBytes(latin)).toContain('<text>é</text>')
  })
})

// ── The older format (v2 writes still gated) ─────────────────────────────────

describe('lowering to the older drawing format', () => {
  const src = svg(
    '<g opacity="0.5"><rect width="10" height="10" fill="#ff0000"/><rect x="5" width="10" height="10" fill="#00ff00"/></g>' +
      '<clipPath id="c"><rect x="0" y="0" width="50" height="50"/></clipPath><g clip-path="url(#c)"><circle cx="50" cy="50" r="30" fill="#0000ff"/><rect x="10" y="10" width="20" height="20"/></g>' +
      '<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="100" y1="100" x2="150" y2="160"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient><rect x="100" y="100" width="80" height="60" fill="url(#g)"/>'
  )

  it('produces only what v1 can hold, and the document stays v1', () => {
    const out = imp(src, { mode: 'open', structure: 'v1' })
    const list = importedNodes(out)
    expect(list.every((n) => n.type !== 'group')).toBe(true)
    const doc = svgToDrawDoc(out, newId)
    expect(isV1Representable(doc)).toBe(true)
    expect((drawDocForStorage(doc) as { schemaVersion: number }).schemaVersion).toBe(1)
    const text = out.report.lines().join(' ')
    expect(text).toMatch(/3 groups were released/)
    expect(text).toMatch(/group had its opacity applied/)
    expect(text).toMatch(/cut to its clipping mask/)
  })

  it('group opacity multiplies into members; clips cut geometry (contained shapes untouched)', () => {
    const list = paths(importedNodes(imp(src, { structure: 'v1' })))
    expect(list[0].opacity).toBe(0.5)
    expect(list[1].opacity).toBe(0.5)
    expect(box(list[2].path)).toMatchObject({ x: 20, y: 20 })
    expect(box(list[2].path).w).toBeCloseTo(30, 0)
    expect(box(list[3].path)).toEqual({ x: 10, y: 10, w: 20, h: 20 })
  })

  it('a linear gradient converts to the angle form exactly where v1 can draw it, and says when it cannot', () => {
    const v2 = paths(importedNodes(imp(src))).find((p) => p.fill.type === 'linear')!.fill
    const out = imp(src, { structure: 'v1' })
    const v1 = paths(importedNodes(out)).find((p) => p.fill.type === 'linear')!.fill
    expect((v1 as { from?: unknown }).from).toBeUndefined()
    const a = (((v1 as { angle: number }).angle ?? 0) * Math.PI) / 180
    const t1 = (q: [number, number]): number => (q[0] - 0.5) * Math.cos(a) + (q[1] - 0.5) * Math.sin(a) + 0.5
    const t2 = (q: [number, number]): number => modelLinearAt(v2 as never, { x: 0, y: 0, w: 1, h: 1 }, q)
    // Inside v1's one-unit line the colours agree exactly...
    for (const q of [
      [0.5, 0.5],
      [0.3, 0.7],
      [0.9, 0.1],
      [0.8, 0.8]
    ] as Array<[number, number]>) {
      expect(t1(q) >= 0 && t1(q) <= 1).toBe(true)
      const c1 = stopAt((v1 as { stops: never[] }).stops, t1(q)).color
      const c2 = stopAt((v2 as { stops: never[] }).stops, t2(q)).color
      // Equal up to the last bit of 8-bit rounding.
      expect(Math.abs(parseInt(c1.slice(1, 3), 16) - parseInt(c2.slice(1, 3), 16))).toBeLessThanOrEqual(1)
    }
    // ...but this diagonal gradient starts in the corner, beyond v1's line: reported.
    expect(out.report.lines().join(' ')).toMatch(/1 gradient was approximated/)
    // A gradient v1 itself could have made converts with no report.
    let n = 0
    const back = gradientToV1({ type: 'linear', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], from: { x: 0.5, y: 0 }, to: { x: 0.5, y: 1 } }, () => n++)
    expect(n).toBe(0)
    expect(back).toMatchObject({ type: 'linear', angle: 90 })
  })

  it('a centred radial gradient converts exactly; an off-centre one is approximated and reported', () => {
    let n = 0
    const exact = gradientToV1({ type: 'radial', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], center: { x: 0.5, y: 0.5 }, radius: 0.25 }, () => n++)
    expect(n).toBe(0)
    // Radius 0.25 is half of v1's: the colours reach white halfway out.
    expect(exact).toEqual({ type: 'radial', stops: [{ offset: 0, color: '#000000' }, { offset: 0.5, color: '#ffffff' }, { offset: 1, color: '#ffffff' }] })
    gradientToV1({ type: 'radial', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], center: { x: 0.2, y: 0.5 } }, () => n++)
    expect(n).toBe(1)
  })
})

// ── Fixtures written in the shape of Illustrator, Figma and Inkscape exports ─

describe('fixtures from design tools', () => {
  it('Illustrator (legacy, with entities, switch/foreignObject, CDATA styles)', () => {
    const out = imp(fixture('illustrator-legacy.svg'), { mode: 'open' })
    expect([out.width, out.height]).toEqual([200, 150])
    const list = importedNodes(out)
    // The extraneous wrapper and the switch are not groups of the user's.
    expect(list.map((n) => n.type)).toEqual(['path', 'path', 'path', 'path', 'text'])
    const [rect, tri, circ, blob, text] = list as [DrawPathNode, DrawPathNode, DrawPathNode, DrawPathNode, DrawTextNode]
    expect(rect.fill).toEqual({ type: 'solid', color: '#ff0000' })
    expect(tri.stroke).toEqual({ paint: { type: 'solid', color: '#000000' }, width: 2, miterLimit: 10 })
    expect(circ.fill).toMatchObject({ type: 'linear', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } })
    expect(box(blob.path)).toEqual({ x: 20, y: 60, w: 40, h: 40 })
    expect(text).toMatchObject({ text: 'Hello Illustrator', fontSize: 12, fontWeight: 700, fontFamily: "'Myriad Pro'", x: 20, y: 118 })
    expect(out.report.lines().join(' ')).not.toMatch(/foreignObject|rasterised/)
  })

  it('Illustrator (current SVG export: classes, clip group, radial gradient, rotated group)', () => {
    const out = imp(fixture('illustrator-modern.svg'), { mode: 'open' })
    const list = importedNodes(out)
    expect(list.map((n) => n.type)).toEqual(['group', 'path', 'path', 'group'])
    const clip = list[0] as DrawGroupNode
    expect(clip.clip).toBe(true)
    expect(box((clip.children.at(-1) as DrawPathNode).path)).toEqual({ x: 10, y: 10, w: 100, h: 80 })
    const arc = list[1] as DrawPathNode
    expect(arc.stroke).toMatchObject({ width: 4, cap: 'round', miterLimit: 10 })
    expect(box(arc.path)).toEqual({ x: 110, y: 20, w: 80, h: 80 })
    expect((list[2] as DrawPathNode).fill).toMatchObject({ type: 'radial', center: { x: 0.5, y: 0.5 }, radius: 0.5, stops: [{ color: '#ffffff' }, { color: '#e64980' }] })
    const grp = list[3] as DrawGroupNode
    expect(grp.name).toBe('Group 2')
    expect((grp.children[0] as DrawPathNode).opacity).toBe(0.5)
  })

  it('Figma (clip wrapper, userSpace gradient, drop-shadow filter, dashes, evenodd, text)', () => {
    const out = imp(fixture('figma.svg'), { mode: 'open' })
    const [wrap] = importedNodes(out) as DrawGroupNode[]
    expect(wrap.clip).toBe(true)
    const inner = flat(wrap.children)
    const ps = inner.filter((n): n is DrawPathNode => n.type === 'path' && n.name !== 'Clipping path')
    expect(ps[0].fill).toEqual({ type: 'solid', color: '#ffffff' })
    expect(ps[1]).toMatchObject({ shapeKind: 'roundRect', cornerRadius: 8, fill: { type: 'linear' } })
    // The gradient runs corner to corner of the 120 x 80 box IN USER SPACE (its
    // stripes are perpendicular there), so in box units it is NOT (0,0)->(1,1):
    // the colour is 0 at the top-left corner and 1 at the bottom-right.
    const b = pathBounds(ps[1].path, 0.01)
    expect(modelLinearAt(ps[1].fill as never, b, [24, 24])).toBeCloseTo(0, 6)
    expect(modelLinearAt(ps[1].fill as never, b, [144, 104])).toBeCloseTo(1, 3)
    // ...and constant along the user-space perpendicular through the middle.
    expect(modelLinearAt(ps[1].fill as never, b, [84 + 40, 64 - 60])).toBeCloseTo(0.5, 3)
    expect(ps[2].stroke).toMatchObject({ width: 2, dash: [6, 4] })
    expect(ps[3].path.fillRule).toBe('evenodd')
    const t = inner.find((n): n is DrawTextNode => n.type === 'text')!
    expect(t).toMatchObject({ text: 'Figma export', fontFamily: 'Inter', fontWeight: 600, fontSize: 16 })
    expect(out.fallbacks).toHaveLength(1)
    expect(out.fallbacks[0]).toMatchObject({ reasons: ['filter'], box: { x: 176, y: 24, w: 88, h: 96 } })
  })

  it('Inkscape (mm units, layers, style attributes, use, text lines, markers, a mask, a hidden layer)', () => {
    const out = imp(fixture('inkscape.svg'), { mode: 'open' })
    expect(round(out.width, 100)).toBe(377.95)
    expect(out.layers.map((l) => [l.name, l.visible])).toEqual([
      ['Layer 1', true],
      ['Hidden layer', false]
    ])
    const k = 96 / 25.4
    const list = out.layers[0].nodes
    const rounded = list[0] as DrawPathNode
    expect(rounded).toMatchObject({ name: 'Rounded', fill: { type: 'solid', color: '#ff6600', opacity: 0.8 }, stroke: { join: 'round' } })
    expect(rounded.stroke!.width).toBeCloseTo(0.5 * k, 3)
    expect(box(rounded.path)).toEqual({ x: round(10 * k), y: round(10 * k), w: round(35 * k), h: round(30 * k) })
    const [, r2, used] = list as DrawPathNode[]
    expect(box(used.path).x - box(r2.path).x).toBeCloseTo(15 * k, 3)
    const text = list.find((n): n is DrawTextNode => n.type === 'text')!
    expect(text).toMatchObject({ lines: ['Line one', 'Line two'], lineHeight: 1.25, fontFamily: 'sans-serif' })
    expect(text.fontSize).toBeCloseTo(6.35 * k, 3)
    const arrow = list.find((n): n is DrawGroupNode => n.type === 'group' && n.name === 'arrow with markers')!
    expect(arrow.children).toHaveLength(2)
    // context-stroke on the marker takes the line's black.
    expect(paths([arrow.children[1]])[0].fill).toEqual({ type: 'solid', color: '#000000' })
    expect(out.fallbacks.map((f) => f.reasons)).toEqual([['mask']])
  })
})

// ── Round trip: our own export, imported, exported again ─────────────────────

/**
 * What an SVG DRAWS, as comparable records: every painted primitive with its
 * geometry in document space (paths flattened, text anchors, image corners)
 * and its paint resolved to the COLOURS it produces (a gradient is sampled on a
 * grid over its box, so two gradients that are written differently but paint
 * the same compare equal), plus stroke and compositing. Numbers are compared
 * with a tolerance by `sameDrawing`.
 */
function drawn(svgText: string, masked = false): string[] {
  const doc = parseXml(svgText)
  const ids = new Map<string, Element>()
  const all = (el: Element): void => {
    const id = el.getAttribute('id')
    if (id) ids.set(id, el)
    for (const c of Array.from(el.childNodes)) if (c.nodeType === 1) all(c as Element)
  }
  all(doc.documentElement as unknown as Element)
  const f4 = (v: number): string => String(Math.round(v * 1e4) / 1e4)
  const rgba = (hex: string, a: number): string => `c${parseInt(hex.slice(1, 3), 16)} c${parseInt(hex.slice(3, 5), 16)} c${parseInt(hex.slice(5, 7), 16)} a${f4(a)}`
  const colour = (v: string | null): string => {
    if (!v || v === 'none') return 'none'
    const c = parseColor(v)
    return c ? rgba(c.hex, c.alpha) : `?${v}`
  }
  /** Colours a paint produces over its object's box, on a 4 x 4 grid of box-unit points. */
  const paint = (v: string | null, opacityAttr: string | null): string => {
    const k = Number(opacityAttr ?? 1)
    const m = /^url\(#(.+)\)$/.exec(v ?? '')
    if (!m) {
      const c = parseColor(v ?? '')
      return c ? rgba(c.hex, c.alpha * k) : colour(v)
    }
    const g = ids.get(m[1])
    if (!g) return 'missing'
    const stops = Array.from(g.getElementsByTagName('stop')).map((s) => ({
      offset: parseFloat(s.getAttribute('offset')!) / 100,
      color: parseColor(s.getAttribute('stop-color'))!.hex,
      opacity: Number(s.getAttribute('stop-opacity') ?? 1)
    }))
    const num = (a: string, d: number): number => Number(g.getAttribute(a) ?? d)
    const samples: string[] = []
    for (const qy of [0.125, 0.375, 0.625, 0.875])
      for (const qx of [0.125, 0.375, 0.625, 0.875]) {
        let t: number
        if (g.localName === 'linearGradient') {
          const [x1, y1, x2, y2] = [num('x1', 0), num('y1', 0.5), num('x2', 1), num('y2', 0.5)]
          t = ((qx - x1) * (x2 - x1) + (qy - y1) * (y2 - y1)) / ((x2 - x1) ** 2 + (y2 - y1) ** 2)
        } else {
          const [cx, cy, r] = [num('cx', 0.5), num('cy', 0.5), num('r', 0.5)]
          t = Math.hypot(qx - cx, qy - cy) / r
        }
        const c = stopAt(stops, t)
        samples.push(rgba(c.color, c.opacity * k))
      }
    return `gradient[${samples.join(' ')}]`
  }
  const out: string[] = []
  const walk = (el: Element, ctm: number[], comp: string): void => {
    const t = parseTransform(el.getAttribute('transform'))!
    const m = [ctm[0] * t[0] + ctm[2] * t[1], ctm[1] * t[0] + ctm[3] * t[1], ctm[0] * t[2] + ctm[2] * t[3], ctm[1] * t[2] + ctm[3] * t[3], ctm[0] * t[4] + ctm[2] * t[5] + ctm[4], ctm[1] * t[4] + ctm[3] * t[5] + ctm[5]] as [number, number, number, number, number, number]
    const style = el.getAttribute('style') ? `{${el.getAttribute('style')}}` : ''
    const c = comp + style
    const ap = (x: number, y: number): string => `${f4(m[0] * x + m[2] * y + m[4])} ${f4(m[1] * x + m[3] * y + m[5])}`
    const strokeOf = (): string =>
      `stroke(${paint(el.getAttribute('stroke'), el.getAttribute('stroke-opacity'))} w${el.getAttribute('stroke-width') ?? ''} ${['stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-miterlimit'].map((k) => el.getAttribute(k) ?? '').join('|')})`
    const fill = `fill(${paint(el.getAttribute('fill'), el.getAttribute('fill-opacity'))})`
    const shape = (p: DrawPath, rule: string | null): void => {
      const rings = flattenPath(transformPath(p, m), 0.05).map((r) => r.map((q) => `${f4(q.x)} ${f4(q.y)}`).join(' '))
      out.push(`shape ${rings.join(' | ')} ${p.subpaths.map((s) => (s.closed ? 'Z' : 'O')).join('')} ${rule ?? ''} ${fill} ${strokeOf()} ${c}`)
    }
    switch (el.localName) {
      case 'svg':
      case 'g':
        for (const k of Array.from(el.childNodes)) if (k.nodeType === 1) walk(k as Element, m, c)
        return
      case 'defs':
        return
      case 'rect': {
        const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => +el.getAttribute(k)!)
        shape({ subpaths: [{ closed: true, nodes: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] }] }, null)
        return
      }
      case 'path':
        shape(parsePathData(el.getAttribute('d')!).path, el.getAttribute('fill-rule'))
        return
      case 'image': {
        const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => +el.getAttribute(k)!)
        out.push(`image ${ap(x, y)} ${ap(x + w, y + h)} ${el.getAttribute('href')!} ${c}`)
        return
      }
      case 'text': {
        const fam = (el.getAttribute('font-family') ?? '').replace(/['"]/g, '')
        const font = `${/^[-\w ,.]+$/.test(fam) && !masked ? fam : '(family)'}|${el.getAttribute('font-size')}|${el.getAttribute('font-weight') ?? ''}|${el.getAttribute('font-style') ?? ''}|${el.getAttribute('letter-spacing') ?? ''}|${el.getAttribute('text-anchor')}`
        for (const s of Array.from(el.getElementsByTagName('tspan'))) out.push(`text ${ap(+s.getAttribute('x')!, +s.getAttribute('y')!)} "${s.textContent}" ${font} ${fill} ${strokeOf()} ${c}`)
        return
      }
      default:
        out.push(`other ${el.localName}`)
    }
  }
  walk(doc.documentElement as unknown as Element, [1, 0, 0, 1, 0, 0], '')
  return out
}

/**
 * Same picture: the same records, word for word, except numbers -- which may
 * differ by float noise (0.06 user units, or 2/255 for colour channels).
 */
function sameDrawing(a: string[], b: string[]): string | null {
  if (a.length !== b.length) return `${a.length} vs ${b.length} records:\n${a.join('\n')}\n---\n${b.join('\n')}`
  const tok = (s: string): string[] => s.split(/(-?\d+(?:\.\d+)?(?:e-?\d+)?)/)
  for (let i = 0; i < a.length; i++) {
    const ta = tok(a[i])
    const tb = tok(b[i])
    const bad = (): string => `record ${i} differs:\n  ${a[i]}\n  ${b[i]}`
    if (ta.length !== tb.length) return bad()
    for (let j = 0; j < ta.length; j++) {
      if (j % 2 === 0) {
        if (ta[j] !== tb[j]) return bad()
        continue
      }
      const tol = ta[j - 1].endsWith('c') ? 2 : 0.06
      if (Math.abs(Number(ta[j]) - Number(tb[j])) > tol) return bad()
    }
  }
  return null
}

const CORPUS_DIR = join(__dirname, '../fixtures/draw/v1')
const corpus = readdirSync(CORPUS_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({ name: f.replace(/\.json$/, ''), raw: JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8')) as unknown }))

describe.each(corpus)('round trip: export -> import -> export draws the same ($name)', ({ name, raw }) => {
  const v1 = normalizeDrawBody(raw)
  const first = drawToSvg(v1)

  for (const structure of ['v2', 'v1'] as const) {
    it(`as a ${structure} drawing`, () => {
      const out = imp(first, { mode: 'open', structure })
      const doc: DrawDoc = svgToDrawDoc(out, newId)
      const second = drawDocToSvg(doc)
      // The hostile document's "font family" is markup: unreadable, so the
      // default font is used (and reported, below); fonts are not compared there.
      const mask = name === '14-hostile-strings'
      expect(sameDrawing(drawn(second, mask), drawn(first, mask))).toBeNull()
      // And the artboard is the same size.
      expect([doc.artboards[0].w, doc.artboards[0].h]).toEqual([v1.width, v1.height])
      // Nothing was lost along the way, so nothing is reported as lost -- except
      // in the hostile document, whose "font family" is markup and is honestly
      // reported as unreadable.
      if (name === '14-hostile-strings') expect(out.report.lines().join(' ')).toMatch(/font names? could not be read/)
      else expect(out.report.hasLosses()).toBe(false)
    })
  }
})

describe('the round trip is a fixed point after one import', () => {
  it.each(corpus)('$name: export of the import is stable under another round', ({ raw }) => {
    const once = drawDocToSvg(svgToDrawDoc(imp(drawToSvg(normalizeDrawBody(raw)), { mode: 'open' }), newId))
    const twice = drawDocToSvg(svgToDrawDoc(imp(once, { mode: 'open' }), newId))
    const ids = (s: string): string => s.replace(/(grad|clip)-[A-Za-z0-9_-]+/g, 'ID')
    expect(ids(twice)).toBe(ids(once))
  })
})

describe('open: a new drawing from an SVG', () => {
  it('artboard from the file, page colour from a full-page backdrop, layers from top-level groups', () => {
    const out = imp(svg('<rect width="300" height="100" fill="#fafafa"/><g id="Back"><rect width="10" height="10"/></g><g id="Front" opacity="0.5"><circle r="5"/></g>', 'viewBox="0 0 300 100"'), { mode: 'open' })
    const doc = svgToDrawDoc(out, newId)
    expect(doc.artboards[0]).toMatchObject({ w: 300, h: 100, background: { type: 'solid', color: '#fafafa' } })
    expect(doc.layers.map((l) => [l.name, l.opacity])).toEqual([
      ['Back', 1],
      ['Front', 0.5]
    ])
  })

  it('a file with loose top-level art is one layer; an oversize artboard is clamped and reported', () => {
    const out = imp(svg('<rect width="10" height="10"/>', 'viewBox="0 0 20000 10"'), { mode: 'open' })
    const doc = svgToDrawDoc(out, newId)
    expect(doc.layers).toHaveLength(1)
    expect(doc.artboards[0].w).toBe(12000)
    expect(out.report.lines().join(' ')).toMatch(/artboard was resized/)
  })
})
