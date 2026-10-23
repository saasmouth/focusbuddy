// rails-tabs-41 shots, Diagrams-home.png: the PlexiiAssist pill, fixed to the
// window's bottom-right corner, sat over the minimap's bottom-right corner, so
// a press there opened the assistant instead of panning the diagram. The
// minimap rises exactly enough to clear the pill, and not at all otherwise.
// Boxes are the shot's layout in client px (window 1400 wide at 0.85 zoom).

import { describe, expect, it } from 'vitest'
import { liftOverPill } from '../../src/renderer/src/components/documents/diagram/pillClearance'

const canvas = { left: 230, right: 1378, top: 140, bottom: 834 }
const mini = { left: 1163, right: 1363 } // 200 wide, 15 in from the canvas edge
const pillAt = (left: number, top: number): { left: number; right: number; top: number; bottom: number } => ({ left, right: left + 52, top, bottom: top + 52 })

describe('the minimap clears the PlexiiAssist pill', () => {
  it('the shot: the pill overlaps the minimap corner, so the minimap rises above it', () => {
    const pill = pillAt(1334, 790)
    const lift = liftOverPill(canvas, pill, mini, 15)
    const miniBottomAfter = canvas.bottom - 15 - lift
    expect(lift).toBeGreaterThan(0)
    expect(miniBottomAfter).toBeLessThanOrEqual(pill.top - 12)
  })

  it('no pill, a hidden pill, or a pill beside the minimap: no lift', () => {
    expect(liftOverPill(canvas, null, mini, 15)).toBe(0)
    expect(liftOverPill(canvas, { left: 0, right: 0, top: 0, bottom: 0 }, mini, 15)).toBe(0)
    expect(liftOverPill(canvas, pillAt(1100, 790), mini, 15)).toBe(0) // 1152 < 1163: beside, not over
  })

  it('a pill below the canvas (the tray pushed it down past it): no lift', () => {
    expect(liftOverPill(canvas, pillAt(1334, 830), mini, 15)).toBe(0)
  })

  it('no minimap on screen: no lift', () => {
    expect(liftOverPill(canvas, pillAt(1334, 790), null, 15)).toBe(0)
  })
})
