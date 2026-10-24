// Who answers a right-click inside a work widget's body. ONE rule, in one place
// (WidgetFrame's body handler calls this; a body that wants to defer to it can
// call it too):
//
//   1. 'handled' — the body drew its own content menu (a table cell, a speed-deck
//      tile, a sticky's text menu) and called preventDefault. Its menu wins.
//   2. 'web'     — the click is inside a <webview> or <iframe>: web content gets
//      the native web menu from main (webContextMenu.ts, E-8). Leave it alone.
//   3. 'text'    — the click is on an editable field (input, textarea,
//      contenteditable) or on text the person has selected inside this body:
//      the §9.3 TEXT shape, which main draws natively for the window (WP3,
//      editableField.ts). Do NOT preventDefault, or that menu never opens.
//      An element can opt into this explicitly with data-native-context-menu.
//   4. 'widget'  — anything else: the widget's own menu, the same one its
//      header opens (the resolver), so no body is silent (AUDIT §1.3).

export type BodyMenuTarget = 'handled' | 'web' | 'text' | 'widget'

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'tel', 'password', 'number'])

function isEditable(el: Element | null): boolean {
  if (!el) return false
  const field = el.closest('input, textarea, [contenteditable]')
  if (!field) return false
  if (field.tagName === 'TEXTAREA') return true
  if (field.tagName === 'INPUT') return TEXT_INPUT_TYPES.has(((field as HTMLInputElement).type || '').toLowerCase())
  const ce = (field.getAttribute('contenteditable') ?? '').toLowerCase()
  return ce !== 'false'
}

/** True when the person has text selected inside `scope` (a non-empty, non-collapsed selection). */
function hasSelectionIn(scope: Element | null): boolean {
  if (!scope || typeof window === 'undefined' || !window.getSelection) return false
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return false
  const node = sel.anchorNode
  return !!node && scope.contains(node)
}

export function bodyMenuTarget(
  e: { defaultPrevented: boolean; target: EventTarget | null },
  body?: Element | null
): BodyMenuTarget {
  if (e.defaultPrevented) return 'handled'
  const el = e.target instanceof Element ? e.target : null
  if (el?.closest('webview, iframe')) return 'web'
  if (el?.closest('[data-native-context-menu]')) return 'text'
  if (isEditable(el)) return 'text'
  if (hasSelectionIn(body ?? el)) return 'text'
  return 'widget'
}
