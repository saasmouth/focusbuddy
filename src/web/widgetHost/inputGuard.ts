// What the person does in the page: noticed for saving, refused when read-only.
//
// Saving (saveGate.ts) needs to know that the PERSON did something, so a widget
// tidying its own content on mount never rewrites the file. Read-only (signed
// out in PlexiiLite) needs every editing gesture refused before any widget sees
// it -- keys, clicks, pastes, drops, menus -- while scrolling, which is reading,
// still works. Both are capture listeners on the window, so they run before
// React's own handlers (which are attached at the root) and before any widget.

/** Gestures that can change something. Wheel, scroll and pointer movement are reading, not editing. */
export const EDITING_EVENTS = [
  'keydown', 'keypress', 'beforeinput', 'paste', 'cut', 'drop', 'dragstart',
  'pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu', 'touchstart', 'submit'
] as const

/** Keys that only move focus or ask nothing of the page; allowed in read-only. */
const READING_KEYS = new Set(['Tab'])

/**
 * How a READING control (copy, switch which slide or sheet is shown; marked
 * data-reading-control, lib/widgetSurface readingControl) is pressed. Read-only,
 * only these reach it: typing, pasting, dropping, a menu or a double-click on
 * it is still editing and still refused.
 */
const PRESS_EVENTS = new Set(['pointerdown', 'mousedown', 'click', 'touchstart'])
const PRESS_KEYS = new Set(['Enter', ' '])
const pressesReadingControl = (e: Event): boolean => {
  if (!(e.target as Element | null)?.closest?.('[data-reading-control]')) return false
  return e instanceof KeyboardEvent ? e.type === 'keydown' && PRESS_KEYS.has(e.key) : PRESS_EVENTS.has(e.type)
}

export function guardInput(opts: { readOnly: boolean; onTouch: () => void }, target: Window = window): () => void {
  const on = (e: Event): void => {
    if (opts.readOnly) {
      if (e instanceof KeyboardEvent && READING_KEYS.has(e.key)) return
      // Following a link is reading; links.ts sends it to the browser.
      if (e.type === 'click' && (e.target as Element | null)?.closest?.('a[href]')) return
      if (pressesReadingControl(e)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      return
    }
    // A modifier pressed on its own changes nothing.
    if (e instanceof KeyboardEvent && ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return
    opts.onTouch()
  }
  for (const t of EDITING_EVENTS) target.addEventListener(t, on, { capture: true })
  return () => {
    for (const t of EDITING_EVENTS) target.removeEventListener(t, on, { capture: true })
  }
}
