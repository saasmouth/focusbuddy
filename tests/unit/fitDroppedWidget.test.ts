import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fitDroppedWidget,
  fitNewWidgetToView,
  setCanvasViewport,
  canvasViewport,
  DROP_VIEW_FRACTION,
  MIN_DROP_WIDTH,
  MIN_DROP_HEIGHT
} from '../../src/renderer/src/lib/fitDroppedWidget'

const ROOT = join(__dirname, '..', '..', 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

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

// ── One central cap, which nothing can bypass ────────────────────────────
//
// "They all need to work consistently… this should apply for browsers, apps,
// connected apps and anything else opened via shortcut, dragging or through a
// menu add."
//
// The first attempt capped three drop sites in Canvas. That was the wrong
// shape: 53 call sites across 14 files read a catalogue default, so a
// shortcut or a menu add still opened at 1920x1080. The cap now lives in the
// widget store's create — the single funnel every path goes through.

describe('the cap is applied centrally, not per call site', () => {
  const store = read('renderer/src/stores/widgets.ts')
  const canvas = read('renderer/src/components/Canvas.tsx')

  it('lives in the one function every creation path goes through', () => {
    expect(store).toContain('fitNewWidgetToView(draft,')
    expect(store).toContain('window.api.widgets.create(sized)')
  })

  it('and NOT re-applied at individual drop sites', () => {
    // Belt-and-braces here would be two places to keep in step, and the
    // per-site version is what let shortcuts and menu adds through.
    expect(canvas).not.toContain('fitDroppedWidget(')
  })

  it('Canvas publishes the viewport instead of passing it around', () => {
    expect(canvas).toContain('setCanvasViewport(r.width, r.height, zoom)')
    expect(canvas).toContain('new ResizeObserver(publish)')
  })

  it('re-publishes when the zoom changes', () => {
    // The cap is expressed in what the user sees, so a stale zoom caps wrong.
    expect(canvas).toMatch(/ro\.disconnect\(\)\s*\n\s*\}, \[zoom\]\)/)
  })
})

describe('only an untouched default is fitted', () => {
  const defaults = (kind: string): { width: number; height: number } | null =>
    kind === 'webview' ? { width: 1920, height: 1080 } : null

  it('shrinks a widget opening at its catalogue default', () => {
    setCanvasViewport(1400, 900, 1)
    const out = fitNewWidgetToView({ kind: 'webview', width: 1920, height: 1080, x: 0 }, defaults)
    expect(out.width).toBeLessThan(1920)
  })

  it('leaves a DELIBERATE size alone — a duplicate or a template', () => {
    // The distinction that makes one central cap safe: a size that is not the
    // default came from somebody choosing it.
    setCanvasViewport(1400, 900, 1)
    const out = fitNewWidgetToView({ kind: 'webview', width: 1600, height: 900, x: 0 }, defaults)
    expect(out).toEqual({ kind: 'webview', width: 1600, height: 900, x: 0 })
  })

  it('leaves a kind with no catalogue entry alone', () => {
    setCanvasViewport(1400, 900, 1)
    const d = { kind: 'mystery', width: 5000, height: 5000, x: 0 }
    expect(fitNewWidgetToView(d, defaults)).toEqual(d)
  })

  it('keeps the intended centre when it shrinks', () => {
    // Shrinking without shifting x lands the widget off the cursor.
    setCanvasViewport(1400, 900, 1)
    const out = fitNewWidgetToView({ kind: 'webview', width: 1920, height: 1080, x: 0 }, defaults)
    expect(out.x).toBeGreaterThan(0)
    expect(out.x).toBe(Math.round((1920 - out.width!) / 2))
  })
})

describe('the viewport falls back rather than failing open', () => {
  it('uses the window when the canvas has never been measured', () => {
    // A shortcut can create a widget from another surface entirely. "No
    // canvas on screen" must not mean "no cap".
    setCanvasViewport(0, 0, 1)
    const v = canvasViewport()
    expect(v.width).toBeGreaterThan(0)
  })
})
