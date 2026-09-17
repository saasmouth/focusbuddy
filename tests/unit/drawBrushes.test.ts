import { describe, it, expect } from 'vitest'
import {
  BRUSH_PRESETS,
  brushFromPreset,
  findBrushPreset,
  noiseAt,
  stampsForDot,
  stampsForSegment,
  type BrushSettings
} from '../../src/renderer/src/components/documents/draw/brushes'

function brush(id: string, over: Partial<BrushSettings> = {}): BrushSettings {
  return { ...brushFromPreset(findBrushPreset(id)), ...over }
}
const from = { x: 0, y: 0, pressure: 1 }
const to = { x: 100, y: 0, pressure: 1 }

describe('brushes — the preset library', () => {
  it('every preset is complete and uniquely identified', () => {
    const ids = new Set(BRUSH_PRESETS.map((b) => b.id))
    expect(ids.size).toBe(BRUSH_PRESETS.length)
    expect(BRUSH_PRESETS.length).toBeGreaterThanOrEqual(12)
    for (const b of BRUSH_PRESETS) {
      expect(b.name.length).toBeGreaterThan(0)
      expect(b.blurb.length).toBeGreaterThan(10)
      expect(b.size).toBeGreaterThan(0)
      expect(b.spacing).toBeGreaterThan(0)
      expect(b.opacity).toBeGreaterThan(0)
      expect(b.hardness).toBeGreaterThanOrEqual(0)
      expect(b.hardness).toBeLessThanOrEqual(1)
    }
  })

  it('covers the art styles it claims to', () => {
    const ids = BRUSH_PRESETS.map((b) => b.id)
    for (const want of ['round-hard', 'round-soft', 'airbrush', 'pencil', 'ink', 'calligraphy', 'marker', 'charcoal', 'chalk', 'spray', 'watercolour', 'oil']) {
      expect(ids).toContain(want)
    }
  })

  it('an unknown id falls back rather than throwing', () => {
    expect(findBrushPreset('nope').id).toBe(BRUSH_PRESETS[0].id)
  })

  it('every preset lays down real marks on a real stroke', () => {
    for (const p of BRUSH_PRESETS) {
      const stamps = stampsForSegment(from, to, brushFromPreset(p))
      expect(stamps.length, `${p.id} laid no stamps`).toBeGreaterThan(0)
      expect(stamps.every((s) => s.rx > 0 && s.ry > 0 && s.alpha > 0), `${p.id} produced an invisible stamp`).toBe(true)
      expect(stamps.every((s) => Number.isFinite(s.x) && Number.isFinite(s.y)), `${p.id} produced a NaN position`).toBe(true)
    }
  })
})

describe('brushes — stamp placement', () => {
  it('stamps follow the stroke from start to end', () => {
    const stamps = stampsForSegment(from, to, brush('round-hard'))
    expect(stamps[0].x).toBeGreaterThan(0)
    expect(stamps[stamps.length - 1].x).toBeCloseTo(100, 3)
    expect(stamps.every((s) => Math.abs(s.y) < 1)).toBe(true)
  })

  it('tighter spacing lays down more stamps', () => {
    const wide = stampsForSegment(from, to, brush('round-hard', { spacing: 0.5 })).length
    const tight = stampsForSegment(from, to, brush('round-hard', { spacing: 0.05 })).length
    expect(tight).toBeGreaterThan(wide)
  })

  it('a longer stroke lays down proportionally more stamps', () => {
    const short = stampsForSegment(from, { x: 50, y: 0, pressure: 1 }, brush('round-hard')).length
    const long = stampsForSegment(from, { x: 200, y: 0, pressure: 1 }, brush('round-hard')).length
    expect(long).toBeGreaterThan(short * 2)
  })

  it('a click with no drag still leaves exactly one mark', () => {
    const stamps = stampsForDot({ x: 10, y: 10, pressure: 1 }, brush('round-hard'))
    expect(stamps.length).toBeGreaterThan(0)
    expect(stamps[0].rx).toBeGreaterThan(0)
  })

  it('a zero-length segment does not divide by zero', () => {
    const stamps = stampsForSegment(from, { ...from }, brush('round-hard'))
    expect(stamps.every((s) => Number.isFinite(s.x) && Number.isFinite(s.rx))).toBe(true)
  })
})

