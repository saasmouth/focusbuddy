// The helpers handed to every generated widget.
//
// They earn their place by being small and easy to get subtly wrong — a CSV
// parser that breaks on a quoted comma, a Mercator projection that asks for tile
// row -1 at the poles, a haversine with the wrong radius. If they are not
// correct here they are worse than nothing, because every widget will trust them.
//
// The source is a string spliced into a sandboxed document, so it is evaluated
// here to test the behaviour rather than asserted against as text.
import { describe, it, expect, beforeAll } from 'vitest'
import { helperScript } from '../../src/shared/customWidgetHelpers'

interface Helpers {
  geo: {
    distance: (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => number
    project: (p: { lat: number; lon: number }, z: number) => { x: number; y: number }
    unproject: (x: number, y: number, z: number) => { lat: number; lon: number }
    tileUrl: (x: number, y: number, z: number) => string
    tilesFor: (
      c: { lat: number; lon: number },
      z: number,
      w: number,
      h: number
    ) => Array<{ x: number; y: number; z: number; left: number; top: number; url: string }>
  }
  csv: {
    parse: (t: string, d?: string) => string[][]
    parseObjects: (t: string, d?: string) => Array<Record<string, string>>
    format: (rows: unknown[][], d?: string) => string
  }
  fmt: {
    number: (n: number, o?: Intl.NumberFormatOptions) => string
    money: (n: number, c?: string) => string
    percent: (n: number, dp?: number) => string
    date: (v: unknown, o?: Intl.DateTimeFormatOptions) => string
    duration: (m: number) => string
  }
}

let H: Helpers

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  H = new Function(`${helperScript()}\nreturn { geo: geo, csv: csv, fmt: fmt }`)() as Helpers
})

describe('geo.distance', () => {
  it('matches a known great-circle distance', () => {
    // London to Paris is ~344 km.
    const d = H.geo.distance({ lat: 51.5074, lon: -0.1278 }, { lat: 48.8566, lon: 2.3522 })
    expect(d).toBeGreaterThan(330)
    expect(d).toBeLessThan(355)
  })

  it('is zero for the same point and symmetric', () => {
    const a = { lat: 51.5, lon: -0.1 }
    const b = { lat: 40.7, lon: -74 }
    expect(H.geo.distance(a, a)).toBeCloseTo(0, 6)
    expect(H.geo.distance(a, b)).toBeCloseTo(H.geo.distance(b, a), 6)
  })

  it('handles antipodes without going imaginary', () => {
    // The naive haversine takes sqrt of something a hair over 1 here and
    // returns NaN. Half the earth's circumference is ~20 015 km.
    const d = H.geo.distance({ lat: 0, lon: 0 }, { lat: 0, lon: 180 })
    expect(Number.isFinite(d)).toBe(true)
    expect(d).toBeGreaterThan(20000)
  })

  it('answers NaN rather than a number for missing input', () => {
    expect(Number.isNaN(H.geo.distance(null as never, { lat: 0, lon: 0 }))).toBe(true)
  })
})

