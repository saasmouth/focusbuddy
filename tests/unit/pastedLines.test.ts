// A multi-line paste into a one-line ask box keeps its lines for the AI (lib/pastedLines).
import { describe, it, expect } from 'vitest'
import { multilinePaste, withKeptLines } from '../../src/renderer/src/lib/pastedLines'

describe('kept lines', () => {
  it('a several-line paste reads on one line in the box and is sent as it was', () => {
    const k = multilinePaste('Hi Ann,\r\n\r\n  Can we move Friday?\nThanks\n')!
    expect(k.flat).toBe('Hi Ann, Can we move Friday? Thanks')
    expect(k.full).toBe('Hi Ann,\n\n  Can we move Friday?\nThanks')
    expect(withKeptLines(`Summarise this: ${k.flat}`, [k])).toBe('Summarise this: Hi Ann,\n\n  Can we move Friday?\nThanks')
  })
  it('one line is left to the box; an edited paste is sent as edited', () => {
    expect(multilinePaste('just one line\n')).toBeNull()
    const k = multilinePaste('a\nb')!
    expect(withKeptLines('a then b', [k])).toBe('a then b')
  })
})
