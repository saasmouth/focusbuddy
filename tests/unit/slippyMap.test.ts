import { describe, it, expect } from 'vitest'
import {
  project,
  unproject,
  tilesFor,
  pointAt,
  panBy,
  tileUrl,
  osmLink,
  TILE
} from '../../src/renderer/src/lib/slippyMap'

// Known reference points. Web Mercator at zoom 0 puts (0,0) at tile centre
// (0.5, 0.5); Sydney's coordinates are used because they are the ones the
// widget was built to show and they are in the southern AND eastern quadrant,
// which is where sign errors surface.
const SYDNEY = { lat: -33.8688, lon: 151.2093 }

describe('project / unproject', () => {
  it('puts the null island at the middle of the world at zoom 0', () => {
    const p = project({ lat: 0, lon: 0 }, 0)
    expect(p.x).toBeCloseTo(0.5, 6)
    expect(p.y).toBeCloseTo(0.5, 6)
  })

  it('round-trips a real location at a real zoom', () => {
    const z = 14
    const p = project(SYDNEY, z)
    const back = unproject(p.x, p.y, z)
    expect(back.lat).toBeCloseTo(SYDNEY.lat, 9)
    expect(back.lon).toBeCloseTo(SYDNEY.lon, 9)
  })

  it('places Sydney in the lower-right quadrant of the world', () => {
    const p = project(SYDNEY, 1)
    // East of Greenwich -> x past halfway; southern -> y past halfway.
    expect(p.x).toBeGreaterThan(1)
    expect(p.y).toBeGreaterThan(1)
  })

  it('clamps beyond the Mercator limit instead of returning infinity', () => {
    const p = project({ lat: 89.9, lon: 0 }, 3)
    expect(Number.isFinite(p.y)).toBe(true)
    expect(p.y).toBeGreaterThanOrEqual(0)
  })
})

describe('tilesFor', () => {
  it('covers the viewport', () => {
    const tiles = tilesFor(SYDNEY, 14, 600, 400)
    // 600x400 needs at least 3x2 tiles of 256px, plus the partial edge row/col.
    expect(tiles.length).toBeGreaterThanOrEqual(3 * 2)
    const left = Math.min(...tiles.map((t) => t.left))
    const top = Math.min(...tiles.map((t) => t.top))
    const right = Math.max(...tiles.map((t) => t.left + TILE))
    const bottom = Math.max(...tiles.map((t) => t.top + TILE))
    expect(left).toBeLessThanOrEqual(0)
    expect(top).toBeLessThanOrEqual(0)
    expect(right).toBeGreaterThanOrEqual(600)
    expect(bottom).toBeGreaterThanOrEqual(400)
  })

  it('never asks for a tile outside the world', () => {
    for (const z of [0, 1, 5, 14]) {
      const n = 2 ** z
      for (const tile of tilesFor(SYDNEY, z, 900, 700)) {
        expect(tile.x).toBeGreaterThanOrEqual(0)
        expect(tile.x).toBeLessThan(n)
        expect(tile.y).toBeGreaterThanOrEqual(0)
        expect(tile.y).toBeLessThan(n)
      }
    }
  })

  it('drops rows past the poles rather than requesting a 404', () => {
    // At zoom 0 there is exactly one tile in the world, so a tall viewport
    // must not produce three.
    const tiles = tilesFor({ lat: 0, lon: 0 }, 0, 256, 1200)
    expect(tiles.every((t) => t.y === 0)).toBe(true)
  })

  it('wraps longitude across the antimeridian', () => {
    const tiles = tilesFor({ lat: 0, lon: 179.9 }, 3, 800, 256)
    const n = 2 ** 3
    expect(tiles.some((t) => t.x === n - 1)).toBe(true)
    expect(tiles.some((t) => t.x === 0)).toBe(true)
  })
})

describe('pointAt', () => {
  it('puts the centre in the middle of the viewport', () => {
    const p = pointAt(SYDNEY, SYDNEY, 14, 600, 400)
    expect(p.left).toBeCloseTo(300, 6)
    expect(p.top).toBeCloseTo(200, 6)
  })

  it('puts a point east of centre to the right of it', () => {
    const p = pointAt({ lat: SYDNEY.lat, lon: SYDNEY.lon + 0.01 }, SYDNEY, 14, 600, 400)
    expect(p.left).toBeGreaterThan(300)
  })

  it('puts a point north of centre above it', () => {
    const p = pointAt({ lat: SYDNEY.lat + 0.01, lon: SYDNEY.lon }, SYDNEY, 14, 600, 400)
    expect(p.top).toBeLessThan(200)
  })
})

describe('panBy', () => {
  it('dragging right moves the view west', () => {
    const moved = panBy(SYDNEY, 14, 100, 0)
    expect(moved.lon).toBeLessThan(SYDNEY.lon)
  })

  it('dragging down moves the view north', () => {
    const moved = panBy(SYDNEY, 14, 0, 100)
    expect(moved.lat).toBeGreaterThan(SYDNEY.lat)
  })

  it('a drag and its reverse return to the start', () => {
    const there = panBy(SYDNEY, 14, 137, -88)
    const back = panBy(there, 14, -137, 88)
    expect(back.lat).toBeCloseTo(SYDNEY.lat, 9)
    expect(back.lon).toBeCloseTo(SYDNEY.lon, 9)
  })
})

describe('urls', () => {
  it('builds a standard OSM tile url', () => {
    expect(tileUrl({ z: 14, x: 15073, y: 9832 })).toBe(
      'https://tile.openstreetmap.org/14/15073/9832.png'
    )
  })
  it('builds a shareable osm.org link', () => {
    expect(osmLink(SYDNEY, 15)).toBe('https://www.openstreetmap.org/#map=15/-33.86880/151.20930')
  })
})
