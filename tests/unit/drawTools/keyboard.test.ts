import { describe, it, expect } from 'vitest'
import { nodeBounds } from '../../../src/shared/draw/ops'
import { drawTools } from '../../../src/renderer/src/components/documents/draw/tools/registry'
import { blank, harness, rect } from './harness'

const x = (h: ReturnType<typeof harness>, id: string): number => nodeBounds(h.objects().find((o) => o.id === id)!).x

describe('the keyboard', () => {
  it('every tool letter selects its tool (Shift or not), and ⌘ with a letter does not', () => {
    for (const t of drawTools()) {
      const h = harness()
      h.key(t.key!.toLowerCase())
      expect(h.state().tool, t.id).toBe(t.id)
      const g = harness()
      g.key(t.key!, { shift: true })
      expect(g.state().tool, `${t.id} with Shift`).toBe(t.id)
    }
    const h = harness()
    h.key('r', { meta: true })
    expect(h.state().tool).toBe('select')
  })

  it('Delete and Backspace remove the editable selection, and are always swallowed', () => {
    const h = harness(blank([rect('a', 10, 10, 10, 10), rect('b', 50, 10, 10, 10)]))
    h.ed.ctx.select(['a'])
    expect(h.key('Delete').prevented).toBe(true)
    expect(h.objects().map((o) => o.id)).toEqual(['b'])
    expect(h.key('Backspace').prevented).toBe(true)
  })

  it('arrows nudge 1px, Shift-arrows 10px, one undo step each; with nothing selected they are left alone', () => {
    const h = harness(blank([rect('a', 100, 100, 10, 10)]))
    expect(h.key('ArrowRight').prevented).toBe(false)
    h.ed.ctx.select(['a'])
    expect(h.key('ArrowRight').prevented).toBe(true)
    h.key('ArrowLeft', { shift: true })
    expect(x(h, 'a')).toBe(91)
    expect(h.state().past).toHaveLength(2)
  })

  it('⌘Z undoes, ⇧⌘Z and ⌘Y redo, ⌘D duplicates', () => {
    const h = harness(blank([rect('a', 100, 100, 10, 10)]))
    h.ed.ctx.select(['a'])
    h.key('d', { meta: true })
    expect(h.objects()).toHaveLength(2)
    expect(h.state().selection).not.toEqual(['a'])
    h.key('z', { meta: true })
    expect(h.objects()).toHaveLength(1)
    h.key('z', { meta: true, shift: true })
    expect(h.objects()).toHaveLength(2)
    h.key('z', { ctrl: true })
    h.key('y', { ctrl: true })
    expect(h.objects()).toHaveLength(2)
  })

  it('⌘A selects everything that is neither locked nor hidden', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10), rect('l', 20, 0, 10, 10, { locked: true }), rect('h', 40, 0, 10, 10, { hidden: true })]))
    h.key('a', { meta: true })
    expect(h.state().selection).toEqual(['a'])
  })

  it('Escape clears the selection; [ and ] resize the brush by 15%', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.ed.ctx.select(['a'])
    h.key('Escape')
    expect(h.state().selection).toEqual([])
    const before = h.state().brush.size
    h.key(']')
    expect(h.state().brush.size).toBeCloseTo(before + Math.max(1, before * 0.15), 6)
    h.key('[')
    h.key('[')
    expect(h.state().brush.size).toBeLessThan(before)
  })

  it('keys typed into a field are left to the field', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.ed.ctx.select(['a'])
    h.key('Delete', { inField: true })
    h.key('p', { inField: true })
    expect(h.objects()).toHaveLength(1)
    expect(h.state().tool).toBe('select')
  })

  it('read-only: only ⌘A, Escape, V and H do anything', () => {
    const h = harness({ ...blank([rect('a', 0, 0, 10, 10)]), schemaVersion: 3 })
    h.key('a', { meta: true })
    expect(h.state().selection).toEqual(['a'])
    for (const k of ['Delete', 'ArrowRight', 'd']) h.key(k)
    h.key('d', { meta: true })
    h.key('r')
    expect(h.state().tool).toBe('select')
    h.key('h')
    expect(h.state().tool).toBe('hand')
    expect(h.objects()).toHaveLength(1)
    expect(h.emitted).toHaveLength(0)
  })
})
