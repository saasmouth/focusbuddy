// Each work widget as a DESTINATION: inserting a saved snippet into it and
// pasting into it, through the one conversion (shared/snippetWidgets.ts) and
// the one set of side effects (lib/widgetSnippetInsert.ts). A widget calls the
// hook for its kind and hands the result to WidgetFrame's `snippets` prop,
// which puts "Insert snippet…" and "Paste" in its menus.

import { useEffect, useRef } from 'react'
import type { Editor } from '@tiptap/react'
import type { Snippet, SnippetInsertResult, SnippetKind } from '@shared/snippets'
import type { Widget } from '@shared/types'
import type { Form } from '@shared/snippetForms'
import {
  acceptForImage,
  acceptForMarkdown,
  acceptForPage,
  acceptForTable,
  acceptForTextWidget,
  type AcceptContext
} from '@shared/snippetWidgets'
import {
  announcePaste,
  appendRowsToTable,
  bodyForms,
  imageWidgetContent,
  isTsvGrid,
  markdownReady,
  pageNodesReady,
  readPasteForms,
  snapshotFromSystem,
  snapshotPaste,
  spliceText,
  tookIt,
  useWidgetSnippetTarget,
  widgetAccepts,
  type PasteSnapshot
} from '../../lib/widgetSnippetInsert'
import { useWidgetStore } from '../../stores/widgets'

export interface WidgetSnippets {
  targetId: string
  kinds: SnippetKind[]
  /** Paste from the menu (no event): reads the system clipboard. */
  onPaste: () => void
}

const insertCtx = (s: Snippet): AcceptContext => ({ body: s.body, verb: 'insert' })

// ── Sticky and note: a textarea ──────────────────────────────────────────────

/**
 * A sticky or a note. Insert and paste splice text in at the caret (or at the
 * end when the note is not being edited), on its own lines. ⌘V keeps the
 * textarea's own paste for ordinary text; a grid (a Cells range) becomes a
 * pipe table, and a picture is refused with where it can go.
 */
export function useTextWidgetSnippets(
  widget: Widget,
  kind: 'sticky' | 'note',
  getText: () => string,
  setText: (next: string, caret: number) => void,
  textarea: () => HTMLTextAreaElement | null
): WidgetSnippets & { onTextareaPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void } {
  const caret = (): { start: number; end: number } | null => {
    const ta = textarea()
    return ta && ta.isConnected ? { start: ta.selectionStart, end: ta.selectionEnd } : null
  }
  const land = (forms: Form[], ctx: AcceptContext, at: { start: number; end: number } | null): SnippetInsertResult => {
    const r = acceptForTextWidget(kind, forms, ctx)
    if (!r.ok) return r
    const next = spliceText(getText(), r.text, at)
    setText(next.text, next.caret)
    return tookIt(r.lossy)
  }
  const pasteSnap = async (snap: PasteSnapshot, at: { start: number; end: number } | null): Promise<void> => {
    // Plain text that is not a grid goes in exactly as typed text would.
    if (snap.text && !isTsvGrid(snap.text)) {
      const next = spliceText(getText(), snap.text, at)
      setText(next.text, next.caret)
      return
    }
    const read = await readPasteForms(snap)
    if (read.refused) return announcePaste({ ok: false, reason: read.refused })
    if (!read.forms.length) return
    announcePaste(land(read.forms, read.ctx, at))
  }
  const targetId = useWidgetSnippetTarget(widget, kind, (s) => land(bodyForms(s.body), insertCtx(s), caret()))
  return {
    targetId,
    kinds: widgetAccepts(kind),
    onPaste: () => {
      const at = caret()
      void snapshotFromSystem().then((snap) => pasteSnap(snap, at))
    },
    onTextareaPaste: (e) => {
      const snap = snapshotPaste(e.clipboardData)
      if (snap.text && !isTsvGrid(snap.text)) return // the textarea's own paste
      e.preventDefault()
      const ta = e.currentTarget
      void pasteSnap(snap, { start: ta.selectionStart, end: ta.selectionEnd })
    }
  }
}

// ── Page and markdown: a TipTap editor ───────────────────────────────────────

/**
 * Insert TipTap nodes (a page) or markdown (a markdown work widget) at the
 * cursor, pictures stored in the file store first. ⌘V keeps the editor's own
 * paste for text and HTML, which already reads markdown and tables; what it
 * cannot read (a picture, a drawing, a grid of cells) comes through here.
 */
