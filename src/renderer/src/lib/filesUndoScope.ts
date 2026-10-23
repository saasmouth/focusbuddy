// Which ⌘Z presses belong to Files.
//
// Files keeps its own undo stack for file operations (move, rename, create,
// delete). Its key listener sits on the document, so without a scope it took
// EVERY ⌘Z in the window: with Files open beside a PlexiiWrite document, an
// undo meant for typing undid a file move instead. It also skipped only
// <input> and <textarea>, so contentEditable editors (Write, Draw's text,
// Cells' cell editor) were never protected.
//
// The rule:
//   - never while focus is in something that edits text (input, textarea,
//     select, contentEditable): text keeps its own undo;
//   - never a press another handler already took (defaultPrevented);
//   - focus inside this Files surface: yes;
//   - focus nowhere in particular (body) AND this is the full-screen Files
//     view: yes, because then Files is the only thing on screen. The panel
//     beside other work never claims an unfocused press.

export interface UndoKey {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented: boolean
}

export interface UndoScope {
  /** The Files surface's root element. */
  root: Element | null
  /** document.activeElement at the time of the press. */
  active: Element | null
  /** True for the full-screen Files view, false for the panel beside other work. */
  fullScreen: boolean
}

function editsText(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  const h = el as HTMLElement
  if (h.isContentEditable) return true
  // happy-dom and some hosts do not compute isContentEditable; read the attribute chain too.
  return !!el.closest?.('[contenteditable=""], [contenteditable="true"]')
}

export function filesUndoAction(e: UndoKey, scope: UndoScope): 'undo' | 'redo' | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'z') return null
  if (e.defaultPrevented) return null
  const { root, active, fullScreen } = scope
  if (editsText(active)) return null
  const unfocused = !active || active === active.ownerDocument?.body || active === active.ownerDocument?.documentElement
  const inside = !!root && !!active && root.contains(active)
  if (!inside && !(unfocused && fullScreen)) return null
  return e.shiftKey ? 'redo' : 'undo'
}
