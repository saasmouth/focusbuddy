import { describe, it, expect } from 'vitest'
import { blank, harness, rect } from './harness'

describe('eyedropper tool (I)', () => {
  it('picks a shape\'s solid fill for both the next fill and the brush', () => {
    const h = harness(blank([rect('a', 10, 10, 40, 40, { fill: { type: 'solid', color: '#ff8800' } })]))
    h.tool('eyedropper')
    h.click(20, 20)
    expect(h.state().fill).toEqual({ type: 'solid', color: '#ff8800' })
    expect(h.state().brush.color).toBe('#ff8800')
    expect(h.state().status).toBe('Picked #ff8800')
  })

  it('falls back to the painted pixels', () => {
    const h = harness(
      blank([], {
        layers: [
          { id: 'L1', kind: 'vector', name: 'L', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [] },
          { id: 'P1', kind: 'raster', name: 'Paint', visible: true, locked: false, opacity: 1, blend: 'normal', src: '' }
        ]
      })
    )
    h.raster.setPixel('P1', 5, 6, [1, 2, 3, 255])
    h.tool('eyedropper')
    h.click(5, 6)
    expect(h.state().fill).toEqual({ type: 'solid', color: '#010203' })
  })

  it('an empty spot says so instead of inventing a colour', () => {
    const h = harness()
    h.tool('eyedropper')
    h.click(5, 6)
    expect(h.state().status).toBe('Nothing to pick there — that spot is empty.')
    expect(h.state().fill).toEqual({ type: 'solid', color: '#6d5dfc' })
  })
})
