// The trackpad swipe that was eating mouse scrolling.
//
// The thresholds were tuned on a trackpad, where a flick ramps up through many
// small deltas. A mouse wheel clears every one of them on contact: a single
// notch is ~100px in one event with deltaX exactly 0, so the peak test passed
// immediately, the axis test passed trivially, and three notches met the
// distance test. Ordinary scrolling jumped to another widget, and the cooldown
// then swallowed every wheel event for 420ms — which is why smooth scrolling
// stopped too.
//
// These tests drive the decision with event streams shaped like each device,
// because that is the distinction the code has to make.
import { describe, expect, it } from 'vitest'
import {
  freshSwipe,
  isMouseWheel,
  swipeStep,
  SWIPE_COOLDOWN_MS,
  type CameraDir,
  type WheelSample
} from '../../src/renderer/src/lib/deskCameraNav'

const wheelNotch = (dy = 100): WheelSample => ({ deltaX: 0, deltaY: dy, deltaMode: 0 })
const wheelLines = (dy = 3): WheelSample => ({ deltaX: 0, deltaY: dy, deltaMode: 1 })
/** A trackpad carries cross-axis movement from the hand and ramps up. */
const padFlick = (dy: number): WheelSample => ({ deltaX: dy * 0.08, deltaY: dy, deltaMode: 0 })

const always = (): boolean => true
const never = (): boolean => false

/** Run a stream and report every step it produced. */
function run(
  events: WheelSample[],
  opts: { startAt?: number; gapMs?: number; canStep?: (d: CameraDir) => boolean } = {}
): { steps: CameraDir[]; consumed: number } {
  const s = freshSwipe()
  const gap = opts.gapMs ?? 16
  let t = opts.startAt ?? 1000
  const steps: CameraDir[] = []
  let consumed = 0
  for (const e of events) {
    const d = swipeStep(s, e, t, opts.canStep ?? always)
    if (d.dir) steps.push(d.dir)
    if (d.consume) consumed++
    t += gap
  }
  return { steps, consumed }
}

describe('isMouseWheel', () => {
  it('recognises a pixel-mode wheel notch', () => {
    expect(isMouseWheel(wheelNotch(100))).toBe(true)
    expect(isMouseWheel(wheelNotch(-120))).toBe(true)
  })

  it('recognises line and page modes, whatever the delta', () => {
    expect(isMouseWheel(wheelLines(3))).toBe(true)
    expect(isMouseWheel({ deltaX: 0, deltaY: 1, deltaMode: 2 })).toBe(true)
  })

  it('does not mistake a trackpad for a wheel', () => {
    expect(isMouseWheel(padFlick(8))).toBe(false)
    expect(isMouseWheel(padFlick(60))).toBe(false)
    // Even a hard flick, because the hand carries it off-axis.
    expect(isMouseWheel(padFlick(140))).toBe(false)
  })
})

describe('swipeStep', () => {
  it('never steps on a mouse wheel, however long the scroll', () => {
    // Twenty notches: 2000px, far past every threshold the old code used.
    const { steps, consumed } = run(Array.from({ length: 20 }, () => wheelNotch(100)))
    expect(steps).toEqual([])
    // And nothing is swallowed — the scroll must reach the camera intact.
    expect(consumed).toBe(0)
  })

  it('never steps on a line-mode wheel either', () => {
    const { steps, consumed } = run(Array.from({ length: 20 }, () => wheelLines(3)))
    expect(steps).toEqual([])
    expect(consumed).toBe(0)
  })

  it('still steps on a deliberate trackpad flick', () => {
    // A flick: ramps up, well past 160px total, dominantly vertical.
    const { steps } = run([padFlick(30), padFlick(55), padFlick(70), padFlick(40)])
    expect(steps).toEqual(['down'])
  })

  it('leaves a gentle trackpad pan alone', () => {
    // Same total distance, but no event is fast enough to be a flick.
    const { steps, consumed } = run(Array.from({ length: 40 }, () => padFlick(8)))
    expect(steps).toEqual([])
    expect(consumed).toBe(0)
  })

  it('leaves a diagonal trackpad gesture alone', () => {
    const diag = (n: number): WheelSample => ({ deltaX: n, deltaY: n, deltaMode: 0 })
    const { steps } = run([diag(40), diag(60), diag(70)])
    expect(steps).toEqual([])
  })

  it('reads direction from the dominant axis', () => {
    expect(run([padFlick(-40), padFlick(-70), padFlick(-80)]).steps).toEqual(['up'])
    const right = (n: number): WheelSample => ({ deltaX: n, deltaY: n * 0.08, deltaMode: 0 })
    expect(run([right(40), right(70), right(80)]).steps).toEqual(['right'])
  })

  it('does not start the cooldown when there is nowhere to step', () => {
    // The edge of the desk. Swallowing 420ms here would freeze the camera for
    // a gesture that did nothing at all.
    const { steps, consumed } = run([padFlick(60), padFlick(70), padFlick(80)], { canStep: never })
    expect(steps).toEqual([])
    expect(consumed).toBe(0)
  })

  it('swallows the tail of the flick that moved it, then recovers', () => {
    const s = freshSwipe()
    let t = 1000
    const push = (e: WheelSample): ReturnType<typeof swipeStep> => {
      const d = swipeStep(s, e, t, always)
      t += 16
      return d
    }
    push(padFlick(40))
    push(padFlick(70))
    expect(push(padFlick(80)).dir).toBe('down')
    // Tail of the same gesture: consumed so it cannot pan off the new widget.
    expect(push(padFlick(30)).consume).toBe(true)
    expect(push(padFlick(20)).dir).toBe(null)
    // After the cooldown, the trackpad works again.
    t += SWIPE_COOLDOWN_MS
    expect(push(padFlick(40)).consume).toBe(false)
  })

  it('a wheel scroll is unaffected by a cooldown a trackpad started', () => {
    // Mixed input (trackpad then mouse) must not leave the wheel dead.
    const s = freshSwipe()
    let t = 1000
    for (const e of [padFlick(40), padFlick(70), padFlick(80)]) {
      swipeStep(s, e, t, always)
      t += 16
    }
    const d = swipeStep(s, wheelNotch(100), t + 10, always)
    expect(d.consume).toBe(false)
    expect(d.dir).toBe(null)
  })
})