describe('geo.project', () => {
  it('puts the origin in the middle at zoom 0', () => {
    const p = H.geo.project({ lat: 0, lon: 0 }, 1)
    expect(p.x).toBeCloseTo(1, 6)
    expect(p.y).toBeCloseTo(1, 6)
  })

  it('never returns a negative y at the Mercator limit', () => {
    // The bug this exists to prevent: clamping the LATITUDE still leaves y a
    // few parts in 1e11 outside the range, which floors to tile row -1 and
    // requests a tile that does not exist.
    for (const lat of [85.05112878, 85.06, 90, -85.05112878, -90]) {
      for (const z of [0, 1, 8, 18]) {
        const p = H.geo.project({ lat, lon: 0 }, z)
        expect(p.y, `lat ${lat} z ${z}`).toBeGreaterThanOrEqual(0)
        expect(p.y, `lat ${lat} z ${z}`).toBeLessThanOrEqual(2 ** z)
        expect(Math.floor(p.y)).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('round-trips through unproject', () => {
    const start = { lat: 51.5074, lon: -0.1278 }
    const p = H.geo.project(start, 12)
    const back = H.geo.unproject(p.x, p.y, 12)
    expect(back.lat).toBeCloseTo(start.lat, 6)
    expect(back.lon).toBeCloseTo(start.lon, 6)
  })
})

describe('geo.tilesFor', () => {
  it('covers the box and places each tile', () => {
    const tiles = H.geo.tilesFor({ lat: 51.5, lon: -0.12 }, 12, 512, 512)
    expect(tiles.length).toBeGreaterThanOrEqual(4)
    for (const t of tiles) {
      expect(t.url).toContain('/12/')
      expect(t.left).toBeLessThanOrEqual(512)
      expect(t.top).toBeLessThanOrEqual(512)
    }
  })

  it('never asks for a tile row outside the world', () => {
    for (const lat of [89.9, -89.9]) {
      for (const t of H.geo.tilesFor({ lat, lon: 0 }, 3, 600, 600)) {
        expect(t.y, `lat ${lat}`).toBeGreaterThanOrEqual(0)
        expect(t.y, `lat ${lat}`).toBeLessThan(2 ** 3)
      }
    }
  })

  it('wraps around the date line instead of asking for a negative column', () => {
    for (const t of H.geo.tilesFor({ lat: 0, lon: 179.9 }, 3, 800, 400)) {
      expect(t.x).toBeGreaterThanOrEqual(0)
      expect(t.x).toBeLessThan(2 ** 3)
    }
  })
})

describe('csv.parse', () => {
  it('reads a plain file', () => {
    expect(H.csv.parse('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
  })

  it('keeps a comma inside quotes', () => {
    // The single most common failure of a hand-rolled split(',').
    expect(H.csv.parse('name,addr\nAcme,"12 Mill St, Bristol"')).toEqual([
      ['name', 'addr'],
      ['Acme', '12 Mill St, Bristol']
    ])
  })

  it('keeps a newline inside quotes', () => {
    expect(H.csv.parse('a,b\n"line one\nline two",x')).toEqual([
      ['a', 'b'],
      ['line one\nline two', 'x']
    ])
  })

  it('reads a doubled quote as one quote', () => {
    expect(H.csv.parse('a\n"He said ""hi"""')).toEqual([['a'], ['He said "hi"']])
  })

  it('handles CRLF, which is what a Windows export gives you', () => {
    expect(H.csv.parse('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
  })

  it('does not invent a trailing empty row', () => {
    expect(H.csv.parse('a,b\n1,2\n')).toHaveLength(2)
  })

  it('survives empty input', () => {
    expect(H.csv.parse('')).toEqual([])
    expect(H.csv.parse(null as never)).toEqual([])
  })

  it('takes another delimiter', () => {
    expect(H.csv.parse('a;b\n1;2', ';')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
  })
})

describe('csv.parseObjects', () => {
  it('keys rows by the header', () => {
    expect(H.csv.parseObjects('name,qty\nAcme,3')).toEqual([{ name: 'Acme', qty: '3' }])
  })

  it('drops blank lines rather than yielding empty records', () => {
    expect(H.csv.parseObjects('name,qty\nAcme,3\n,\n')).toEqual([{ name: 'Acme', qty: '3' }])
  })

  it('fills a short row rather than dropping the column', () => {
    expect(H.csv.parseObjects('a,b,c\n1,2')).toEqual([{ a: '1', b: '2', c: '' }])
  })
})

describe('csv.format', () => {
  it('round-trips a value that needs quoting', () => {
    const rows = [
      ['name', 'note'],
      ['Acme', 'a, b\n"c"']
    ]
    expect(H.csv.parse(H.csv.format(rows))).toEqual(rows)
  })

  it('leaves plain values unquoted', () => {
    expect(H.csv.format([['a', 'b']])).toBe('a,b')
  })

  it('writes null and undefined as empty, not as the words', () => {
    expect(H.csv.format([[null, undefined, 0]])).toBe(',,0')
  })
})

describe('fmt', () => {
  it('says — for a number that is not one, rather than NaN', () => {
    // NaN on screen looks like a bug; an em dash reads as "nothing here".
    for (const bad of [NaN, Infinity, null, undefined]) {
      expect(H.fmt.number(bad as never)).toBe('—')
    }
    expect(H.fmt.date('not a date')).toBe('—')
    expect(H.fmt.duration(NaN)).toBe('—')
  })

  it('formats real values', () => {
    expect(H.fmt.number(1234.5)).toMatch(/1[,.\s]?234/)
    expect(H.fmt.percent(0.125)).toContain('%')
    expect(H.fmt.money(10, 'GBP')).toMatch(/10/)
  })

  it('reads a duration the way a person would say it', () => {
    expect(H.fmt.duration(135)).toBe('2 h 15 min')
    expect(H.fmt.duration(45)).toBe('45 min')
    expect(H.fmt.duration(0)).toBe('0 min')
  })
})
