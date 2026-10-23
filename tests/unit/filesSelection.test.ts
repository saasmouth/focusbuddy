import { describe, it, expect } from 'vitest'
import { nextSelection, stepSelection } from '../../src/renderer/src/lib/filesSelection'

const order = ['a', 'b', 'c', 'd', 'e']
describe('Files multi-select', () => {
  it('click selects one', () => expect(nextSelection(order, ['a', 'b'], 'a', 'c', {})).toEqual({ ids: ['c'], focus: 'c' }))
  it('⌘-click toggles', () => {
    expect(nextSelection(order, ['a'], 'a', 'c', { meta: true })).toEqual({ ids: ['a', 'c'], focus: 'c' })
    expect(nextSelection(order, ['a', 'c'], 'c', 'a', { meta: true })).toEqual({ ids: ['c'], focus: 'a' })
  })
  it('⇧-click selects the range from the anchor, either direction', () => {
    expect(nextSelection(order, ['b'], 'b', 'd', { shift: true }).ids).toEqual(['b', 'c', 'd'])
    expect(nextSelection(order, ['d'], 'd', 'a', { shift: true }).ids).toEqual(['a', 'b', 'c', 'd'])
  })
  it('⌘⇧-click adds the range', () => {
    expect(nextSelection(order, ['a'], 'c', 'e', { shift: true, meta: true }).ids).toEqual(['a', 'c', 'd', 'e'])
  })
  it('arrows move; ⇧ arrows extend from the anchor; edges clamp', () => {
    expect(stepSelection(order, [], null, null, 1, false)).toEqual({ ids: ['a'], focus: 'a', anchor: 'a' })
    expect(stepSelection(order, ['b'], 'b', 'b', 1, true)).toEqual({ ids: ['b', 'c'], focus: 'c', anchor: 'b' })
    expect(stepSelection(order, ['b', 'c'], 'c', 'b', -1, true)).toEqual({ ids: ['b'], focus: 'b', anchor: 'b' })
    expect(stepSelection(order, ['e'], 'e', 'e', 1, false).focus).toBe('e')
    expect(stepSelection([], [], null, null, 1, false)).toEqual({ ids: [], focus: null, anchor: null })
  })
})
