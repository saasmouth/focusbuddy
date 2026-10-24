import { describe, expect, it } from 'vitest'
import { GLIDE_MIN_SPEED, glideSteps } from '../../src/renderer/src/lib/dragGlide'

describe('drag glide', () => {
  it('a flick keeps moving the same way and slows to a stop', () => {
    const steps = glideSteps(0, 20)
    expect(steps.length).toBeGreaterThan(20)
    expect(steps.every(([, y]) => y > 0)).toBe(true)
    for (let i = 1; i < steps.length; i++) expect(steps[i][1]).toBeLessThan(steps[i - 1][1])
    expect(Math.hypot(...steps[steps.length - 1])).toBeGreaterThanOrEqual(GLIDE_MIN_SPEED)
  })
  it('a slow release does not glide at all', () => {
    expect(glideSteps(0.05, 0.05)).toEqual([])
  })
  it('the glide travels a sensible distance, not forever', () => {
    const total = glideSteps(0, 20).reduce((a, [, y]) => a + y, 0)
    expect(total).toBeGreaterThan(200)
    expect(total).toBeLessThan(400)
  })
})
