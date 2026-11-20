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

export function guardInput(opts: { readOnly: boolean; onTouch: () => void }, target: Window = window): () => void {
  const on = (e: Event): void => {
    if (opts.readOnly) {
      if (e instanceof KeyboardEvent && READING_KEYS.has(e.key)) return
      // Following a link is reading; links.ts sends it to the browser.
      if (e.type === 'click' && (e.target as Element | null)?.closest?.('a[href]')) return
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
