import { describe, it, expect } from 'vitest'
import { catalogFor } from '../../src/renderer/src/lib/widgetCatalog'

// No widget may arrive from the picker showing invented figures as if they were
// data. The stat card used to: "Median price $5.2M" with twelve made-up readings.
describe('widget catalog defaults', () => {
  it('a new stat card starts empty, not with made-up figures', () => {
    const entry = catalogFor('stat-card')
    expect(entry).not.toBeNull()
    const content = JSON.parse(entry!.defaultContent)
    expect(content.series).toEqual([])
    expect(entry!.defaultContent).not.toMatch(/\$|Median/)
  })
})
