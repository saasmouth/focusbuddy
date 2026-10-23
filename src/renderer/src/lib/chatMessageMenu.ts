// The right-click menu on a PlexiiAssist message (AUDIT M-o, F-3), as plain
// kit items. ChatPanel supplies what each row does; this decides which rows
// exist and in what order, so a test can hold the menu to SPEC §9.3 without
// mounting the panel.
//
// Shapes, groups split by separators:
//   reply, no selection:   Add to Focus… · Retry · [Insert into document] | Copy
//   your message:          Copy
//   any text selected:     Add to Focus… · Save selection as sticky · Save selection as note
//                          | Copy ⌘C | Ask PlexiiAssist about this
//
// "Copy" without a selection copies the whole message (the hover button's
// action; a reply's text is its Markdown, so there is no separate "Copy as
// Markdown"). ⌘C is hinted only on a selection: that is the only time the key
// copies anything here. Absent on purpose: Edit on your own message (the
// panel has no edit action) and "Save selection as snippet…" (no snippet flow
// takes chat text yet; SPEC §9.5).

import type { CtxMenuItem } from '../components/CanvasContextMenu'
import { MENU } from '@shared/menus/lexicon'
import { shortcutLabel } from '@shared/menus/shortcuts'

export interface ChatMessageMenuInput {
  role: 'user' | 'assistant'
  /** Text selected inside the messages, if any (trimmed or not). */
  selection: string
  /** The message's own text, for Copy and Add to Focus… when nothing is selected. */
  content: string
  /** A desk is open (the sticky and note land on it). */
  deskOpen: boolean
  /** Retry for this reply: 'ready', 'busy' (an answer is still coming: off, with why), or null (no question to re-ask: absent). */
  retry: 'ready' | 'busy' | null
  /** A document editor is open to insert into. */
  canInsertIntoDoc: boolean
  platform: string
}

export interface ChatMessageMenuActions {
  addToFocus: (text: string) => void
  saveSelection: (kind: 'sticky' | 'note', text: string) => void
  copy: (text: string) => void
  askAbout: (text: string) => void
  retry: () => void
  insertIntoDoc: (text: string) => void
}

export const CHAT_MENU_LABELS = {
  retry: 'Retry',
  insertIntoDoc: 'Insert into document',
  saveAsSticky: 'Save selection as sticky',
  saveAsNote: 'Save selection as note'
} as const

/** The menu for one right-click on a message, or on a selection in the messages. Empty: no menu. */
export function chatMessageMenu(input: ChatMessageMenuInput, act: ChatMessageMenuActions): CtxMenuItem[] {
  const sel = input.selection.trim() ? input.selection : ''
  const out: CtxMenuItem[] = []
  const group = (rows: CtxMenuItem[]): void => {
    if (!rows.length) return
    if (out.length) out.push({ separator: true })
    out.push(...rows)
  }

  if (sel) {
    const noDesk = input.deskOpen ? {} : { disabled: true, hint: 'Open a desk first' }
    group([
      { label: MENU.addToFocus.label, icon: 'notifications', testid: 'chat-menu-focus', onClick: () => act.addToFocus(sel) },
      { label: CHAT_MENU_LABELS.saveAsSticky, icon: 'sticky_note_2', testid: 'chat-menu-sticky', ...noDesk, onClick: () => act.saveSelection('sticky', sel) },
      { label: CHAT_MENU_LABELS.saveAsNote, icon: 'description', testid: 'chat-menu-note', ...noDesk, onClick: () => act.saveSelection('note', sel) }
    ])
    group([{ label: MENU.copy.label, icon: 'content_copy', shortcut: shortcutLabel(MENU.copy.keys, input.platform), testid: 'chat-menu-copy', onClick: () => act.copy(sel) }])
    group([{ label: MENU.askAssistAboutThis.label, icon: 'auto_awesome', testid: 'chat-menu-ask', onClick: () => act.askAbout(sel) }])
    return out
  }

  if (!input.content.trim()) return []
  if (input.role === 'assistant') {
    const rows: CtxMenuItem[] = [
      { label: MENU.addToFocus.label, icon: 'notifications', testid: 'chat-menu-focus', onClick: () => act.addToFocus(input.content) }
    ]
    if (input.retry) {
      const busy = input.retry === 'busy' ? { disabled: true, hint: 'Wait for the current answer to finish' } : {}
      rows.push({ label: CHAT_MENU_LABELS.retry, icon: 'refresh', testid: 'chat-menu-retry', ...busy, onClick: act.retry })
    }
    if (input.canInsertIntoDoc) rows.push({ label: CHAT_MENU_LABELS.insertIntoDoc, icon: 'post_add', testid: 'chat-menu-insert-doc', onClick: () => act.insertIntoDoc(input.content) })
    group(rows)
  }
  group([{ label: MENU.copy.label, icon: 'content_copy', testid: 'chat-menu-copy', onClick: () => act.copy(input.content) }])
  return out
}
