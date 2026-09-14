// A sparkline's arithmetic, including the series nobody designs for.
import { describe, it, expect } from 'vitest'
import { sparklinePath, delta, compact } from '../../src/renderer/src/lib/sparkline'

describe('the path', () => {
  it('draws nothing from nothing', () => {
    expect(sparklinePath([], 100, 40)).toBe('')
  })

  it('draws one reading as a flat line, not a dot in a corner', () => {
    const p = sparklinePath([7], 100, 40)
    expect(p).toMatch(/^M 2 20 L 98 20$/)
  })

  it('puts a flat series through the middle rather than on the floor', () => {
    // Every point identical is a zero range; dividing by it pins the line to
    // the bottom edge and reads as a collapse that did not happen.
    const p = sparklinePath([5, 5, 5, 5], 100, 40)
    const ys = [...p.matchAll(/[ML] [\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]))
    expect(new Set(ys).size).toBe(1)
    expect(ys[0]).toBeCloseTo(20, 1)
  })

  it('rises with the data', () => {
    const p = sparklinePath([0, 10], 100, 40)
    const ys = [...p.matchAll(/[ML] [\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]))
    expect(ys[1]).toBeLessThan(ys[0]) // smaller y is higher on screen
  })
})

describe('the delta', () => {
  it('needs two readings to have a direction', () => {
    expect(delta([])).toBeNull()
    expect(delta([5])).toBeNull()
  })

  it('reports the move end to end', () => {
    expect(delta([100, 120])!.pct).toBeCloseTo(20)
    expect(delta([100, 120])!.direction).toBe('up')
    expect(delta([120, 60])!.pct).toBeCloseTo(-50)
    expect(delta([120, 60])!.direction).toBe('down')
  })

  it('calls a negligible move flat rather than dressing it as growth', () => {
    expect(delta([1000, 1000.2])!.direction).toBe('flat')
  })

  it('invents no percentage from a base of zero', () => {
    // Infinity% is not a thing to put on a card.
    const d = delta([0, 40])!
    expect(Number.isFinite(d.pct)).toBe(true)
    expect(d.pct).toBe(0)
    expect(d.direction).toBe('up')
  })

  it('handles a negative base without flipping the direction', () => {
    expect(delta([-100, -50])!.direction).toBe('up')
  })
})

describe('compact numbers', () => {
  it.each([
    [0, '0'], [42, '42'], [999, '999'], [1200, '1.2k'], [12_000, '12k'],
    [5_200_000, '5.2M'], [2_400_000_000, '2.4B'], [-1500, '-1.5k']
  ])('%s -> %s', (n, want) => {
    expect(compact(n as number)).toBe(want)
  })
})
