import { useState } from 'react'
import { openDocHistory } from '../DocHistoryPanel'
import { confirmDialog, promptText } from '../../plexi/PromptDialog'
import type { Editor } from '@tiptap/react'
import { useDocumentsStore } from '../../../stores/documents'
import { useViewStore } from '../../../stores/view'
import { launchMeeting } from '../../../lib/startMeeting'
import type { FbDocument } from '@shared/types'
import Icon from '../../Icon'
import { checkDocA11y } from '../../../lib/docA11y'
import { MenuBarShell, MenuModal, type MenuDef } from './menuBarKit'

// A Google-Docs-style menu bar for the document editor: File / Edit / View /
// Insert / Format / Tools / Help, each a dropdown of real actions. Every item is
// wired to a genuine capability — Tiptap editor commands, the documents store, or
// the office export IPC. Nothing here is a decorative no-op; an action that the
// editor cannot do is simply not listed.
//
// This file declares the menus; menuBarKit renders them, as it does for every
// other office app. The bar's testid is `doc-menubar` while its menus are
// `doc-menu-<id>` and `doc-menu-<id>-list`, so the kit is given an explicit
// `itemTestid` — the two prefixes predate the shared kit and specs rely on both.

interface Props {
  editor: Editor
  title: string
  // DocEditor owns these because they touch its local state (page setup, panels,
  // the office export busy indicator). The menu just triggers them.
  onInsertImage: () => void
  onInsertWidget: () => void
  // Saved snippets: open the library to insert one, or capture the selection
  // as a new one. Both are host flows because both open a React dialog.
  onInsertSnippet: () => void
  onSaveSnippet: () => void
  onExportDocx: () => void
  onExportPdf: () => void
  onFind: () => void
  onFocusMode: () => void
  pageView: boolean
  onSetPageView: (v: boolean) => void
  onOutline: () => void
  onComments: () => void
}

