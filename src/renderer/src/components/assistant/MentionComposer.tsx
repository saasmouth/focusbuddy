// The assistant's composer (Phase 4.3): a small TipTap editor in place of the
// plain <textarea>, so mention chips sit INSIDE the sentence where they were
// typed — Notion's behaviour, and plan D9.
//
// Everything the textarea did, this must still do, because each of those is a
// shipped behaviour with a lock behind it:
//   • Enter sends, ⇧↵ makes a newline (and ⌘/Ctrl+↵ still sends, for muscle
//     memory) — but ONLY when the "@" picker is not open, or Enter would send
//     the message instead of choosing the highlighted reference.
//   • The box grows with its content up to a ceiling, then scrolls.
//   • The draft survives a chrome mode switch (AC-2) — which it does for the
//     same reason it did before: this component is never keyed on the mode, so
//     React re-parents one instance rather than remounting a new one.
//   • A placeholder shows while empty.
//
// The editor is deliberately minimal. StarterKit supplies the document /
// paragraph / text schema and undo-redo (it is already a dependency — the
// document editor builds on it), and everything that would turn a chat message
// into a document is switched OFF: headings, lists, blockquote, code blocks,
// rules, images, links. A stray paste brings words and chips, never block
// structure.

import { useEffect, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import type { Editor, JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { MentionNode } from './MentionNode'
import { MentionSuggestion, type MentionSuggestionHooks } from './MentionSuggestion'
import { docToInput } from '../../lib/mentionDoc'
import { linesSlice, pastedPlainText, wantsPlainLines } from '../../lib/composerPaste'
import { PASTE_FILES_EVENT, pastedFilesOf } from '../../lib/pastedFiles'

interface Props {
  placeholder: string
  disabled: boolean
  hooks: MentionSuggestionHooks
  // Fired on every change with the current plain-text rendering (so the host
  // can enable/disable Send) and the document itself (so the host can keep
  // the draft alive across unmounts — A1, defect AI-16).
  onTextChange: (text: string, doc: JSONContent) => void
  // Enter (or ⌘↵) with content. The host reads the document through the handle.
  onSubmit: () => void
  // Handed the editor so the host can read the document and clear it on send.
  onReady: (editor: Editor) => void
  // Files or pictures pasted or dropped into the composer: the host attaches
  // them to the message (ChatPanel's tray). Without this they were lost: a
  // picture vanished, and a Finder file pasted as its name.
  onFiles?: (files: File[]) => void
}

export default function MentionComposer({
  placeholder,
  disabled,
  hooks,
  onTextChange,
  onSubmit,
  onReady,
  onFiles
}: Props): JSX.Element {
  // editorProps are read once, at creation: the latest handler through a ref.
  const onFilesRef = useRef(onFiles)
  onFilesRef.current = onFiles
  // The Placeholder extension is configured once, at editor creation — a plain
  // closure over the prop would freeze the mount-time text forever. Reading
  // through a ref lets the placeholder follow the conversation's mode
  // (discovery vs chat) without re-creating the editor and losing the draft.
  const placeholderRef = useRef(placeholder)
  placeholderRef.current = placeholder
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        // A chat message is one block of prose. ⇧↵ makes a hard break, and so do
        // <br> and <pre> lines in a paste; docToInput reads each as a newline.
        link: false
      }),
      MentionNode,
      MentionSuggestion.configure({ hooks }),
      Placeholder.configure({ placeholder: () => placeholderRef.current })
    ],
    editorProps: {
      attributes: {
        // max-h + overflow reproduces the textarea's grow-then-scroll ceiling.
        class:
          'assistant-composer-input w-full text-[var(--ink-100)] text-[13px] leading-[1.45] max-h-[160px] overflow-y-auto focus:outline-none',
        'data-testid': 'chat-composer'
      },
      // Text with line breaks or tabs (a log, an email, a range from a
      // spreadsheet) goes in exactly as written: one paragraph per line, blank
      // lines and tabs kept (lib/composerPaste). Reading the paste's HTML
      // instead flattened a spreadsheet range into one line.
      handlePaste: (view, event): boolean => {
        const data = event.clipboardData
        if (!data) return false
        // A picture (a screenshot) or a file copied in Finder is an attachment.
        const files = Array.from(data.files ?? [])
        if (files.length && onFilesRef.current) {
          event.preventDefault()
          onFilesRef.current(files)
          return true
        }
        const html = data.getData('text/html')
        const text = pastedPlainText(data.getData('text/plain'), html)
        if (!text || !wantsPlainLines(text, html)) return false
        event.preventDefault()
        view.dispatch(view.state.tr.replaceSelection(linesSlice(view.state.schema, text)).scrollIntoView())
        return true
      },
      // Files copied in Finder and pasted (main reads them: lib/pastedFiles.ts).
      handleDOMEvents: {
        [PASTE_FILES_EVENT]: (_view, event): boolean => {
          const files = pastedFilesOf(event)
          if (!files.length || !onFilesRef.current) return false
          event.preventDefault()
          event.stopPropagation()
          onFilesRef.current(files)
          return true
        }
      },
      handleDrop: (_view, event): boolean => {
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? [])
        if (!files.length || !onFilesRef.current) return false
        event.preventDefault()
        onFilesRef.current(files)
        return true
      },
      handleKeyDown: (_view, event): boolean => {
        if (event.key !== 'Enter') return false
        if (event.shiftKey && !(event.metaKey || event.ctrlKey)) return false
        // The suggestion plugin handles its own Enter while the picker is open.
        // It runs BEFORE this handler and returns true, so reaching here means
        // no picker is open and Enter genuinely means send.
        event.preventDefault()
        onSubmit()
        return true
      }
    },
    onUpdate: ({ editor: e }) => {
      const doc = e.getJSON() as JSONContent
      onTextChange(docToInput(doc).text, doc)
    }
  })

  useEffect(() => {
    if (editor) onReady(editor)
  }, [editor, onReady])

  useEffect(() => {
    if (editor) editor.setEditable(!disabled)
  }, [editor, disabled])

  // Typing (and ⌘V) go here when the assistant opens, and again when a reply
  // has finished, unless something else has taken focus meanwhile. Without it,
  // "copy something, open the assistant, ⌘V" pasted onto the desk as a new
  // widget, and after every send the next keystroke went nowhere.
  useEffect(() => {
    if (!editor || disabled) return
    const dom = editor.view.dom as HTMLElement
    const active = document.activeElement
    const free = !active || active === document.body || active === document.documentElement || dom.contains(active)
    // Hidden (another assistant tab is showing): nothing to focus.
    if (!free || dom.offsetParent === null) return
    editor.commands.focus('end')
  }, [editor, disabled])

  // Placeholder text changed (mode switch): dispatch an empty transaction so
  // the decoration re-reads the ref and repaints the new text.
  useEffect(() => {
    if (editor) editor.view.dispatch(editor.state.tr)
  }, [editor, placeholder])

  // The hooks close over live store state; re-configure rather than re-create,
  // so the document (and therefore the draft) is never thrown away.
  useEffect(() => {
    if (!editor) return
    const ext = editor.extensionManager.extensions.find(
      (x) => x.name === 'assistantMentionSuggestion'
    )
    if (ext) ext.options.hooks = hooks
  }, [editor, hooks])

  return <EditorContent editor={editor} className="w-full" />
}