describe('brushes — dynamics', () => {
  it('pressure drives the stamp size when the brush says so', () => {
    const light = stampsForSegment({ ...from, pressure: 0.1 }, { ...to, pressure: 0.1 }, brush('round-hard'))
    const heavy = stampsForSegment({ ...from, pressure: 1 }, { ...to, pressure: 1 }, brush('round-hard'))
    expect(heavy[0].rx).toBeGreaterThan(light[0].rx)
  })

  it('a brush with pressure size off keeps one width', () => {
    const light = stampsForSegment({ ...from, pressure: 0.1 }, { ...to, pressure: 0.1 }, brush('marker'))
    const heavy = stampsForSegment({ ...from, pressure: 1 }, { ...to, pressure: 1 }, brush('marker'))
    expect(heavy[0].rx).toBeCloseTo(light[0].rx, 6)
  })

  it('pressure drives opacity on an airbrush', () => {
    const light = stampsForSegment({ ...from, pressure: 0.1 }, { ...to, pressure: 0.1 }, brush('airbrush'))
    const heavy = stampsForSegment({ ...from, pressure: 1 }, { ...to, pressure: 1 }, brush('airbrush'))
    expect(heavy[0].alpha).toBeGreaterThan(light[0].alpha)
  })

  it('an ink pen thins as the stroke speeds up', () => {
    const slow = stampsForSegment(from, { x: 4, y: 0, pressure: 1 }, brush('ink'))
    const fast = stampsForSegment(from, { x: 4000, y: 0, pressure: 1 }, brush('ink'))
    expect(fast[0].rx).toBeLessThan(slow[0].rx)
  })

  it('no stamp is ever wider than the brush or thinner than nothing', () => {
    for (const p of BRUSH_PRESETS) {
      const b = brushFromPreset(p)
      for (const s of stampsForSegment(from, to, b)) {
        expect(s.rx, `${p.id}`).toBeGreaterThan(0)
        expect(s.rx, `${p.id}`).toBeLessThanOrEqual(b.size)
        expect(s.alpha, `${p.id}`).toBeGreaterThan(0)
        expect(s.alpha, `${p.id}`).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('brushes — shape and texture', () => {
  it('a chisel nib is flatter than it is long', () => {
    const s = stampsForSegment(from, to, brush('calligraphy'))[0]
    expect(s.ry).toBeLessThan(s.rx)
  })

  it('a calligraphy nib holds its angle; an oil brush follows the stroke', () => {
    const calli = stampsForSegment(from, { x: 0, y: 100, pressure: 1 }, brush('calligraphy'))[0]
    expect(calli.angle).toBeCloseTo(-40, 6)
    const across = stampsForSegment(from, { x: 0, y: 100, pressure: 1 }, brush('oil'))[0]
    expect(across.angle).toBeCloseTo(90, 6)
  })

  it('a spray throws its dots off the path, and they are small', () => {
    const b = brush('spray')
    const stamps = stampsForSegment(from, to, b)
    expect(stamps.some((s) => Math.abs(s.y) > 2)).toBe(true)
    expect(stamps.every((s) => s.rx < b.size / 4)).toBe(true)
  })

  it('a bristle brush rakes across the direction of travel', () => {
    const stamps = stampsForSegment(from, to, brush('oil'))
    // Travelling along x, the bristles must spread along y.
    expect(Math.max(...stamps.map((s) => Math.abs(s.y)))).toBeGreaterThan(5)
  })

  it('grain varies the alpha stamp to stamp; a smooth brush does not', () => {
    const grainy = new Set(stampsForSegment(from, to, brush('charcoal')).map((s) => s.alpha.toFixed(4)))
    const smooth = new Set(stampsForSegment(from, to, brush('round-hard')).map((s) => s.alpha.toFixed(4)))
    expect(grainy.size).toBeGreaterThan(3)
    expect(smooth.size).toBe(1)
  })

  it('scatter lays several stamps per step', () => {
    const one = stampsForSegment(from, to, brush('round-hard')).length
    const many = stampsForSegment(from, to, brush('round-hard', { scatter: 5 })).length
    expect(many).toBeCloseTo(one * 5, -1)
  })
})

describe('brushes — determinism', () => {
  it('the same stroke produces the same marks every time', () => {
    const a = stampsForSegment(from, to, brush('charcoal'))
    const b = stampsForSegment(from, to, brush('charcoal'))
    expect(a).toEqual(b)
  })

  it('the noise is stable for a position and varies across positions', () => {
    expect(noiseAt(10, 20, 1)).toBe(noiseAt(10, 20, 1))
    expect(noiseAt(10, 20, 1)).not.toBe(noiseAt(10, 20, 2))
    expect(noiseAt(10, 20, 1)).not.toBe(noiseAt(11, 20, 1))
  })

  it('noise stays inside the unit interval', () => {
    for (let i = 0; i < 200; i++) {
      const n = noiseAt(i * 7.3, i * 3.1, i % 5)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThan(1)
    }
  })
})
