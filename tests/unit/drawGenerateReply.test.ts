// What the model actually sends back, and whether this app can find the JSON
// in it. Local models in particular wrap replies in prose or a fence, stop
// mid-object, or answer with an apology — every case below has been seen in
// this repo's other AI surfaces, and each must end as a clean parse or a
// refusal, never as a half-built drawing.

import { describe, expect, it } from 'vitest'
import { firstJsonObject } from '../../src/main/ai/drawGenerate'

describe('firstJsonObject', () => {
  it('reads a plain object', () => {
    expect(firstJsonObject('{"items":[]}')).toEqual({ items: [] })
  })

  it('reads one wrapped in a markdown fence', () => {
    expect(firstJsonObject('```json\n{"items":[1]}\n```')).toEqual({ items: [1] })
  })

  it('reads one buried in chatter, which is how a small model answers', () => {
    expect(firstJsonObject('Sure! Here is the art you asked for:\n{"name":"x","items":[]}\nHope that helps.')).toEqual({
      name: 'x',
      items: []
    })
  })

  it('takes the whole object, not the first closing brace inside it', () => {
    const v = firstJsonObject('{"items":[{"shape":{"kind":"rect"}}],"name":"n"}') as { name?: string }
    expect(v.name).toBe('n')
  })

  it('is not fooled by a brace inside a string', () => {
    const v = firstJsonObject('{"name":"a } b","items":[]}') as { name?: string }
    expect(v.name).toBe('a } b')
  })

  it('returns null for an apology, a truncated reply, or no JSON at all', () => {
    expect(firstJsonObject('I cannot draw that.')).toBeNull()
    expect(firstJsonObject('{"items":[{"shape":')).toBeNull()
    expect(firstJsonObject('')).toBeNull()
  })
})
