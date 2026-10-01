// @vitest-environment node
//
// Driving the camera with the arrow keys and swipes.
//
// All the awkwardness of this feature is in two questions -- which widget is
// "to the right of" this one, and how far to zoom when you get there -- and both
// are pure arithmetic. Testing them here means the Canvas wiring is left with
// nothing but plumbing, and a disagreement about where a widget is cannot hide
// behind a camera animation.

import { describe, expect, it } from 'vitest'
import {
  NAV_ZOOM_MAX_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  navCamera,
  navigableWidgets,
  nearestToPoint,
  nextInDirection,
  viewportCentreInCanvas,
  widgetBox,
  type Viewport
} from '../../src/renderer/src/lib/deskCameraNav'
import type { Widget } from '../../src/shared/types'

let seq = 0
function w(partial: Partial<Widget> & { id: string; x: number; y: number }): Widget {
  return {
    taskId: 't',
    kind: 'sticky',
    title: '',
    content: '',
    width: 240,
    height: 200,
    zIndex: 1,
    color: null,
    pinned: false,
    pinnedScreenX: null,
    pinnedScreenY: null,
    pinnedZone: null,
    parentSectionId: null,
    layout: null,
    sourceAppId: null,
    mode: null,
    livingQuery: null,
    livingGeneratedAt: null,
    livingPaused: false,
    syncGroupId: null,
    archived: false,
    createdAt: ++seq,
    updatedAt: seq,
    ...partial
  } as Widget
}

const VP: Viewport = { width: 1400, height: 900, dockInset: 200 }

describe('navigableWidgets', () => {
  it('stops at the same widgets focus mode walks', () => {
    // Shared predicate on purpose: if the arrow keys and the focus dock disagreed
    // about what is navigable, pressing -> would skip a widget the dock shows.
    const all = [
      w({ id: 'plain', x: 0, y: 0 }),
      w({ id: 'archived', x: 10, y: 0, archived: true }),
      w({ id: 'pinned', x: 20, y: 0, pinned: true }),
      w({ id: 'section', x: 30, y: 0, kind: 'section' }),
      w({ id: 'child', x: 40, y: 0, parentSectionId: 'section' })
    ]
    expect(navigableWidgets(all).map((x) => x.id)).toEqual(['plain', 'child'])
  })
})

describe('widgetBox', () => {
  it('translates a section child into canvas space', () => {
    // A child stores x/y relative to its section. Untranslated it would appear to
    // sit at the desk origin, and the camera would fly to empty canvas.
    const section = w({ id: 's', x: 1000, y: 500, kind: 'section' })
    const child = w({ id: 'c', x: 10, y: 20, parentSectionId: 's' })
    const byId = new Map([section, child].map((x) => [x.id, x]))
    const box = widgetBox(child, byId)
    expect(box.x).toBeGreaterThan(1000)
    expect(box.y).toBeGreaterThan(500)
  })

  it('never reports a zero-sized box', () => {
    // A zero width would make the fit division infinite and the camera jump to a
    // nonsense zoom.
    const byId = new Map<string, Widget>()
    const box = widgetBox(w({ id: 'z', x: 0, y: 0, width: 0, height: 0 }), byId)
    expect(box.w).toBeGreaterThan(0)
    expect(box.h).toBeGreaterThan(0)
  })
})

describe('nextInDirection', () => {
  // b is straight to the right of a but far; c is close but well above the row.
  const a = w({ id: 'a', x: 0, y: 0 })
  const b = w({ id: 'b', x: 900, y: 0 })
  const c = w({ id: 'c', x: 300, y: -700 })
  const grid = [a, b, c]

  it('prefers the widget straight ahead over a closer one off to the side', () => {
    // The whole point of the perpendicular penalty. Without it, -> would fly off
    // diagonally to whatever happened to be nearest, which feels random.
    expect(nextInDirection(grid, 'a', 'right')?.id).toBe('b')
  })

  it('still reaches an off-axis widget in the direction it actually lies', () => {
    expect(nextInDirection(grid, 'a', 'up')?.id).toBe('c')
  })

  it('does nothing at the edge of the desk rather than wrapping', () => {
    // Wrapping to the far side is indistinguishable from the camera losing its
    // place, and on a desk the position of a thing is information.
    expect(nextInDirection(grid, 'b', 'right')).toBeNull()
    expect(nextInDirection(grid, 'a', 'left')).toBeNull()
  })

  it('is symmetric for a simple pair', () => {
    const pair = [a, b]
    expect(nextInDirection(pair, 'a', 'right')?.id).toBe('b')
    expect(nextInDirection(pair, 'b', 'left')?.id).toBe('a')
  })

  it('treats a widget at the same centre as not being to either side', () => {
    const twin = w({ id: 'twin', x: 0, y: 0 })
    const stacked = [a, twin]
    for (const dir of ['left', 'right', 'up', 'down'] as const) {
      expect(nextInDirection(stacked, 'a', dir), dir).toBeNull()
    }
  })

  it('returns null when the anchor is unknown, missing or not navigable', () => {
    expect(nextInDirection(grid, null, 'right')).toBeNull()
    expect(nextInDirection(grid, 'nope', 'right')).toBeNull()
    const pinned = w({ id: 'p', x: 0, y: 0, pinned: true })
    expect(nextInDirection([pinned, b], 'p', 'right')).toBeNull()
  })

  it('skips widgets that are not navigable', () => {
    const hidden = w({ id: 'hidden', x: 300, y: 0, archived: true })
    expect(nextInDirection([a, hidden, b], 'a', 'right')?.id).toBe('b')
  })

  it('walks a row one widget at a time', () => {
    const row = [
      w({ id: 'r1', x: 0, y: 0 }),
      w({ id: 'r2', x: 300, y: 0 }),
      w({ id: 'r3', x: 600, y: 0 })
    ]
    expect(nextInDirection(row, 'r1', 'right')?.id).toBe('r2')
    expect(nextInDirection(row, 'r2', 'right')?.id).toBe('r3')
    expect(nextInDirection(row, 'r3', 'left')?.id).toBe('r2')
  })

  it('resolves an exact tie deterministically', () => {
    // Two candidates mirrored above and below the axis score identically. Without
    // a stable tiebreak the same key would go different ways across reloads.
    const up = w({ id: 'up', x: 400, y: -200 })
    const down = w({ id: 'down', x: 400, y: 200 })
    const first = nextInDirection([a, up, down], 'a', 'right')?.id
    const again = nextInDirection([a, down, up], 'a', 'right')?.id
    expect(first).toBe(again)
  })
})