export default function DocMenuBar({
  editor,
  title,
  onInsertImage,
  onInsertWidget,
  onInsertSnippet,
  onSaveSnippet,
  onExportDocx,
  onExportPdf,
  onFind,
  onFocusMode,
  pageView,
  onSetPageView,
  onOutline,
  onComments
}: Props): JSX.Element {
  const createBlank = useDocumentsStore((s) => s.createBlank)
  const active = useDocumentsStore((s) => s.active)
  const rename = useDocumentsStore((s) => s.rename)
  const remove = useDocumentsStore((s) => s.remove)
  const goDocument = useViewStore((s) => s.goDocument)
  const goDocuments = useViewStore((s) => s.goDocuments)

  const [wordCountOpen, setWordCountOpen] = useState(false)
  const [a11yOpen, setA11yOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  const chain = (): ReturnType<Editor['chain']> => editor.chain().focus()

  async function newDocument(): Promise<void> {
    const doc = await createBlank('doc')
    goDocument(doc.id)
  }

  async function makeCopy(): Promise<void> {
    // Create a real copy that carries the current body, then open it. The store's
    // active doc holds the live body (kept current by the debounced autosave), so
    // the copy is a faithful duplicate, not an empty document.
    const body = (active?.body ?? undefined) as FbDocument['body'] | undefined
    const copy = await window.api.documents.create({
      docType: 'doc',
      title: `Copy of ${title || 'Untitled document'}`,
      body
    })
    goDocument(copy.id)
  }

  async function doRename(): Promise<void> {
    const next = await promptText({ title: 'Rename document', initial: title, confirmLabel: 'Rename' })
    if (next != null && next.trim()) void rename(next.trim())
  }

  async function moveToTrash(): Promise<void> {
    if (!active) return
    const ok = await confirmDialog({
      title: `Move "${title || 'Untitled document'}" to trash?`,
      body: 'You can restore it from the Documents trash.',
      confirmLabel: 'Move to trash'
    })
    if (!ok) return
    await remove(active.id)
    goDocuments()
  }

  async function exportHtml(): Promise<void> {
    await window.api.exportDoc.html({
      html: editor.getHTML(),
      suggestedName: `${title || 'document'}.html`
    })
  }

  async function insertLink(): Promise<void> {
    const prev = (editor.getAttributes('link').href as string) || ''
    const url = await promptText({ title: 'Link URL', initial: prev, placeholder: 'https://', confirmLabel: 'Set link' })
    if (url == null) return
    if (url.trim() === '') {
      chain().extendMarkRange('link').unsetLink().run()
    } else {
      chain().extendMarkRange('link').setLink({ href: url.trim() }).run()
    }
  }

  async function paste(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText()
      if (text) editor.chain().focus().insertContent(text).run()
    } catch {
      document.execCommand('paste')
    }
  }

  const MENUS: MenuDef[] = [
    {
      id: 'file',
      label: 'File',
      build: () => [
        { kind: 'item', label: 'New document', icon: 'note_add', run: () => void newDocument() },
        { kind: 'item', label: 'Make a copy', icon: 'file_copy', run: () => void makeCopy() },
        { kind: 'sep' },
        { kind: 'item', label: 'Rename', icon: 'edit', run: doRename },
        { kind: 'item', label: 'Version history', icon: 'history', run: () => { if (active) openDocHistory(active.id) } },
        {
          kind: 'submenu',
          label: 'Download',
          icon: 'download',
          items: [
            { kind: 'item', label: 'Microsoft Word (.docx)', run: onExportDocx },
            { kind: 'item', label: 'PDF document (.pdf)', run: onExportPdf },
            { kind: 'item', label: 'Web page (.html)', run: () => void exportHtml() }
          ]
        },
        { kind: 'item', label: 'Print (PDF)', shortcut: '⌘P', icon: 'print', run: onExportPdf },
        { kind: 'sep' },
        { kind: 'item', label: 'Move to trash', icon: 'delete', run: () => void moveToTrash() }
      ]
    },
    {
      id: 'edit',
      label: 'Edit',
      build: () => [
        { kind: 'item', label: 'Undo', shortcut: '⌘Z', icon: 'undo', run: () => chain().undo().run(), disabled: !editor.can().undo() },
        { kind: 'item', label: 'Redo', shortcut: '⌘Y', icon: 'redo', run: () => chain().redo().run(), disabled: !editor.can().redo() },
        { kind: 'sep' },
        { kind: 'item', label: 'Cut', shortcut: '⌘X', run: () => document.execCommand('cut') },
        { kind: 'item', label: 'Copy', shortcut: '⌘C', run: () => document.execCommand('copy') },
        { kind: 'item', label: 'Paste', shortcut: '⌘V', run: () => void paste() },
        { kind: 'sep' },
        { kind: 'item', label: 'Select all', shortcut: '⌘A', run: () => chain().selectAll().run() },
        { kind: 'item', label: 'Find and replace', shortcut: '⌘⇧H', icon: 'search', run: onFind }
      ]
    },
    {
      id: 'view',
      label: 'View',
      build: () => [
        { kind: 'item', label: 'Page view', icon: 'description', run: () => onSetPageView(true), active: pageView },
        { kind: 'item', label: 'Continuous view', icon: 'notes', run: () => onSetPageView(false), active: !pageView },
        { kind: 'sep' },
        { kind: 'item', label: 'Show outline', icon: 'format_list_bulleted', run: onOutline },
        { kind: 'item', label: 'Show comments', icon: 'comment', run: onComments },
        { kind: 'sep' },
        { kind: 'item', label: 'Focus mode', icon: 'fullscreen', run: onFocusMode }
      ]
    },
    {
      id: 'insert',
      label: 'Insert',
      build: () => [
        { kind: 'item', label: 'Image', icon: 'image', run: onInsertImage },
        { kind: 'item', label: 'Table', icon: 'grid_on', run: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
        { kind: 'item', label: 'Table of contents', icon: 'toc', run: () => chain().insertTableOfContents().run() },
        { kind: 'item', label: 'Footnote', icon: 'superscript', run: () => chain().insertFootnote().run() },
        { kind: 'item', label: 'Work widget from a desk', icon: 'widgets', run: onInsertWidget },
        { kind: 'item', label: 'Saved snippet', icon: 'bookmarks', run: onInsertSnippet },
        { kind: 'item', label: 'Link', shortcut: '⌘K', icon: 'link', run: insertLink },
        { kind: 'item', label: 'Horizontal line', icon: 'horizontal_rule', run: () => chain().setHorizontalRule().run() },
        { kind: 'sep' },
        { kind: 'item', label: 'Meeting', icon: 'videocam', run: () => void launchMeeting({ kind: 'doc', id: active?.id ?? '', title: title || 'Document meeting' }) }
      ]
    },
    {
      id: 'format',
      label: 'Format',
      build: () => [
        {
          kind: 'submenu',
          label: 'Text',
          icon: 'format_bold',
          items: [
            { kind: 'item', label: 'Bold', shortcut: '⌘B', run: () => chain().toggleBold().run(), active: editor.isActive('bold') },
            { kind: 'item', label: 'Italic', shortcut: '⌘I', run: () => chain().toggleItalic().run(), active: editor.isActive('italic') },
            { kind: 'item', label: 'Underline', shortcut: '⌘U', run: () => chain().toggleUnderline().run(), active: editor.isActive('underline') },
            { kind: 'item', label: 'Strikethrough', run: () => chain().toggleStrike().run(), active: editor.isActive('strike') }
          ]
        },
        {
          kind: 'submenu',
          label: 'Paragraph styles',
          icon: 'title',
          items: [
            { kind: 'item', label: 'Normal text', run: () => chain().setParagraph().run(), active: editor.isActive('paragraph') },
            { kind: 'item', label: 'Heading 1', run: () => chain().setHeading({ level: 1 }).run(), active: editor.isActive('heading', { level: 1 }) },
            { kind: 'item', label: 'Heading 2', run: () => chain().setHeading({ level: 2 }).run(), active: editor.isActive('heading', { level: 2 }) },
            { kind: 'item', label: 'Heading 3', run: () => chain().setHeading({ level: 3 }).run(), active: editor.isActive('heading', { level: 3 }) }
          ]
        },
        {
          kind: 'submenu',
          label: 'Align',
          icon: 'format_align_left',
          items: [
            { kind: 'item', label: 'Left', run: () => chain().setTextAlign('left').run(), active: editor.isActive({ textAlign: 'left' }) },
            { kind: 'item', label: 'Center', run: () => chain().setTextAlign('center').run(), active: editor.isActive({ textAlign: 'center' }) },
            { kind: 'item', label: 'Right', run: () => chain().setTextAlign('right').run(), active: editor.isActive({ textAlign: 'right' }) },
            { kind: 'item', label: 'Justify', run: () => chain().setTextAlign('justify').run(), active: editor.isActive({ textAlign: 'justify' }) }
          ]
        },
        {
          kind: 'submenu',
          label: 'Bullets & numbering',
          icon: 'format_list_bulleted',
          items: [
            { kind: 'item', label: 'Bulleted list', run: () => chain().toggleBulletList().run(), active: editor.isActive('bulletList') },
            { kind: 'item', label: 'Numbered list', run: () => chain().toggleOrderedList().run(), active: editor.isActive('orderedList') },
            { kind: 'item', label: 'Checklist', run: () => chain().toggleTaskList().run(), active: editor.isActive('taskList') }
          ]
        },
        { kind: 'sep' },
        { kind: 'item', label: 'Clear formatting', shortcut: '⌘\\', icon: 'format_clear', run: () => chain().unsetAllMarks().clearNodes().run() }
      ]
    },
    {
      id: 'tools',
      label: 'Tools',
      build: () => [
        { kind: 'item', label: 'Word count', shortcut: '⌘⇧C', icon: 'tag', run: () => setWordCountOpen(true) },
        { kind: 'item', label: 'Check accessibility', icon: 'accessibility_new', run: () => setA11yOpen(true) },
        { kind: 'sep' },
        {
          kind: 'item',
          label: 'Save selection as snippet',
          icon: 'bookmark_add',
          hint: 'Keep it for reuse in any document',
          run: onSaveSnippet
        }
      ]
    },
    {
      id: 'help',
      label: 'Help',
      build: () => [
        { kind: 'item', label: 'Keyboard shortcuts', shortcut: '⌘/', icon: 'keyboard', run: () => setShortcutsOpen(true) }
      ]
    }
  ]

  return (
    <>
      <MenuBarShell menus={MENUS} testid="doc-menubar" itemTestid="doc-menu" />
      {wordCountOpen && <WordCountModal editor={editor} onClose={() => setWordCountOpen(false)} />}
      {a11yOpen && <A11yModal editor={editor} onClose={() => setA11yOpen(false)} />}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
    </>
  )
}

function WordCountModal({ editor, onClose }: { editor: Editor; onClose: () => void }): JSX.Element {
  const text = editor.getText()
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const characters = text.length
  const charactersNoSpaces = text.replace(/\s/g, '').length
  const rows: [string, number][] = [
    ['Words', words],
    ['Characters', characters],
    ['Characters excluding spaces', charactersNoSpaces]
  ]
  return (
    <MenuModal width={320} title="Word count" onClose={onClose}>
      <div className="space-y-1.5">
        {rows.map(([label, n]) => (
          <div key={label} className="flex items-center justify-between text-[13px]">
            <span className="text-[var(--ink-50)]">{label}</span>
            <span className="font-medium fb-tabular text-[var(--ink-90)]">{n.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </MenuModal>
  )
}

function A11yModal({ editor, onClose }: { editor: Editor; onClose: () => void }): JSX.Element {
  const issues = checkDocA11y(editor.getJSON())
  return (
    <MenuModal width={320} title="Accessibility check" onClose={onClose}>
      {issues.length === 0 ? (
        <div className="flex items-center gap-2 text-[13px] text-emerald-600" data-testid="doc-a11y-clean">
          <Icon name="check_circle" size={16} />
          <span>No accessibility issues found.</span>
        </div>
      ) : (
        <div className="space-y-2" data-testid="doc-a11y-issues">
          {issues.map((it, i) => (
            <div key={i} className="flex items-start gap-2 text-[12px]" data-testid="doc-a11y-issue">
              <Icon
                name={it.severity === 'error' ? 'error' : 'warning'}
                size={15}
                className={it.severity === 'error' ? 'text-rose-500 shrink-0 mt-0.5' : 'text-amber-500 shrink-0 mt-0.5'}
              />
              <span className="text-[var(--ink-70)]">{it.message}</span>
            </div>
          ))}
        </div>
      )}
    </MenuModal>
  )
}

function ShortcutsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const rows: [string, string][] = [
    ['Bold', '⌘B'],
    ['Italic', '⌘I'],
    ['Underline', '⌘U'],
    ['Insert link', '⌘K'],
    ['Undo', '⌘Z'],
    ['Redo', '⌘Y'],
    ['Find and replace', '⌘⇧H'],
    ['Clear formatting', '⌘\\']
  ]
  return (
    <MenuModal width={320} title="Keyboard shortcuts" onClose={onClose}>
      <div className="space-y-1.5">
        {rows.map(([label, keys]) => (
          <div key={label} className="flex items-center justify-between text-[13px]">
            <span className="text-[var(--ink-70)]">{label}</span>
            <span className="text-[var(--ink-40)] fb-tabular">{keys}</span>
          </div>
        ))}
      </div>
    </MenuModal>
  )
}
