import { describe, it, expect } from 'vitest'
import { evaluateArithmetic } from '../../src/renderer/src/lib/calcExpression'

// The calculator widget's evaluator. Every case is checked against what
// JavaScript itself gives for the same expression, which is what the widget
// showed back when it (wrongly, under the renderer CSP) used `new Function`.
const sameAsJs = [
  '1250*12',
  '1000000 / (6 * 3600)',
  '2 + 3 * 4',
  '(2 + 3) * 4',
  '10 - 4 - 3',
  '100 / 10 / 5',
  '17 % 5',
  '-3 + 5',
  '-(2 + 3) * 2',
  '+4 - -2',
  '.5 + 1.25',
  '3.',
  '  7 *  ( 8 - 2 )  ',
  '0.1 + 0.2',
  '((((9))))'
]

describe('evaluateArithmetic', () => {
  for (const e of sameAsJs)
    it(`${e} matches JavaScript`, () => {
      // eslint-disable-next-line no-new-func
      expect(evaluateArithmetic(e)).toBe(Function(`"use strict"; return (${e})`)())
    })

  it('rejects malformed input instead of guessing', () => {
    for (const e of ['', '   ', '1 +', '* 2', '(1 + 2', '1 + 2)', '1 2', '..5', '1..2', '()', '5 % ', '3 ** 2'])
      expect(evaluateArithmetic(e), e).toBeNull()
  })

  it('treats division by zero as no answer, not Infinity', () => {
    expect(evaluateArithmetic('1 / 0')).toBeNull()
    expect(evaluateArithmetic('0 / 0')).toBeNull()
  })

  it('never evaluates anything but arithmetic', () => {
    expect(evaluateArithmetic('alert(1)')).toBeNull()
    expect(evaluateArithmetic('1; 2')).toBeNull()
  })
})