export function useEditorWidgetSnippets(
  widget: Widget,
  kind: 'page' | 'markdown',
  editor: Editor | null,
  enabled = true
): WidgetSnippets & { handlePaste: (event: ClipboardEvent) => boolean } {
  const editorRef = useRef(editor)
  editorRef.current = editor
  // Where an insert lands: at the cursor once the person has put one in this
  // editor, otherwise at the end. A fresh editor's selection sits at the very
  // start, and landing a picture ABOVE what someone wrote reads as a mistake.
  const touched = useRef(false)
  useEffect(() => {
    if (!editor) return
    touched.current = false
    const mark = (): void => {
      touched.current = true
    }
    editor.on('focus', mark)
    return () => {
      editor.off('focus', mark)
    }
  }, [editor])
  const at = (ed: Editor) => (touched.current ? ed.chain().focus() : ed.chain().focus('end'))

  const land = async (forms: Form[], ctx: AcceptContext): Promise<SnippetInsertResult> => {
    const ed = editorRef.current
    if (!ed || ed.isDestroyed) return { ok: false, reason: 'This work widget is not open.' }
    if (!ed.isEditable) return { ok: false, reason: 'This page is written for you, so nothing can be added to it.' }
    if (kind === 'page') {
      const r = acceptForPage(forms, ctx)
      if (!r.ok) return r
      const nodes = await pageNodesReady(r.nodes)
      if (ed.isDestroyed) return { ok: false, reason: 'This work widget is not open.' }
      at(ed).insertContent(nodes as never).run()
      return tookIt(r.lossy)
    }
    const r = acceptForMarkdown(forms, ctx)
    if (!r.ok) return r
    const ready = await markdownReady(r.markdown)
    if (!ready.ok) return ready
    if (ed.isDestroyed) return { ok: false, reason: 'This work widget is not open.' }
    // tiptap-markdown parses a string given to insertContent as markdown, so
    // what lands is exactly what the widget will save and read back.
    at(ed).insertContent(ready.markdown).run()
    return tookIt(r.lossy)
  }
  const pasteSnap = async (snap: PasteSnapshot): Promise<void> => {
    const read = await readPasteForms(snap)
    if (read.refused) return announcePaste({ ok: false, reason: read.refused })
    if (!read.forms.length) return
    announcePaste(await land(read.forms, read.ctx))
  }

  const targetId = useWidgetSnippetTarget(widget, kind, (s) => land(bodyForms(s.body), insertCtx(s)), enabled)
  return {
    targetId,
    kinds: widgetAccepts(kind),
    onPaste: () => {
      void snapshotFromSystem().then((snap) => {
        const ed = editorRef.current
        // Plain text from the menu goes through the editor's own text paste,
        // which reads markdown exactly as ⌘V does.
        if (snap.text && !isTsvGrid(snap.text) && ed && !ed.isDestroyed) {
          ed.view.focus()
          ed.view.pasteText(snap.text)
          return
        }
        return pasteSnap(snap)
      })
    },
    handlePaste: (event) => {
      if (!enabled) return false
      const dt = event.clipboardData
      const snap = snapshotPaste(dt)
      const html = dt?.getData('text/html') ?? ''
      if ((snap.text && !isTsvGrid(snap.text)) || (!snap.text && html.trim())) return false // the editor's own paste
      event.preventDefault()
      void pasteSnap(snap)
      return true
    }
  }
}

// ── Table: rows into its fb_table ────────────────────────────────────────────

/** Rows appended to the table work widget's table, matched to its columns. */
export function useTableWidgetSnippets(widget: Widget, tableId: string | null): WidgetSnippets & { pasteRows: () => Promise<void> } {
  const idRef = useRef(tableId)
  idRef.current = tableId
  const land = async (forms: Form[], ctx: AcceptContext): Promise<SnippetInsertResult> => {
    const r = acceptForTable(forms, ctx)
    if (!r.ok) return r
    const id = idRef.current
    if (!id) return { ok: false, reason: 'This table work widget has no table yet. Try again in a moment.' }
    const done = await appendRowsToTable(id, r.rows, r.header)
    if (!done.ok) return done
    return tookIt(r.lossy)
  }
  const pasteRows = async (): Promise<void> => {
    const read = await readPasteForms(await snapshotFromSystem())
    if (read.refused) return announcePaste({ ok: false, reason: read.refused })
    if (!read.forms.length) return
    announcePaste(await land(read.forms, read.ctx))
  }
  const targetId = useWidgetSnippetTarget(widget, 'table', (s) => land(bodyForms(s.body), insertCtx(s)), !!tableId)
  return { targetId, kinds: widgetAccepts('table'), onPaste: () => void pasteRows(), pasteRows }
}

// ── Image: replace the picture ───────────────────────────────────────────────

/** The picture stored in the file store and shown instead of the current one. */
export function useImageWidgetSnippets(widget: Widget): WidgetSnippets & { onBodyPaste: (e: React.ClipboardEvent) => void } {
  const update = useWidgetStore((s) => s.update)
  const land = async (forms: Form[], ctx: AcceptContext): Promise<SnippetInsertResult> => {
    const r = acceptForImage(forms, ctx)
    if (!r.ok) return r
    const content = await imageWidgetContent(r.picture)
    if (!content) return { ok: false, reason: 'The picture could not be stored.' }
    await update(widget.id, { content })
    return tookIt(r.lossy)
  }
  const pasteSnap = async (snap: PasteSnapshot): Promise<void> => {
    const read = await readPasteForms(snap)
    if (read.refused) return announcePaste({ ok: false, reason: read.refused })
    if (!read.forms.length) return
    announcePaste(await land(read.forms, read.ctx))
  }
  const targetId = useWidgetSnippetTarget(widget, 'image', (s) => land(bodyForms(s.body), insertCtx(s)))
  return {
    targetId,
    kinds: widgetAccepts('image'),
    onPaste: () => void snapshotFromSystem().then(pasteSnap),
    onBodyPaste: (e) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return // the URL field keeps its own paste
      e.preventDefault()
      e.stopPropagation()
      void pasteSnap(snapshotPaste(e.clipboardData))
    }
  }
}
