// A frame may not take focus by itself.
//
// Chromium's PDF viewer focuses itself about 150 ms after it loads. Its
// iframe then holds focus, so every key goes into the PDF: ⌘Z after dropping
// a PDF on a desk undid nothing, and a PDF that finished loading while
// somebody typed in a note took the rest of their typing.
//
// The page cannot see a click inside the frame, but it does see focus move
// into it: the window blurs while the frame becomes document.activeElement.
// Up to 4.3.55 that move counted as the person's only when the pointer was over
// the frame. But the PDF viewer is a frame in its own process, and no pointer
// event over it reaches the page (1a measured it in PlexiiLite, 24 Nov 2026), so
// a real click looked like the viewer's own grab and was undone: typing into a
// PDF went to the desk. So it goes by time, as PlexiiLite's guard does: the
// viewer's grab comes right after it loads (134 to 150 ms), so a move within
// the window after a load is the frame's own and goes back; any later move is
// the person's (a click, or Tab at any time).

/** How long after a frame loads a focus move into it counts as the frame's own. */
export const SELF_FOCUS_WINDOW_MS = 2000
/** A Tab this recent explains a focus move into the frame. */
export const TAB_WINDOW_MS = 500

export interface FocusMove {
  /** Milliseconds since the frame loaded. */
  msSinceLoad: number
  /** Milliseconds since the last Tab key. */
  msSinceTab: number
}

/** Whether a focus move into the frame was the frame's own doing, not the person's. */
export function isSelfFocus(m: FocusMove): boolean {
  if (m.msSinceTab < TAB_WINDOW_MS) return false
  return m.msSinceLoad < SELF_FOCUS_WINDOW_MS
}

/** Watch `frame` and undo any focus it takes by itself. Returns the stop function. */
export function guardFrameFocus(frame: HTMLIFrameElement, now: () => number = () => performance.now()): () => void {
  const doc = frame.ownerDocument
  const win = doc.defaultView
  if (!win) return () => undefined
  let loadedAt = now()
  let tabAt = -Infinity
  // Whether the frame already holds focus (so a window blur is the app losing
  // focus, not focus moving into the frame).
  let holds = doc.activeElement === frame
  // The element that just lost focus, kept only until this task ends: when
  // focus moves into the frame, that is what it moved from.
  let lostNow: HTMLElement | null = null

  const onLoad = (): void => {
    loadedAt = now()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Tab') tabAt = now()
  }
  const onFocusOut = (e: FocusEvent): void => {
    if (!(e.target instanceof HTMLElement) || e.target === frame) return
    const el = e.target
    lostNow = el
    win.setTimeout(() => {
      if (lostNow === el) lostNow = null
    }, 0)
  }
  const onFocusIn = (e: FocusEvent): void => {
    if (e.target !== frame) holds = false
  }
  const onWinFocus = (): void => {
    holds = doc.activeElement === frame
  }
  const onBlur = (): void => {
    if (doc.activeElement !== frame) return
    if (holds) return
    const t = now()
    if (!isSelfFocus({ msSinceLoad: t - loadedAt, msSinceTab: t - tabAt })) {
      holds = true
      return
    }
    // Back to what lost focus to the frame, else to the page itself.
    const back = lostNow
    frame.blur()
    // Chromium keeps the frame as the page's focused frame through a blur, and
    // focus drifts back to it; focusing the window, once this blur is over,
    // makes the page's own frame the focused one again.
    win.setTimeout(() => {
      if (doc.activeElement !== frame && !back) return
      win.focus()
      if (back?.isConnected) back.focus({ preventScroll: true })
    }, 0)
  }

  frame.addEventListener('load', onLoad)
  doc.addEventListener('keydown', onKey, true)
  doc.addEventListener('focusout', onFocusOut, true)
  doc.addEventListener('focusin', onFocusIn, true)
  win.addEventListener('focus', onWinFocus)
  win.addEventListener('blur', onBlur)
  return () => {
    frame.removeEventListener('load', onLoad)
    doc.removeEventListener('keydown', onKey, true)
    doc.removeEventListener('focusout', onFocusOut, true)
    doc.removeEventListener('focusin', onFocusIn, true)
    win.removeEventListener('focus', onWinFocus)
    win.removeEventListener('blur', onBlur)
  }
}