describe('navCamera', () => {
  const box = { x: 1000, y: 500, w: 380, h: 420 }

  it('puts the widget in the middle of the visible canvas', () => {
    // Round-tripped through the inverse rather than asserting pan numbers: this
    // is the property that actually matters, and it catches a dockInset error
    // that eyeballing the arithmetic would not.
    const cam = navCamera(box, VP)
    const centre = viewportCentreInCanvas(cam, VP)
    expect(centre.x).toBeCloseTo(box.x + box.w / 2, 6)
    expect(centre.y).toBeCloseTo(box.y + box.h / 2, 6)
  })

  it('accounts for the dock, so the widget does not land underneath it', () => {
    // The specific bug this guards: forget the inset and the camera centres the
    // widget on the whole window, putting it half behind the dock column.
    const withDock = navCamera(box, VP)
    const withoutDock = navCamera(box, { ...VP, dockInset: 0 })
    expect(withDock.panX).not.toBeCloseTo(withoutDock.panX, 3)
    const centre = viewportCentreInCanvas(withDock, VP)
    expect(centre.x).toBeCloseTo(box.x + box.w / 2, 6)
  })

  it('does not magnify a small widget past the cap', () => {
    // "Usable", not "takeover". A widget's layout is designed for its own pixel
    // size, and filling the viewport with it is just focus mode again.
    const small = { x: 0, y: 0, w: 200, h: 160 }
    expect(navCamera(small, VP).zoom).toBeCloseTo(NAV_ZOOM_MAX_DEFAULT, 6)
  })

  it('honours a caller-supplied magnification cap', () => {
    const small = { x: 0, y: 0, w: 200, h: 160 }
    expect(navCamera(small, VP, { maxMagnify: 1 }).zoom).toBeCloseTo(1, 6)
  })

  it('zooms OUT for a widget bigger than the viewport', () => {
    // Framing a 2400px-wide widget at 100% hides its own right-hand edge, which
    // on several widgets here is where the controls are.
    const huge = { x: 0, y: 0, w: 2400, h: 1800 }
    const cam = navCamera(huge, VP)
    expect(cam.zoom).toBeLessThan(1)
    // And it genuinely fits, padding included.
    expect(huge.w * cam.zoom).toBeLessThanOrEqual(VP.width - VP.dockInset)
    expect(huge.h * cam.zoom).toBeLessThanOrEqual(VP.height)
  })

  it('never leaves the canvas zoom range', () => {
    const absurd = { x: 0, y: 0, w: 100_000, h: 100_000 }
    expect(navCamera(absurd, VP).zoom).toBe(ZOOM_MIN)
    const speck = { x: 0, y: 0, w: 1, h: 1 }
    expect(navCamera(speck, VP, { maxMagnify: 99 }).zoom).toBe(ZOOM_MAX)
  })

  it('uses the whole of a viewport too small to pad', () => {
    // A window narrower than the padding would otherwise be handed a NEGATIVE
    // available width, and the resulting negative zoom only avoids rendering the
    // desk inside out because the clamp catches it -- landing on the 0.25 floor
    // and showing the widget far smaller than it needed to be.
    //
    // So this asserts the widget actually fills the narrow viewport, not merely
    // that the zoom came out positive. The first version of this test checked
    // only the latter and passed with the guard removed, which is no test at all.
    const tiny: Viewport = { width: 120, height: 100, dockInset: 0 }
    const box = { x: 0, y: 0, w: 300, h: 200 }
    const cam = navCamera(box, tiny)

    expect(cam.zoom).toBeGreaterThan(ZOOM_MIN)
    expect(box.w * cam.zoom).toBeLessThanOrEqual(tiny.width + 1e-9)
    expect(box.w * cam.zoom).toBeGreaterThan(tiny.width * 0.9)

    const centre = viewportCentreInCanvas(cam, tiny)
    expect(centre.x).toBeCloseTo(box.x + box.w / 2, 6)
    expect(centre.y).toBeCloseTo(box.y + box.h / 2, 6)
  })
})

describe('nearestToPoint', () => {
  it('finds the widget the camera is currently looking at', () => {
    // Used to decide where an arrow press starts from when nothing is selected:
    // whatever is in the middle of the screen is where the user thinks they are.
    const near = w({ id: 'near', x: 1000, y: 1000 })
    const far = w({ id: 'far', x: 5000, y: 5000 })
    expect(nearestToPoint([near, far], { x: 1100, y: 1100 })?.id).toBe('near')
  })

  it('returns null on an empty desk', () => {
    expect(nearestToPoint([], { x: 0, y: 0 })).toBeNull()
    expect(nearestToPoint([w({ id: 'p', x: 0, y: 0, pinned: true })], { x: 0, y: 0 })).toBeNull()
  })
})
