// BACKGROUND e2e (owner, 2026-11-05: "Is there a way you can test without it
// taking over my screen and mouse and keyboard?"). Loaded with `-r` ahead of
// the app by _netGuard.ts (launchGuarded) unless PLEXII_E2E_VISIBLE=1 or
// PLEXII_REAL_INPUT=1. Test code only: the app ships nothing of this.
//
// What it does, in the app's MAIN process:
//  - macOS: the app runs as an ACCESSORY app (no Dock icon, never frontmost),
//    so it can never take the keyboard or come in front of what the owner is
//    using.
//  - Windows are never shown or focused: show / showInactive / focus /
//    moveTop / app.focus are no-ops. A window still exists, lays out and
//    paints; the page runs as if it were visible.
//  - Background throttling is off for every web contents (the app window, its
//    desk web pages, pop-ups), so timers, requestAnimationFrame and the page
//    visibility state behave as for a visible window. (The desk's web layer
//    lays pages out every frame; a throttled hidden window would stall it.)
//  - The app's own windows emulate focus (CDP Emulation.setFocusEmulationEnabled,
//    as Playwright does for headless pages): document.hasFocus() is true and
//    focus/blur events fire, so keyboard specs work without the OS focus.
//
// Playwright input already goes through CDP and never touches the real pointer
// or keyboard. Specs that must drive the real OS input (CGEvents, _macMouse)
// are opt-in (PLEXII_REAL_INPUT=1) and run visible.
'use strict'
const { app, BrowserWindow } = require('electron')

if (process.platform === 'darwin') {
  try {
    app.setActivationPolicy('accessory')
  } catch {
    /* older Electron: the dock hide below still keeps it out of the way */
  }
  app.whenReady().then(() => {
    try {
      app.dock && app.dock.hide()
    } catch {
      /* no dock */
    }
  })
}

const noop = function () {}
for (const m of ['show', 'showInactive', 'focus', 'moveTop', 'restore', 'maximize', 'setFullScreen', 'setSimpleFullScreen']) {
  if (typeof BrowserWindow.prototype[m] === 'function') BrowserWindow.prototype[m] = noop
}
app.focus = noop
if (app.show) app.show = noop

// isVisible() would now always be false: specs and app code that ask "is the
// window up?" get the answer they would get on screen.
const realIsVisible = BrowserWindow.prototype.isVisible
BrowserWindow.prototype.isVisible = function () {
  return this.isDestroyed() ? realIsVisible.call(this) : true
}
// BrowserWindow.getFocusedWindow() would be null: answer the first app window.
const realFocused = BrowserWindow.getFocusedWindow
BrowserWindow.getFocusedWindow = function () {
  return realFocused.call(BrowserWindow) || BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null
}
const realIsFocused = BrowserWindow.prototype.isFocused
BrowserWindow.prototype.isFocused = function () {
  return this.isDestroyed() ? realIsFocused.call(this) : true
}

app.on('web-contents-created', (_e, contents) => {
  try {
    contents.setBackgroundThrottling(false)
  } catch {
    /* torn down */
  }
  // Focus emulation for the app's own windows (not web pages: a site's own
  // focus logic is left alone).
  if (contents.getType() !== 'window') return
  const emulate = () => {
    try {
      if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
      contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    } catch {
      /* another client holds the debugger, or the contents is gone */
    }
  }
  contents.on('dom-ready', emulate)
})
