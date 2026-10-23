// Which surface answers the Plexii rows of the app window's native text menu
// (shared/textMenu.ts has the whole flow). Any surface with text can register:
//
//   const off = registerTextMenuHandler(editorRootElement, {
//     askAssist: (cmd) => …,      // or false: this surface never offers it
//     saveSnippet: (cmd) => …     // offering it makes the row appear here
//   })
//
// The focused element picks the handler: the innermost registered element that
// contains it (or a predicate that accepts it), latest registration first on a
// tie. Without one, "Ask PlexiiAssist about this" takes the generic route (the
// passage quoted in PlexiiAssist's composer) and "Save selection as snippet…"
// is absent, because no generic flow turns plain text into a snippet.

import { DEFAULT_TEXT_MENU_CAPS, TEXT_MENU_QUERY, type TextMenuCaps, type TextMenuCommand, type TextMenuQueryResult } from '@shared/textMenu'

export interface TextMenuHandlers {
  /** Handle "Ask PlexiiAssist about this" here; false hides the row for this surface; omitted uses the generic route. */
  askAssist?: false | ((cmd: TextMenuCommand) => void)
  /** Handle "Save selection as snippet…" here; omitted: the row is absent on this surface. */
  saveSnippet?: (cmd: TextMenuCommand) => void
}

type Target = Element | ((el: Element) => boolean)
interface Entry {
  target: Target
  handlers: TextMenuHandlers
  seq: number
}

const entries: Entry[] = []
let seq = 0

/** Register a surface's handlers. Returns the unregister function (call it on unmount). */
export function registerTextMenuHandler(target: Target, handlers: TextMenuHandlers): () => void {
  const e: Entry = { target, handlers, seq: ++seq }
  entries.push(e)
  return () => {
    const i = entries.indexOf(e)
    if (i >= 0) entries.splice(i, 1)
  }
}

const depth = (el: Element): number => {
  let d = 0
  for (let n: Element | null = el; n; n = n.parentElement) d++
  return d
}

/** The handlers for an element: innermost registered ancestor (a predicate counts as the element itself), latest first on a tie. */
export function textMenuHandlerFor(el: Element | null): TextMenuHandlers | null {
  if (!el) return null
  let best: { e: Entry; d: number } | null = null
  for (const e of entries) {
    let d = -1
    if (typeof e.target === 'function') d = e.target(el) ? depth(el) : -1
    else if (e.target.contains(el)) d = depth(e.target)
    if (d < 0) continue
    if (!best || d > best.d || (d === best.d && e.seq > best.e.seq)) best = { e, d }
  }
  return best?.e.handlers ?? null
}

/** The rows the focused element offers (main asks this before drawing the menu). */
export function textMenuCaps(el: Element | null = typeof document === 'undefined' ? null : document.activeElement): TextMenuCaps {
  const h = textMenuHandlerFor(el)
  if (!h) return { ...DEFAULT_TEXT_MENU_CAPS }
  return { askAssist: h.askAssist !== false, saveSnippet: typeof h.saveSnippet === 'function' }
}

/**
 * Carry out a chosen row. `fallbackAsk` is the generic route (WebMenuCommandHost
 * passes it, so this module stays free of the assistant's stores).
 */
export function dispatchTextMenuCommand(cmd: TextMenuCommand, fallbackAsk: (text: string) => void, el: Element | null = document.activeElement): void {
  const h = textMenuHandlerFor(el)
  if (cmd.action === 'askAssist') {
    if (h?.askAssist === false) return
    if (typeof h?.askAssist === 'function') h.askAssist(cmd)
    else if (cmd.selectionText.trim()) fallbackAsk(cmd.selectionText.trim())
    return
  }
  h?.saveSnippet?.(cmd)
}

// Whether text was selected when the last right-button press began (captured
// before Chromium's select-word-on-right-click runs), and when that was. A menu
// opened from the keyboard has no press: then the selection is the person's.
let rightDown: { at: number; selected: boolean } | null = null
const RIGHT_DOWN_FRESH_MS = 2000

function onPointerDownCapture(e: MouseEvent): void {
  if (e.button !== 2) return
  const sel = window.getSelection()
  rightDown = { at: Date.now(), selected: !!sel && !sel.isCollapsed && sel.toString().trim().length > 0 }
}

/** The answer to main's query (shared/textMenu.ts TextMenuQueryResult). */
export function textMenuQuery(): TextMenuQueryResult {
  const fresh = rightDown && Date.now() - rightDown.at < RIGHT_DOWN_FRESH_MS
  return { ...textMenuCaps(), selectedBefore: fresh ? rightDown!.selected : true }
}

let installed = false
/** Expose the query main calls and start watching right-button presses. Idempotent. */
export function installTextMenuQuery(): void {
  if (typeof window === 'undefined') return
  ;(window as unknown as Record<string, unknown>)[TEXT_MENU_QUERY] = textMenuQuery
  if (installed) return
  installed = true
  window.addEventListener('mousedown', onPointerDownCapture, true)
}
