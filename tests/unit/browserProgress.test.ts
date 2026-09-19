import { describe, expect, it } from 'vitest'
import {
  roundSignature,
  detectStall,
  stallNotice,
  stallSummary,
  steerNotice
} from '../../src/main/ai/browserProgress'

const sig = (o: Partial<Parameters<typeof roundSignature>[0]> = {}): string =>
  roundSignature({ url: 'https://a.test/', textStart: 0, textSample: 'hello', elementCount: 10, ...o })

// Noticing a run is going nowhere.
//
// The loop counted FAILED actions and gave up after four. But the actions that
// trap a run do not fail — clicking an inert button, scrolling a page that will
// not scroll, opening the URL you are already on all return ok, which RESET the
// counter. The one case that most needed a circuit breaker was the one case
// guaranteed not to trip it.
describe('detectStall', () => {
  const rep = (n: number, s: string, a: string): [string[], string[]] => [
    Array(n).fill(s),
    Array(n).fill(a)
  ]

  it('says nothing on a single round', () => {
    expect(detectStall(...rep(1, 'x', 'click 3'))).toBe('none')
  })

  it('warns when the same action leaves the page unchanged twice', () => {
    expect(detectStall(...rep(2, 'x', 'click 3'))).toBe('warn')
  })

  it('stops at three', () => {
    // Two is a coincidence worth mentioning; three is a loop being paid for.
    expect(detectStall(...rep(3, 'x', 'click 3'))).toBe('stop')
  })

  it('does not fire when the page IS changing', () => {
    // Clicking through a paginated list repeats the action deliberately, and
    // every click yields a different page. That is the job, not a loop.
    expect(detectStall(['a', 'b', 'c'], ['click 3', 'click 3', 'click 3'])).toBe('none')
  })

  it('does not fire when the model is trying different things', () => {
    // A page that will not change while the model explores is exploration, and
    // it deserves the budget it was given.
    expect(detectStall(['x', 'x', 'x'], ['click 3', 'scroll 600', 'click 9'])).toBe('none')
  })

  it('recovers once something finally moves', () => {
    expect(detectStall(['x', 'x', 'y'], ['click 3', 'click 3', 'click 3'])).toBe('none')
  })
})

describe('roundSignature', () => {
  it('treats scrolling as progress', () => {
    // The read window moves with the scroll; without this, reading a long page
    // one screenful at a time would look like a stall and be killed.
    expect(sig({ textStart: 0 })).not.toBe(sig({ textStart: 9000 }))
  })

  it('notices a re-render that keeps the URL', () => {
    // Single-page apps navigate without touching the address bar. Watching only
    // the URL would call real progress a stall.
    expect(sig({ textSample: 'results for soup' })).not.toBe(sig({ textSample: 'results for bread' }))
  })

  it('ignores whitespace churn', () => {
    // Re-rendering the same content with different wrapping is not progress.
    expect(sig({ textSample: 'a  b\n c' })).toBe(sig({ textSample: 'a b c' }))
  })

  it('notices a genuine navigation', () => {
    expect(sig({ url: 'https://a.test/' })).not.toBe(sig({ url: 'https://a.test/x' }))
  })
})

describe('what the model is told', () => {
  it('names the specific thing being repeated', () => {
    // "Try something different" is advice a model agrees with and ignores.
    const n = stallNotice('click on element 14')
    expect(n).toContain('click on element 14')
    expect(n).toContain('end the run')
  })

  it('is honest in the summary about why it stopped', () => {
    expect(stallSummary('click on element 14', 7)).toContain('7 rounds')
    expect(stallSummary('click on element 14', 7)).toContain('click on element 14')
  })
})

// Steering a run that is already working.
describe('steerNotice', () => {
  const task = 'find chicken soup recipes'

  it('frames a mid-run instruction as an amendment, not a new task', () => {
    // A bare line of user text reads as a NEW task and the model starts over,
    // losing every page it had already mined.
    const n = steerNotice(['only UK suppliers'], task)
    expect(n).toContain('only UK suppliers')
    expect(n).toMatch(/UPDATE to the task/i)
    expect(n).toContain(task)
    expect(n).toMatch(/keep every finding/i)
  })

  it('leaves room to change course when that is plainly what was asked', () => {
    expect(steerNotice(['actually, forget that — look at bread instead'], task)).toMatch(
      /unless they have plainly asked you to change course/i
    )
  })

  it('carries several in the order they were said', () => {
    const n = steerNotice(['first', 'second'], task)
    expect(n.indexOf('first')).toBeLessThan(n.indexOf('second'))
    expect(n).toContain('oldest first')
  })

  it('is empty when nothing was said, so no round pays for it', () => {
    expect(steerNotice([], task)).toBe('')
  })
})
