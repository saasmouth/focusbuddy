import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  SHAPES,
  SHAPE_CATEGORIES,
  searchShapes,
  shapeOutline,
  shapePorts,
  shapesIn,
  type ShapeDef
} from '../../src/shared/diagram/shapes'

// ── strict SVG path validation ──────────────────────────────────────────────
// Only absolute M L H V A C Q Z with plain decimal numbers are allowed.
const NUM = '-?(?:\\d+\\.?\\d*|\\.\\d+)'
const TOKEN = new RegExp(`[MLHVACQZ]|${NUM}`, 'g')
const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, A: 7, C: 6, Q: 4, Z: 0 }

interface PathCheck {
  ok: boolean
  error?: string
  points: [number, number][] // every absolute point we can extract
  closed: boolean
}

function checkPath(d: string): PathCheck {
  const points: [number, number][] = []
  if (typeof d !== 'string' || !d.trim()) return { ok: false, error: 'empty path', points, closed: false }
  if (/NaN|undefined|Infinity|null/.test(d)) return { ok: false, error: `bad literal in ${d}`, points, closed: false }
  // Nothing but tokens and separators.
  const leftover = d.replace(TOKEN, '').replace(/[\s,]/g, '')
  if (leftover) return { ok: false, error: `stray characters "${leftover}" in ${d}`, points, closed: false }
  const toks = d.match(TOKEN) ?? []
  if (!/^[M]$/.test(toks[0] ?? '')) return { ok: false, error: `must start with M: ${d}`, points, closed: false }
  let i = 0
  let cx = 0
  let cy = 0
  let last = ''
  while (i < toks.length) {
    const c = toks[i++]
    if (!(c in ARITY)) return { ok: false, error: `expected command, got ${c} in ${d}`, points, closed: false }
    last = c
    const n = ARITY[c]
    if (n === 0) continue
    const args: number[] = []
    while (i < toks.length && !(toks[i] in ARITY)) args.push(Number(toks[i++]))
    if (args.length === 0 || args.length % n !== 0)
      return { ok: false, error: `${c} has ${args.length} args (needs multiple of ${n}) in ${d}`, points, closed: false }
    if (args.some((a) => !Number.isFinite(a))) return { ok: false, error: `non-finite arg in ${d}`, points, closed: false }
    for (let k = 0; k < args.length; k += n) {
      const a = args.slice(k, k + n)
      switch (c) {
        case 'M':
        case 'L':
          cx = a[0]
          cy = a[1]
          points.push([cx, cy])
          break
        case 'H':
          cx = a[0]
          points.push([cx, cy])
          break
        case 'V':
          cy = a[0]
          points.push([cx, cy])
          break
        case 'A':
          if (a[0] < 0 || a[1] < 0) return { ok: false, error: `negative arc radius in ${d}`, points, closed: false }
          if (![0, 1].includes(a[3]) || ![0, 1].includes(a[4]))
            return { ok: false, error: `arc flags must be 0/1 in ${d}`, points, closed: false }
          cx = a[5]
          cy = a[6]
          points.push([cx, cy])
          break
        case 'C':
          points.push([a[0], a[1]], [a[2], a[3]], [a[4], a[5]])
          cx = a[4]
          cy = a[5]
          break
        case 'Q':
          points.push([a[0], a[1]], [a[2], a[3]])
          cx = a[2]
          cy = a[3]
          break
      }
    }
  }
  return { ok: true, points, closed: last === 'Z' }
}

// The required sizes for every shape, plus — for the library categories — the
// smallest box the editor allows (8px, or the shape's own minimum). The Plexii
// data-bound shapes are maintained separately and only get the required sizes.
const sizesFor = (s: ShapeDef): [number, number][] => {
  const sizes: [number, number][] = [
    [s.w, s.h],
    [40, 30],
    [300, 120]
  ]
  if (s.category !== 'Plexii') sizes.push([Math.max(8, s.minW ?? 0), Math.max(8, s.minH ?? 0)])
  return sizes
}

describe('diagram shapes — path grammar self-check', () => {
  it('accepts well-formed paths and rejects malformed ones', () => {
    expect(checkPath('M0,0 H10 V10 H0 Z').ok).toBe(true)
    expect(checkPath('M0,0 A5,5 0 0 1 10,10 C1,2 3,4 5,6 Q1,1 2,2 Z').ok).toBe(true)
    expect(checkPath('M0,0 L NaN,4').ok).toBe(false)
    expect(checkPath('M0,0 l4,4').ok).toBe(false) // relative commands not allowed
    expect(checkPath('M0,0 L4').ok).toBe(false) // wrong arity
    expect(checkPath('M0,0 Lundefined,4').ok).toBe(false)
    expect(checkPath('0,0 L4,4').ok).toBe(false)
  })
})

