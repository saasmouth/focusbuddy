// The minimap at the edges of the mapped area.
//
// Both defects here were reported as "the minimap moves when scrolling past
// certain points". The points were the edges of the content: the map covered
// the objects and nothing else, so the camera leaving them had nowhere to be
// drawn, and the indicator was clamped in a way that lied on one side and
// disappeared on the other.
import { describe, it, expect } from 'vitest'
import {
  cameraBox, mappedBox, mappedScale, viewportIndicator,
  type Box, type MinimapCamera, type Panel
} from '../../src/renderer/src/lib/minimapGeometry'

const PANEL: Panel = { width: 160, height: 100, padding: 5 }
// A large desk: objects over 3000x2000, seen through a 1400x900 surface.
const CONTENT: Box = { minX: 0, minY: 0, maxX: 3000, maxY: 2000 }
const camAt = (worldX: number, worldY = 0, zoom = 1): MinimapCamera => ({
  panX: -worldX * zoom, panY: -worldY * zoom, zoom,
  viewportWidth: 1400, viewportHeight: 900
})

describe('minimap geometry', () => {
  it('holds still while the camera is over the desk', () => {
    // The scale must not change as you pan across the content, or every object
    // slides under the cursor while you are trying to read the map.
    const scales = [0, 500, 1000, 1500, 2000].map((x) =>
      mappedScale(mappedBox(CONTENT, camAt(x, 400)), PANEL)
    )
    for (const s of scales) expect(s).toBeCloseTo(scales[0], 10)
  })

  it('always has somewhere to draw the camera, however far out it is', () => {
    // The old box was the content alone, so this returned a rect outside the
    // panel -- or, once the arithmetic went negative, nothing at all.
    for (const x of [-8000, -4700, -1200, 0, 3000, 4700, 9000, 40000]) {
      const cam = camAt(x, 0)
      const box = mappedBox(CONTENT, cam)
      const rect = viewportIndicator(box, cam, mappedScale(box, PANEL), PANEL)
      expect(rect, `no indicator at world x=${x}`).not.toBeNull()
      expect(rect!.w, `non-positive width at world x=${x}`).toBeGreaterThan(0)
      expect(rect!.h, `non-positive height at world x=${x}`).toBeGreaterThan(0)
    }
  })

  it('keeps the indicator inside the panel', () => {
    for (const x of [-9000, -2000, 0, 2500, 6000, 30000]) {
      for (const y of [-5000, 0, 1200, 8000]) {
        const cam = camAt(x, y)
        const box = mappedBox(CONTENT, cam)
        const r = viewportIndicator(box, cam, mappedScale(box, PANEL), PANEL)!
        expect(r.x).toBeGreaterThanOrEqual(0)
        expect(r.y).toBeGreaterThanOrEqual(0)
        expect(r.x + r.w).toBeLessThanOrEqual(PANEL.width + 1e-9)
        expect(r.y + r.h).toBeLessThanOrEqual(PANEL.height + 1e-9)
      }
    }
  })

  it('draws exactly the overlap, not the whole camera pinned to the edge', () => {
    // Checked against a content-only box, so the clamp is exercised directly
    // rather than through mappedBox (which now keeps the camera inside).
    // The old code clamped x to 0 but kept the full width: off to the left it
    // drew the entire viewport from the panel's edge, claiming five times the
    // ground it could actually see.
    const padded: Box = { minX: -700, minY: -450, maxX: 3700, maxY: 2450 }
    const scale = mappedScale(padded, PANEL)
    for (const x of [-2000, -1200, -800, 4200, 4600]) {
      const cam = camAt(x, 0)
      const cb = cameraBox(cam)
      const r = viewportIndicator(padded, cam, scale, PANEL)
      // The exact intersection of the projected camera with the panel.
      const px = PANEL.padding + (cb.minX - padded.minX) * scale
      const pw = (cb.maxX - cb.minX) * scale
      const x0 = Math.max(0, px)
      const x1 = Math.min(PANEL.width, px + pw)
      if (x1 - x0 <= 0) {
        expect(r, `expected nothing drawn at world x=${x}`).toBeNull()
        continue
      }
      expect(r, `expected an indicator at world x=${x}`).not.toBeNull()
      expect(r!.x).toBeCloseTo(x0, 9)
      expect(r!.w).toBeCloseTo(x1 - x0, 9)
    }
  })

  it('moves the indicator monotonically as the camera moves', () => {
    // Whatever else it does, panning right must never move the marker left.
    let prev = -Infinity
    for (let x = -6000; x <= 9000; x += 250) {
      const cam = camAt(x, 0)
      const box = mappedBox(CONTENT, cam)
      const r = viewportIndicator(box, cam, mappedScale(box, PANEL), PANEL)!
      const centre = r.x + r.w / 2
      expect(centre).toBeGreaterThanOrEqual(prev - 1e-6)
      prev = centre
    }
  })

  it('maps an empty desk to nothing rather than guessing', () => {
    expect(mappedBox(null, camAt(0))).toBeNull()
    expect(viewportIndicator(null, camAt(0), 1, PANEL)).toBeNull()
  })
})
