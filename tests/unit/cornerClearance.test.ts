// How far a bottom-right overlay must rise to stop eating the corner.
//
// The feature-spotlight card docked at bottom-5 right-5, z-[230], on top of the
// desk's three corner controls, and because it is not modal a press on the
// minimap did nothing at all — no panel, no feedback, nothing to explain it.
// The arithmetic that lifts it is here, separate from the measuring, because
// the cases that matter are the ones a running app rarely shows: a hidden
// control reporting an empty rect, a control beside rather than under the card,
// the minimap panel open and taller than its toggle.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { liftOverCornerChrome, type Box } from '@renderer/components/onboarding/cornerClearance'

/** An 800px-tall window, the card 340 wide resting 20px off the bottom-right. */
const WIN_H = 800
const card: Box = { left: 440, right: 780, top: 0, bottom: WIN_H - 20 } // bottom 780
const GAP = 12

/** A control, by its distance from the window's bottom and its size. */
function control(fromBottom: number, height: number, left = 700, right = 740): Box {
  return { left, right, top: WIN_H - fromBottom - height, bottom: WIN_H - fromBottom }
}

describe('what the overlay has to clear', () => {
  it('rises above a control it covers, by the control plus a gap', () => {
    // The minimap toggle: 32px tall, 12px off the canvas bottom (~40 off the
    // window's, with the footer). Top edge at 800-40-32 = 728.
    const toggle = control(40, 32)
    expect(liftOverCornerChrome(card, [toggle])).toBe(card.bottom - toggle.top + GAP)
    // Stated concretely, so the arithmetic is readable: 780 - 728 + 12.
    expect(liftOverCornerChrome(card, [toggle])).toBe(64)
  })

  it('takes the WORST of several, not the last or the first', () => {
    const toggle = control(40, 32) // top 728
    const pill = control(42, 52) // top 706
    const automations = control(104, 32) // top 664 — the tallest reach
    const lift = liftOverCornerChrome(card, [toggle, pill, automations])
    expect(lift).toBe(card.bottom - 664 + GAP)
    // Order must not change the answer.
    expect(liftOverCornerChrome(card, [automations, pill, toggle])).toBe(lift)
  })

  it('clears the minimap PANEL when it is open, which is taller than the toggle', () => {
    // The panel is 100px tall and lives inside the same container as the
    // toggle, so the container's rect grows when it opens — which is why the
    // observer watches the chrome and not only the card.
    const closed = control(40, 32)
    const open = control(40, 100)
    expect(liftOverCornerChrome(card, [open])).toBeGreaterThan(liftOverCornerChrome(card, [closed]))
    expect(liftOverCornerChrome(card, [open])).toBe(card.bottom - (WIN_H - 140) + GAP)
  })

  it('lifts for nothing when the corner is empty', () => {
    expect(liftOverCornerChrome(card, [])).toBe(0)
  })
})

describe('what it must NOT rise for', () => {
  it('ignores a control beside it, not under it', () => {
    // Bottom-LEFT chrome: the zoom pill lives there, and lifting the card for
    // it would move the card for no reason at all.
    const zoomPill = control(12, 28, 12, 120)
    expect(liftOverCornerChrome(card, [zoomPill])).toBe(0)
  })

  it('ignores a control that is already below the card', () => {
    const below: Box = { left: 700, right: 740, top: 790, bottom: 798 }
    expect(liftOverCornerChrome(card, [below])).toBe(0)
  })

  it('ignores an EMPTY rect, which is what hidden chrome reports', () => {
    // THE ONE THAT WOULD HAVE HURT. A hidden element reports 0,0,0,0, and
    // treating that as a control at the window's top-left would lift the card
    // by the full window height — the card would leave the screen, which looks
    // exactly like the card being broken rather than the maths.
    const hidden: Box = { left: 0, right: 0, top: 0, bottom: 0 }
    expect(liftOverCornerChrome(card, [hidden])).toBe(0)
    // Mixed with a real one, the real one still decides.
    const toggle = control(40, 32)
    expect(liftOverCornerChrome(card, [hidden, toggle])).toBe(liftOverCornerChrome(card, [toggle]))
  })

  it('ignores a rect that is inverted or degenerate', () => {
    expect(liftOverCornerChrome(card, [{ left: 740, right: 700, top: 700, bottom: 760 }])).toBe(0)
    expect(liftOverCornerChrome(card, [{ left: 700, right: 740, top: 760, bottom: 700 }])).toBe(0)
  })
})

describe('the result is usable as a CSS length', () => {
  it('is a whole number of pixels, rounded up so it never falls short', () => {
    const fractional: Box = { left: 700, right: 740, top: 727.4, bottom: 759.4 }
    const lift = liftOverCornerChrome(card, [fractional])
    expect(Number.isInteger(lift)).toBe(true)
    expect(lift).toBeGreaterThanOrEqual(card.bottom - fractional.top + GAP)
  })
})

describe('and the card actually uses it', () => {
  // The running proof is _realClickSpotlightCorner, which presses the minimap
  // by CGEvents with the card showing — but that is an underscore sweep, so
  // `npm run test:e2e` never runs it. Without this, the suite would still be
  // green with the lift computed and thrown away, which is the state the card
  // was in for every release before this one.
  const src = readFileSync('src/renderer/src/components/onboarding/FeatureSpotlightPopup.tsx', 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('reads the card source at all, or the assertions below are empty', () => {
    expect(code.length).toBeGreaterThan(500)
    expect(code, 'this is the right file').toContain('feature-spotlight-popup')
  })

  it('calls the lift and spends it on its own bottom edge', () => {
    expect(code).toMatch(/useCornerChromeLift\(/)
    expect(code, 'the lift must reach the style, not just be computed').toMatch(
      /bottom:\s*BASE_BOTTOM_PX\s*\+\s*lift/
    )
  })

  it('no longer pins itself to the corner with a class', () => {
    // `bottom-5` as a Tailwind class cannot be added to, and an inline style
    // beside it would silently win — leaving two sources of truth for where
    // the card sits.
    expect(code, 'bottom-5 is the BASE constant now, not a class').not.toMatch(/\bbottom-5\b/)
  })
})
