import { describe, it, expect } from 'vitest'
import { blank, harness, rect } from './harness'

describe('pan tool (H), Space and the middle button', () => {
  it('a drag scrolls the canvas the opposite way', () => {
    const h = harness()
    h.scroll.left = 100
    h.scroll.top = 100
    h.tool('hand')
    h.drag([50, 50], [80, 70])
    expect(h.scroll).toEqual({ left: 70, top: 80 })
  })

  it('holding Space pans from any tool, and nothing is drawn', () => {
    const h = harness()
    h.tool('rect')
    h.key(' ', { code: 'Space' })
    expect(h.state().spaceDown).toBe(true)
    h.drag([10, 10], [60, 60])
    expect(h.objects()).toHaveLength(0)
    expect(h.scroll).toEqual({ left: -50, top: -50 })
    h.keyUp('Space')
    expect(h.state().spaceDown).toBe(false)
  })

  it('the middle button pans without selecting', () => {
    const h = harness(blank([rect('a', 0, 0, 100, 100)]))
    h.drag([10, 10], [30, 30], { button: 1 })
    expect(h.state().selection).toEqual([])
    expect(h.scroll).toEqual({ left: -20, top: -20 })
  })

  it('a right-click does nothing at all', () => {
    const h = harness(blank([rect('a', 0, 0, 100, 100)]))
    h.click(10, 10, { button: 2 })
    expect(h.state().selection).toEqual([])
  })
})
