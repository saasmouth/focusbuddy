// A work widget that was just placed on the desk takes the keyboard.
//
// Adding a Tasks work widget from the side menu ("Add to this desk") used to
// leave focus on the document body: the new widget was activated, so the
// desk's single-key quick-add stayed quiet, but nothing owned the keyboard
// either. The first thing a person types after adding a task list is a task,
// and those letters went nowhere; with nothing engaged (a click that landed on
// the empty desk, Escape) the same letters are S = sticky, T = table.
//
// So a placed work widget hands focus to its primary entry field, the element
// it marks with `data-primary-input` (the Tasks work widget's "Add a task"
// box). A kind without one is left alone: its own editor decides (a sticky
// already opens in edit mode). Focus is only taken from the body: if the
// person has already clicked or tabbed somewhere, that wins.

export const PRIMARY_INPUT_ATTR = 'data-primary-input'

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&')
}

/** The marked entry field inside a widget's frame, if it is mounted. */
export function primaryInputOf(widgetId: string, root: ParentNode = document): HTMLElement | null {
  for (const frame of Array.from(root.querySelectorAll(`[data-widget-id="${cssEscape(widgetId)}"]`))) {
    const el = frame.querySelector<HTMLElement>(`[${PRIMARY_INPUT_ATTR}]`)
    if (el) return el
  }
  return null
}

/** Nothing owns the keyboard yet: the body (or nothing) has focus. */
function focusIsFree(): boolean {
  const a = document.activeElement
  return !a || a === document.body || a === document.documentElement
}

/**
 * Focus the new widget's primary input once it has mounted. Polls a few
 * frames (the instance is adopted into the store before React renders it)
 * and gives up quietly after `timeoutMs`.
 */
export function focusNewWidget(widgetId: string, timeoutMs = 1500): void {
  if (typeof document === 'undefined') return
  const start = Date.now()
  const tick = (): void => {
    if (!focusIsFree()) return // the person got there first
    const el = primaryInputOf(widgetId)
    if (el) {
      el.focus({ preventScroll: true })
      return
    }
    if (Date.now() - start < timeoutMs) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
