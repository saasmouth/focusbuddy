import { describe, it, expect } from 'vitest'
import { initialMinimized, resolveCenteredTop, resolvePosition } from '../../src/renderer/src/lib/floatingChrome'
import type { MenuRect } from '../../src/renderer/src/stores/overlay'

// jsdom defaults the viewport to 1024x768.
const overlaps = (a: { left: number; top: number }, w: number, h: number, o: MenuRect): boolean =>
  a.left < o.right && a.left + w > o.left && a.top < o.bottom && a.top + h > o.top

describe('resolvePosition — anti-magnetic menu placement', () => {
  it('leaves a position that overlaps nothing untouched (aside from the 8px margin clamp)', () => {
    const p = resolvePosition(100, 100, 200, 120, [])
    expect(p).toEqual({ left: 100, top: 100 })
  })

  it('clamps an off-screen position back into the viewport', () => {
    const p = resolvePosition(5000, 5000, 200, 120, [])
    expect(p.left).toBeLessThanOrEqual(1024 - 200 - 8)
    expect(p.top).toBeLessThanOrEqual(768 - 120 - 8)
    expect(p.left).toBeGreaterThanOrEqual(8)
    expect(p.top).toBeGreaterThanOrEqual(8)
  })

  it('nudges a menu off an obstacle it would overlap', () => {
    const obstacle: MenuRect = { left: 90, top: 90, right: 290, bottom: 210 }
    const p = resolvePosition(100, 100, 200, 120, [obstacle])
    expect(overlaps(p, 200, 120, obstacle)).toBe(false)
    // still on screen
    expect(p.left).toBeGreaterThanOrEqual(8)
    expect(p.top).toBeGreaterThanOrEqual(8)
    expect(p.left + 200).toBeLessThanOrEqual(1024 - 8 + 1)
    expect(p.top + 120).toBeLessThanOrEqual(768 - 8 + 1)
  })

  it('clears two obstacles at once (settles after successive nudges)', () => {
    const a: MenuRect = { left: 0, top: 0, right: 300, bottom: 80 } // top band (breadcrumb-like)
    const b: MenuRect = { left: 0, top: 0, right: 80, bottom: 768 } // left band (sidebar-like)
    const p = resolvePosition(20, 20, 200, 120, [a, b])
    expect(overlaps(p, 200, 120, a)).toBe(false)
    expect(overlaps(p, 200, 120, b)).toBe(false)
  })
})

describe('resolveCenteredTop — vertical-only dodge for centered chrome (the pill)', () => {
  // jsdom viewport 1024 wide → a 300px pill centers at left 362.
  const W = 300
  const H = 40
  const centeredLeft = (1024 - W) / 2

  it('returns the desired top unchanged when the centered spot is clear', () => {
    expect(resolveCenteredTop(60, W, H, [])).toBe(60)
    // an obstacle away from center is ignored
    const sideMenu: MenuRect = { left: 0, top: 40, right: 200, bottom: 120 }
    expect(resolveCenteredTop(60, W, H, [sideMenu])).toBe(60)
  })

  it('pushes straight down below an obstacle overlapping the centered spot', () => {
    const wideBreadcrumb: MenuRect = { left: 100, top: 50, right: 700, bottom: 90 }
    const top = resolveCenteredTop(60, W, H, [wideBreadcrumb])
    expect(top).toBe(90 + 8) // obstacle bottom + margin
    expect(overlaps({ left: centeredLeft, top }, W, H, wideBreadcrumb)).toBe(false)
  })

  it('settles below stacked obstacles', () => {
    const a: MenuRect = { left: 100, top: 50, right: 700, bottom: 90 }
    const b: MenuRect = { left: 300, top: 95, right: 800, bottom: 140 }
    const top = resolveCenteredTop(60, W, H, [a, b])
    expect(overlaps({ left: centeredLeft, top }, W, H, a)).toBe(false)
    expect(overlaps({ left: centeredLeft, top }, W, H, b)).toBe(false)
  })

  it('clamps the desired top into the viewport', () => {
    expect(resolveCenteredTop(-100, W, H, [])).toBe(8)
    expect(resolveCenteredTop(5000, W, H, [])).toBe(768 - H - 8)
  })

  it('falls back to the clamped desired top when the whole column is blocked', () => {
    const fullColumn: MenuRect = { left: 0, top: 0, right: 1024, bottom: 768 }
    expect(resolveCenteredTop(60, W, H, [fullColumn])).toBe(60)
  })
})

// Whether a minimisable panel starts out of the way.
//
// The document side panel (outline / comments / assistant) used to start open
// on every surface, which spent a slice of the width on panels nobody had
// asked for — worst on a desk, where a document widget has least room. It
// starts minimised now, and the rule that decides it lives here.
describe('initialMinimized', () => {
  const wide = { breakpoint: 860, innerWidth: 1440 }
  const narrow = { breakpoint: 860, innerWidth: 700 }

  it('starts a defaultMinimized surface minimised on any window size', () => {
    expect(initialMinimized(null, { ...wide, defaultMinimized: true })).toBe(true)
    expect(initialMinimized(null, { ...narrow, defaultMinimized: true })).toBe(true)
  })

  it('lets what the user last chose win over the default', () => {
    // The whole point of remembering: someone who opens the panel keeps it.
    expect(initialMinimized('0', { ...wide, defaultMinimized: true })).toBe(false)
    expect(initialMinimized('1', { ...wide, defaultMinimized: false })).toBe(true)
  })

  it('still falls back to window width when no surface default is declared', () => {
    expect(initialMinimized(null, wide)).toBe(false)
    expect(initialMinimized(null, narrow)).toBe(true)
  })

  it('treats an unreadable or unrecognised stored value as no preference', () => {
    // localStorage can throw or hold junk; neither may override the default.
    expect(initialMinimized(null, { ...wide, defaultMinimized: true })).toBe(true)
    expect(initialMinimized('yes', { ...wide, defaultMinimized: true })).toBe(true)
    expect(initialMinimized('', { ...narrow, defaultMinimized: false })).toBe(false)
  })
})
