import { describe, it, expect } from 'vitest'
import { floodFillPixels, parseHex, toHex } from '../../src/renderer/src/components/documents/draw/raster'

// A tiny RGBA buffer helper: `grid` is one character per pixel, 'w' white, 'k'
// black, '.' transparent. Makes the fill assertions readable.
function buffer(rows: string[]): { d: number[]; w: number; h: number } {
  const h = rows.length
  const w = rows[0].length
  const d: number[] = []
  for (const row of rows) {
    for (const c of row) {
      if (c === 'w') d.push(255, 255, 255, 255)
      else if (c === 'k') d.push(0, 0, 0, 255)
      else d.push(0, 0, 0, 0)
    }
  }
  return { d, w, h }
}
function at(d: number[], w: number, x: number, y: number): [number, number, number, number] {
  const i = (y * w + x) * 4
  return [d[i], d[i + 1], d[i + 2], d[i + 3]]
}

const RED: [number, number, number, number] = [255, 0, 0, 255]

describe('raster — hex colour', () => {
  it('parses long and short form', () => {
    expect(parseHex('#ff8800')).toEqual({ r: 255, g: 136, b: 0 })
    expect(parseHex('f80')).toEqual({ r: 255, g: 136, b: 0 })
  })

  it('rejects anything that is not a hex colour', () => {
    expect(parseHex('rgb(1,2,3)')).toBeNull()
    expect(parseHex('#12345')).toBeNull()
    expect(parseHex('')).toBeNull()
  })

  it('round-trips through toHex', () => {
    expect(toHex(255, 136, 0)).toBe('#ff8800')
    expect(parseHex(toHex(1, 2, 3))).toEqual({ r: 1, g: 2, b: 3 })
  })

  it('clamps out-of-range channels rather than emitting invalid hex', () => {
    expect(toHex(-20, 300, 12.6)).toBe('#00ff0d')
  })
})

describe('raster — flood fill', () => {
  it('fills a bounded region and stops at the wall', () => {
    const { d, w, h } = buffer([
      'wwwww',
      'wkkkw',
      'wkwkw',
      'wkkkw',
      'wwwww'
    ])
    expect(floodFillPixels(d, w, h, 2, 2, RED, 0)).toBe(true)
    expect(at(d, w, 2, 2)).toEqual(RED)
    // The black wall and the white outside are both untouched.
    expect(at(d, w, 1, 1)).toEqual([0, 0, 0, 255])
    expect(at(d, w, 0, 0)).toEqual([255, 255, 255, 255])
  })

  it('fills the whole connected area when there is no wall', () => {
    const { d, w, h } = buffer(['www', 'www', 'www'])
    expect(floodFillPixels(d, w, h, 1, 1, RED, 0)).toBe(true)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) expect(at(d, w, x, y)).toEqual(RED)
  })

  it('reports false, and changes nothing, when the pixel is already that colour', () => {
    const { d, w, h } = buffer(['www'])
    const before = d.slice()
    expect(floodFillPixels(d, w, h, 0, 0, [255, 255, 255, 255], 0)).toBe(false)
    expect(d).toEqual(before)
  })

  it('an out-of-bounds click is refused, not clamped into the wrong pixel', () => {
    const { d, w, h } = buffer(['ww', 'ww'])
    expect(floodFillPixels(d, w, h, 5, 5, RED, 0)).toBe(false)
    expect(floodFillPixels(d, w, h, -1, 0, RED, 0)).toBe(false)
  })

  it('fills transparent regions — an empty layer is fillable', () => {
    const { d, w, h } = buffer(['...', '...'])
    expect(floodFillPixels(d, w, h, 0, 0, RED, 0)).toBe(true)
    expect(at(d, w, 2, 1)).toEqual(RED)
  })

  it('tolerance decides whether a near-match is crossed', () => {
    const near = buffer(['ww'])
    // Nudge the second pixel slightly off white.
    near.d[4] = 250
    near.d[5] = 250
    near.d[6] = 250
    expect(floodFillPixels(near.d, near.w, near.h, 0, 0, RED, 0)).toBe(true)
    expect(at(near.d, near.w, 1, 0)).toEqual([250, 250, 250, 255])

    const near2 = buffer(['ww'])
    near2.d[4] = 250
    near2.d[5] = 250
    near2.d[6] = 250
    expect(floodFillPixels(near2.d, near2.w, near2.h, 0, 0, RED, 0.05)).toBe(true)
    expect(at(near2.d, near2.w, 1, 0)).toEqual(RED)
  })

  it('a diagonal gap is NOT crossed — the fill is 4-connected like every paint tool', () => {
    const { d, w, h } = buffer([
      'wk',
      'kw'
    ])
    floodFillPixels(d, w, h, 0, 0, RED, 0)
    expect(at(d, w, 0, 0)).toEqual(RED)
    expect(at(d, w, 1, 1)).toEqual([255, 255, 255, 255])
  })

  it('handles a tall single-column region without stack overflow', () => {
    const rows = Array.from({ length: 400 }, () => 'w')
    const { d, w, h } = buffer(rows)
    expect(floodFillPixels(d, w, h, 0, 0, RED, 0)).toBe(true)
    expect(at(d, w, 0, 399)).toEqual(RED)
  })
})
