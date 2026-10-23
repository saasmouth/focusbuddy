import type { Editor } from '@tiptap/react'
import { promptText } from '../../plexi/PromptDialog'
import type { AppClipboardRead } from '@shared/appClipboard'
import { menuPasteIntoDoc } from './docSnippets'

// Write actions that more than one surface offers, defined once (SPEC §9, one
// definition per action): the menu bar and the ribbon both call these, so the
// same action cannot do two different things (or, as the ribbon's Link did,
// nothing at all).

/** Link the selection (or edit the link under the caret): asks for the URL; an empty URL removes the link. */
export async function insertLink(editor: Editor): Promise<void> {
  const prev = (editor.getAttributes('link').href as string) || ''
  const url = await promptText({ title: 'Link URL', initial: prev, placeholder: 'https://', confirmLabel: 'Set link' })
  if (url == null) return
  const chain = editor.chain().focus().extendMarkRange('link')
  if (url.trim() === '') chain.unsetLink().run()
  else chain.setLink({ href: url.trim() }).run()
}

/** The dialogs Write opens from both its menu bar (Tools) and its ribbon (Review). */
export type DocDialog = 'wordcount' | 'a11y'

/**
 * Edit › Paste: the same paste as ⌘V. Another of our apps' content (or a lone
 * picture) lands converted, as handlePaste does; anything else goes through
 * ProseMirror's own paste pipeline (view.pasteHTML / pasteText), the one ⌘V
 * runs, so formatting survives. The menu used to insert the clipboard's plain
 * text, dropping every bold, link and heading.
 */
export async function pasteFromMenu(editor: Editor): Promise<void> {
  if (!editor.isEditable) return
  if ((await menuPasteIntoDoc(editor).catch(() => null)) !== null) return
  const api = (globalThis as unknown as { api?: { snippets?: { readClipboard?: () => Promise<AppClipboardRead> } } }).api
  let read: AppClipboardRead | null = null
  try {
    read = (await api?.snippets?.readClipboard?.()) ?? null
  } catch {
    read = null
  }
  editor.commands.focus()
  if (read?.html) {
    editor.view.pasteHTML(read.html)
    return
  }
  const text = read?.text ?? (await navigator.clipboard?.readText().catch(() => '')) ?? ''
  if (text) editor.view.pasteText(text)
}
