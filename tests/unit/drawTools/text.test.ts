import { describe, it, expect } from 'vitest'
import type { DrawTextNode } from '../../../src/shared/draw/model'
import { harness } from './harness'

describe('type tool (T)', () => {
  it('a click drops a default 48pt box and starts typing into it', () => {
    const h = harness()
    h.tool('text')
    h.click(40, 50)
    const t = h.objects()[0] as DrawTextNode
    expect(t).toMatchObject({ type: 'text', x: 40, y: 50, fontSize: 48, text: '' })
    // Width: to the artboard edge, between 80 and 320.
    expect(t.w).toBe(320)
    expect(h.state().editingText).toBe(t.id)
    expect(h.state().tool).toBe('select')
    expect(t.lines).toEqual([''])
  })

  it('a drag sizes the box; the point size follows its height', () => {
    const h = harness()
    h.tool('text')
    h.drag([40, 50], [240, 110])
    const t = h.objects()[0] as DrawTextNode
    expect(t).toMatchObject({ x: 40, y: 50, w: 200, fontSize: 30 })
  })

  it('a transparent default fill becomes ink, so new text is never invisible', () => {
    const h = harness()
    h.ed.store.setState({ fill: { type: 'none' } })
    h.tool('text')
    h.click(10, 10)
    expect((h.objects()[0] as DrawTextNode).fill).toEqual({ type: 'solid', color: '#1c1917' })
  })
})
