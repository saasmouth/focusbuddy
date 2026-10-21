// Who answers the app's zoom keys (⌘+ / ⌘- / ⌘0, View › Zoom In / Out /
// Actual Size). Normally they step the app's UI scale (lib/uiScale.ts). An
// editor with a zoomable canvas of its own -- PlexiiDraw, where ⌘0 is Fit
// Artboard in Window as in Illustrator -- claims them while it is on screen.
//
// Why this is needed: on macOS a key that matches an app-menu item can go to
// the MENU without the page ever seeing the keydown (when the web view is not
// the window's first responder), so a canvas cannot rely on catching ⌘0 itself.
// Measured with real key events (4.3.41): ⌘- shrank the whole app UI with a
// drawing open instead of zooming the drawing out.

export type ZoomDir = 'in' | 'out' | 'reset'

let handler: ((dir: ZoomDir) => boolean) | null = null

/** Claim the zoom keys; returns a function that gives them back. The handler returns true when it handled one. */
export function claimZoomCommands(fn: (dir: ZoomDir) => boolean): () => void {
  handler = fn
  return () => {
    if (handler === fn) handler = null
  }
}

/** Run a zoom command: the claiming editor's, else the app's own (`fallback`). */
export function runZoomCommand(dir: ZoomDir, fallback: (dir: ZoomDir) => void): void {
  if (handler && handler(dir)) return
  fallback(dir)
}