describe('diagram shapes — registry', () => {
  it('has at least 250 shapes', () => {
    expect(SHAPES.length).toBeGreaterThanOrEqual(250)
  })

  it('ids are unique and lowercase-kebab', () => {
    const seen = new Set<string>()
    for (const s of SHAPES) {
      expect(s.id, s.id).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(seen.has(s.id), `duplicate ${s.id}`).toBe(false)
      seen.add(s.id)
    }
  })

  it('keeps every legacy id', () => {
    const legacy = [
      'process', 'decision', 'terminator', 'data', 'database', 'circle', 'note', 'hexagon', 'trapezoid',
      'chevron', 'triangle', 'pentagon', 'star', 'cross', 'arrow', 'callout', 'lane', 'widget'
    ]
    for (const id of legacy) expect(SHAPES.some((s) => s.id === id), id).toBe(true)
  })

  it('every category except Plexii has at least 4 shapes', () => {
    for (const c of SHAPE_CATEGORIES) {
      if (c === 'Plexii') continue
      expect(shapesIn(c).length, c).toBeGreaterThanOrEqual(4)
    }
    expect(shapesIn('Plexii').some((s) => s.id === 'widget')).toBe(true)
    for (const s of SHAPES) expect(SHAPE_CATEGORIES, s.id).toContain(s.category)
  })

  it('search finds databases and servers', () => {
    expect(searchShapes('database').length).toBeGreaterThan(0)
    expect(searchShapes('server').length).toBeGreaterThan(0)
    expect(searchShapes('server').some((s) => s.id === 'net-server')).toBe(true)
  })

  it('uses no vendor-namespaced ids', () => {
    for (const s of SHAPES) expect(s.id, s.id).not.toMatch(/^(aws|azure|gcp|google|microsoft|cisco|k8s)-/)
  })
})

describe('diagram shapes — icons', () => {
  const dts = readFileSync(resolve(__dirname, '../../node_modules/material-symbols/index.d.ts'), 'utf8')
  const names = new Set([...dts.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]))

  it('the Material Symbols name list loaded', () => {
    expect(names.size).toBeGreaterThan(1000)
    expect(names.has('dns')).toBe(true)
  })

  it('icon shapes carry a real Material Symbols name', () => {
    const iconShapes = SHAPES.filter((s) => s.special === 'icon')
    expect(iconShapes.length).toBeGreaterThan(0)
    for (const s of iconShapes) {
      expect(s.icon, s.id).toBeTruthy()
      expect(names.has(s.icon!), `${s.id}: unknown icon "${s.icon}"`).toBe(true)
    }
    for (const s of SHAPES) if (s.icon) expect(names.has(s.icon), `${s.id}: unknown icon "${s.icon}"`).toBe(true)
  })
})

describe('diagram shapes — geometry', () => {
  for (const s of SHAPES) {
    it(`${s.id} draws valid geometry at every size`, () => {
      expect(s.w).toBeGreaterThan(0)
      expect(s.h).toBeGreaterThan(0)
      expect(s.label.trim().length).toBeGreaterThan(0)
      for (const [w, h] of sizesFor(s)) {
        const tag = `${s.id} @ ${w}x${h}`
        const g = s.draw(w, h)
        expect(g.parts.length, tag).toBeGreaterThanOrEqual(1)
        for (const p of g.parts) {
          const res = checkPath(p.d)
          expect(res.error, tag).toBeUndefined()
          expect(res.ok, tag).toBe(true)
          for (const [x, y] of res.points) {
            expect(x, `${tag} x in ${p.d}`).toBeGreaterThanOrEqual(-1)
            expect(x, `${tag} x in ${p.d}`).toBeLessThanOrEqual(w + 1)
            expect(y, `${tag} y in ${p.d}`).toBeGreaterThanOrEqual(-1)
            expect(y, `${tag} y in ${p.d}`).toBeLessThanOrEqual(h + 1)
          }
        }
        // Outline: closed and in-bounds.
        const o = shapeOutline(s.id, w, h)
        const oc = checkPath(o)
        expect(oc.error, `${tag} outline`).toBeUndefined()
        expect(oc.closed, `${tag} outline closed: ${o}`).toBe(true)
        expect(o.trim().endsWith('Z'), `${tag} outline ends with Z`).toBe(true)
        for (const [x, y] of oc.points) {
          expect(x >= -1 && x <= w + 1 && y >= -1 && y <= h + 1, `${tag} outline point ${x},${y}`).toBe(true)
        }
        // Text rect inside the box.
        const t = g.text
        for (const v of [t.x, t.y, t.w, t.h]) expect(Number.isFinite(v), tag).toBe(true)
        expect(t.w, tag).toBeGreaterThanOrEqual(0)
        expect(t.h, tag).toBeGreaterThanOrEqual(0)
        expect(t.x, tag).toBeGreaterThanOrEqual(-0.01)
        expect(t.y, tag).toBeGreaterThanOrEqual(-0.01)
        expect(t.x + t.w, tag).toBeLessThanOrEqual(w + 0.01)
        expect(t.y + t.h, tag).toBeLessThanOrEqual(h + 0.01)
      }
      // Ports are fractions inside the box.
      for (const [px, py] of shapePorts(s.id)) {
        expect(px >= 0 && px <= 1 && py >= 0 && py <= 1, `${s.id} port ${px},${py}`).toBe(true)
      }
      if (s.minW) expect(s.minW).toBeLessThanOrEqual(s.w)
      if (s.minH) expect(s.minH).toBeLessThanOrEqual(s.h)
      if (s.special === 'icon') {
        // Icon labels sit below the icon tile.
        const g = s.draw(s.w, s.h)
        expect(g.text.y, s.id).toBeGreaterThanOrEqual(s.h * 0.6)
      }
    })
  }

  it('the default text rect has usable area for labelled shapes', () => {
    for (const s of SHAPES) {
      if (s.special === 'widget' || s.special === 'table') continue
      const g = s.draw(s.w, s.h)
      if (s.defaultLabel) expect(g.text.w * g.text.h, s.id).toBeGreaterThan(0)
    }
  })
})
