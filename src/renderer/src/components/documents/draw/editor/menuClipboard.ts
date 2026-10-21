// The app's own Edit menu (Edit › Cut, Copy, Paste in the native menu bar)
// driving PlexiiDraw's clipboard commands.
//
// The native menu items are Electron roles: clicking one makes Chromium fire a
// DOM `cut` / `copy` / `paste` event at whatever has focus. With a drawing
// open and nothing typed into, that event runs Draw's own command, the same
// one ⌘X / ⌘C / ⌘V run, so the menu and the key do exactly the same thing.
//
// No double firing: a key PlexiiDraw handles is preventDefault()-ed on
// keydown, and Chromium then neither fires the clipboard event nor passes the
// key to the menu's accelerator. A key Draw leaves alone (⌘C with nothing
// selected) reaches the menu, whose event finds nothing to copy and is left
// to the browser too.

import { commandById } from '../commands/registry'
import type { EditorCtx } from './types'

export type ClipboardEventKind = 'cut' | 'copy' | 'paste'

const COMMAND: Record<ClipboardEventKind, string> = {
  cut: 'edit.cut',
  copy: 'edit.copy',
  paste: 'edit.paste'
}

export interface ClipboardEventInfo {
  /** Focus is in a field (the text box, an inspector input): the field keeps its own clipboard. */
  inField: boolean
  /** Some page text is selected (outside any field): copying that text is what was meant. */
  textSelected: boolean
  preventDefault(): void
}

/**
 * Handle a DOM clipboard event as Draw's command when it is Draw's to handle.
 * Returns true when it ran the command (and prevented the browser's default).
 */
export function handleClipboardEvent(ctx: EditorCtx, kind: ClipboardEventKind, e: ClipboardEventInfo): boolean {
  if (e.inField || e.textSelected) return false
  const s = ctx.get()
  if (s.dialog || s.editingText) return false
  const c = commandById(COMMAND[kind])
  if (!c) return false
  if (c.keyWhen && !c.keyWhen(ctx)) return false
  if (c.enabled && !c.enabled(ctx)) return false
  e.preventDefault()
  ctx.run(c.id)
  return true
}

/** What a DOM clipboard event's target and the page selection say, for handleClipboardEvent. */
export function clipboardEventInfo(e: Event): ClipboardEventInfo {
  const el = (e.target instanceof Node ? (e.target.nodeType === 1 ? e.target : e.target.parentElement) : null) as HTMLElement | null
  const inField = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
  const sel = typeof window !== 'undefined' ? window.getSelection() : null
  const textSelected = !!sel && !sel.isCollapsed && sel.toString().length > 0
  return { inField, textSelected, preventDefault: () => e.preventDefault() }
}
