import { execFileSync } from 'child_process'
import type { ElectronApplication, Page } from '@playwright/test'

// The REAL mouse: CGEvents posted through the macOS window server, so the app
// sees exactly what a person's hand produces (the OS cursor moves; Chromium
// gets NSEvents, not CDP input). Playwright's mouse goes through CDP and takes
// a different path inside Chromium, which is how bugs about a resting pointer
// (edge-pan drift) and about hit-testing (title-bar drag regions) stay
// invisible to ordinary specs. JavaScript for Automation, no compiled helper.
//
// A spec that moves the real cursor must put it back: call cursorLocation()
// before and moveMouse() to that point after (afterAll), even on failure.

function jxa(src: string): string {
  return execFileSync('osascript', ['-l', 'JavaScript', '-e', src], { encoding: 'utf8' }).trim()
}

export interface ScreenPoint {
  x: number
  y: number
}

/** Where the OS cursor is now, in global display coordinates. */
export function cursorLocation(): ScreenPoint {
  return JSON.parse(
    jxa(`ObjC.import('CoreGraphics'); var p = $.CGEventGetLocation($.CGEventCreate(null)); JSON.stringify({ x: p.x, y: p.y })`)
  ) as ScreenPoint
}

type MouseKind = 'move' | 'down' | 'drag' | 'up'
const CG_TYPE: Record<MouseKind, string> = {
  move: '$.kCGEventMouseMoved',
  down: '$.kCGEventLeftMouseDown',
  drag: '$.kCGEventLeftMouseDragged',
  up: '$.kCGEventLeftMouseUp'
}

/** Post a sequence of left-button mouse events, `gapMs` apart, in one osascript call. */
export function postMouse(events: Array<{ kind: MouseKind; at: ScreenPoint }>, gapMs = 16): void {
  const list = JSON.stringify(events.map((e) => ({ t: e.kind, x: e.at.x, y: e.at.y })))
  jxa(`
    ObjC.import('CoreGraphics')
    var src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState)
    var T = { move: ${CG_TYPE.move}, down: ${CG_TYPE.down}, drag: ${CG_TYPE.drag}, up: ${CG_TYPE.up} }
    var evs = ${list}
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i]
      var ev = $.CGEventCreateMouseEvent(src, T[e.t], $.CGPointMake(e.x, e.y), $.kCGMouseButtonLeft)
      if (e.t === 'down' || e.t === 'up') $.CGEventSetIntegerValueField(ev, $.kCGMouseEventClickState, 1)
      $.CGEventPost($.kCGHIDEventTap, ev)
      if (i < evs.length - 1) delay(${gapMs / 1000})
    }
    'ok'
  `)
}

export function moveMouse(to: ScreenPoint): void {
  postMouse([{ kind: 'move', at: to }])
}

/** Points from a to b inclusive, `steps` segments. */
export function path(a: ScreenPoint, b: ScreenPoint, steps: number): ScreenPoint[] {
  return Array.from({ length: steps + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }))
}

/**
 * Put the app's window in front and keep it there, so real events land on it
 * and not on whatever the person has open, and return a page→screen mapper.
 * The app is zoomed (about 0.85), so page pixels are scaled by
 * contentBounds.width / innerWidth.
 */
export async function pinWindowForRealInput(
  app: ElectronApplication,
  page: Page
): Promise<(p: { x: number; y: number }) => ScreenPoint> {
  const cb = await app.evaluate(({ app: a, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.isVisible())!
    win.setAlwaysOnTop(true)
    a.focus({ steal: true })
    win.focus()
    return win.getContentBounds()
  })
  const innerWidth = await page.evaluate(() => window.innerWidth)
  const scale = cb.width / innerWidth
  return (p) => ({ x: cb.x + p.x * scale, y: cb.y + p.y * scale })
}

export async function unpinWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.setAlwaysOnTop(false)
  })
}

/** A real right-click (secondary button down and up) at a screen point. */
export function postRightClick(at: ScreenPoint): void {
  jxa(`
    ObjC.import('CoreGraphics')
    var src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState)
    var p = $.CGPointMake(${at.x}, ${at.y})
    var mv = $.CGEventCreateMouseEvent(src, $.kCGEventMouseMoved, p, $.kCGMouseButtonRight)
    $.CGEventPost($.kCGHIDEventTap, mv)
    delay(0.05)
    var d = $.CGEventCreateMouseEvent(src, $.kCGEventRightMouseDown, p, $.kCGMouseButtonRight)
    $.CGEventSetIntegerValueField(d, $.kCGMouseEventClickState, 1)
    $.CGEventPost($.kCGHIDEventTap, d)
    delay(0.03)
    var u = $.CGEventCreateMouseEvent(src, $.kCGEventRightMouseUp, p, $.kCGMouseButtonRight)
    $.CGEventSetIntegerValueField(u, $.kCGMouseEventClickState, 1)
    $.CGEventPost($.kCGHIDEventTap, u)
    'ok'
  `)
}
