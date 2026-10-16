import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fitDroppedWidget,
  DROP_VIEW_FRACTION,
  MIN_DROP_WIDTH,
  MIN_DROP_HEIGHT
} from '../../src/renderer/src/lib/fitDroppedWidget'

// "Apps when dragged to the desk should be no larger than 3/4 of the view
// width and 3/4 of the view height."
//
// The browser widget's catalogue default is 1920×1080 — chosen so sites lay
// out the way they were designed. On a laptop that lands bigger than the
// window, so the first thing you do after dropping is zoom out to find it.

const VIEW_W = 1400
const VIEW_H = 900

describe('a dropped app fits the view', () => {
  it('caps an oversized browser at three quarters of the view', () => {
    const { width, height } = fitDroppedWidget(1920, 1080, VIEW_W, VIEW_H, 1)
    expect(width).toBeLessThanOrEqual(VIEW_W * DROP_VIEW_FRACTION)
    expect(height).toBeLessThanOrEqual(VIEW_H * DROP_VIEW_FRACTION)
  })

  it('keeps the aspect ratio rather than squashing it to the window', () => {
    // Clamping each side independently would turn a 16:9 browser into
    // whatever shape the window happens to be.
    const { width, height } = fitDroppedWidget(1920, 1080, VIEW_W, VIEW_H, 1)
    expect(width / height).toBeCloseTo(1920 / 1080, 2)
  })

  it('leaves something that already fits completely alone', () => {
    // The cap is a ceiling, not a target: a sticky note must not be inflated.
    expect(fitDroppedWidget(320, 200, VIEW_W, VIEW_H, 1)).toEqual({ width: 320, height: 200 })
  })

  it('is exact at the boundary', () => {
    const w = VIEW_W * DROP_VIEW_FRACTION
    const h = VIEW_H * DROP_VIEW_FRACTION
    expect(fitDroppedWidget(w, h, VIEW_W, VIEW_H, 1)).toEqual({ width: w, height: h })
  })
})

describe('the cap means what the user SEES, so zoom counts', () => {
  it('allows a bigger widget when zoomed out', () => {
    // At 50% the visible canvas is twice as wide in canvas units, so a widget
    // may be twice as wide and still fill three quarters of the screen.
    const at100 = fitDroppedWidget(1920, 1080, VIEW_W, VIEW_H, 1)
    const at50 = fitDroppedWidget(1920, 1080, VIEW_W, VIEW_H, 0.5)
    expect(at50.width).toBeGreaterThan(at100.width)
  })

  it('and a smaller one when zoomed in', () => {
    const at100 = fitDroppedWidget(1920, 1080, VIEW_W, VIEW_H, 1)
    const at200 = fitDroppedWidget(1920, 1080, VIEW_W, VIEW_H, 2)
    expect(at200.width).toBeLessThan(at100.width)
  })

  it('at 50% zoom a 1920 browser fits untouched on this view', () => {
    // 1400 / 0.5 * 0.75 = 2100 canvas units of room, so 1920 is fine.
    expect(fitDroppedWidget(1920, 1080, VIEW_W, VIEW_H, 0.5).width).toBe(1920)
  })
})

describe('it never produces something unusable', () => {
  it('holds a floor in a very small window', () => {
    // Scaled honestly, a 1920×1080 drop into a 200×120 view would be ~16px
    // tall and show nothing. A slightly-too-big widget can be dragged; a
    // 16px one cannot be read.
    const { width, height } = fitDroppedWidget(1920, 1080, 200, 120, 1)
    expect(width).toBeGreaterThanOrEqual(MIN_DROP_WIDTH)
    expect(height).toBeGreaterThanOrEqual(MIN_DROP_HEIGHT)
  })

  it('does not collapse when the viewport has not been measured yet', () => {
    // getBoundingClientRect before layout returns zeroes; a naive cap would
    // make every drop zero-sized.
    expect(fitDroppedWidget(1920, 1080, 0, 0, 1)).toEqual({ width: 1920, height: 1080 })
  })

  it('survives a nonsense zoom', () => {
    expect(fitDroppedWidget(1920, 1080, VIEW_W, VIEW_H, 0)).toEqual({ width: 1920, height: 1080 })
    expect(fitDroppedWidget(1920, 1080, VIEW_W, VIEW_H, -1)).toEqual({ width: 1920, height: 1080 })
  })

  it('passes through a zero-sized widget rather than inventing a size', () => {
    expect(fitDroppedWidget(0, 0, VIEW_W, VIEW_H, 1)).toEqual({ width: 0, height: 0 })
  })
})

// ── Wired into every path that drops something on a desk ──────────────────

describe('every drop path applies the cap', () => {
  const canvas = readFileSync(
    join(__dirname, '..', '..', 'src/renderer/src/components/Canvas.tsx'),
    'utf8'
  )

  it('is called on all three, not just the one that was reported', () => {
    // A connected app, a dropped link and a widget-kind tile all end up as
    // the same 1920x1080 browser, so fixing one would have left two.
    expect((canvas.match(/fitDroppedWidget\(/g) ?? []).length).toBe(3)
  })

  it('measures against the live zoom, not a constant', () => {
    expect(canvas).toContain('rect.height,\n        zoom')
  })

  it('each of the three sites fits BEFORE it sizes the widget', () => {
    // Scoped to the drop handler rather than pattern-matched across the file:
    // earlier drafts of this assertion kept catching unrelated code (a table
    // created by the file importer also reads `entry?.defaultWidth ?? 560`),
    // which is noise, not a regression.
    const handler = canvas.slice(
      canvas.indexOf('const connectedAppId = e.dataTransfer.getData'),
      canvas.indexOf("const taskId = e.dataTransfer.getData('text/fb-task-link')")
    )
    expect(handler).toContain('fitDroppedWidget(')
    // Both drop branches inside it — connected app and dropped link.
    expect((handler.match(/fitDroppedWidget\(/g) ?? []).length).toBe(2)
    // and neither computes a width of its own first
    expect(handler).not.toMatch(/const width = entry\?\.defaultWidth/)
  })

  it('centres the widget on its FITTED width, not the original', () => {
    // Centring on 1920 while placing a 1000-wide widget puts it off-cursor.
    expect(canvas).toContain('cursor.x - fitted.width / 2')
  })
})
