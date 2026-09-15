import { describe, it, expect } from 'vitest'
import { caretCoordinates } from '../../src/renderer/src/lib/caretCoordinates'

// happy-dom does no real layout, so offsets are 0 — what CAN be asserted here
// is that the function is safe, leaves no mirror behind, and reports positions
// relative to the field rather than the document.

function field(value: string): HTMLTextAreaElement {
  const ta = document.createElement('textarea')
  ta.value = value
  document.body.appendChild(ta)
  return ta
}

describe('caretCoordinates', () => {
  it('returns a point for a caret inside the text', () => {
    const ta = field('hello @wor')
    const p = caretCoordinates(ta, 10)
    expect(Number.isFinite(p.left)).toBe(true)
    expect(Number.isFinite(p.top)).toBe(true)
    expect(p.bottom).toBeGreaterThanOrEqual(p.top)
  })

  it('cleans up after itself — no mirror is left in the document', () => {
    const before = document.body.children.length
    const ta = field('some text')
    caretCoordinates(ta, 4)
    // The field itself is the only addition.
    expect(document.body.children.length).toBe(before + 1)
  })

  it('handles an empty field and an index past the end', () => {
    const ta = field('')
    expect(() => caretCoordinates(ta, 0)).not.toThrow()
    expect(() => caretCoordinates(ta, 99)).not.toThrow()
  })

  it('works for an input as well as a textarea', () => {
    const el = document.createElement('input')
    el.value = 'ask @rid'
    document.body.appendChild(el)
    expect(() => caretCoordinates(el, 8)).not.toThrow()
  })
})
