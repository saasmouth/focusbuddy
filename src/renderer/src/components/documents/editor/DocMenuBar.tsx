import { useState } from 'react'
import { promptText } from '../../plexi/PromptDialog'
import type { Editor } from '@tiptap/react'
import type { DocumentOps } from './documentOps'
import Icon from '../../Icon'
import { checkDocA11y } from '../../../lib/docA11y'
import { MenuBarShell, MenuModal, type MenuDef, type MenuItem } from './menuBarKit'
import { menuPasteIntoDoc } from './docSnippets'
import { menuAction } from '../../../lib/menus/menuAction'

// A Google-Docs-style menu bar for the document editor: File / Edit / View /
// Insert / Format / Tools / Help, each a dropdown of real actions. Every item is
// wired to a genuine capability — Tiptap editor commands, the document ops the
// HOST binds, or the office export IPC. Nothing here is a decorative no-op; an
// action that the editor cannot do is simply not listed.
//
// This file does not read the documents store, and must not: it used to act on
// the store's `active` document, which in a desk widget is not the document on
// screen (see documentOps). Enforced by tests/unit/documentOpsGuard.test.ts.
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
  onFindReplace: () => void
  onFocusMode: () => void
  pageView: boolean
  onSetPageView: (v: boolean) => void
  onOutline: () => void
  onComments: () => void
  /**
   * The document on screen, bound to its id by whichever host mounted this
   * editor. Absent where there is no document — a snippet session — and then
   * none of the document items are shown at all.
   */
  documentOps?: DocumentOps
}

export default function DocMenuBar({
  editor,
  title,
  documentOps,
  onInsertImage,
  onInsertWidget,
  onInsertSnippet,
  onSaveSnippet,
  onExportDocx,
  onExportPdf,
  onFind,
  onFindReplace,
  onFocusMode,
  pageView,
  onSetPageView,
  onOutline,
  onComments
}: Props): JSX.Element {
  const [wordCountOpen, setWordCountOpen] = useState(false)
  const [a11yOpen, setA11yOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  const chain = (): ReturnType<Editor['chain']> => editor.chain().focus()

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
    // Another of our apps' content, or a picture, lands converted (as a
    // snippet of it would); text keeps the menu's own paste below.
    if ((await menuPasteIntoDoc(editor).catch(() => null)) !== null) return
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
      build: () => {
        // Each of these acts on a document, so the whole group is ABSENT without
        // ops rather than disabled. Download and Print are not here: they act on
        // the editor's own content and work with no document at all.
        const ops = documentOps
        const docGroup: MenuItem[] = ops
          ? [
              { kind: 'item', label: 'New document', icon: 'note_add', run: () => void ops.newDocument() },
              { kind: 'item', label: 'Make a copy', icon: 'file_copy', run: () => void ops.makeCopy() },
              { kind: 'sep' },
              { kind: 'item', label: 'Rename', icon: 'edit', run: () => void ops.rename() },
              { kind: 'item', label: 'Version history', icon: 'history', run: () => ops.openHistory() }
            ]
          : []
        // The separator belongs to Move to trash, so it leaves with it; left
        // behind, the menu would end on a divider with nothing under it.
        const trashGroup: MenuItem[] = ops
          ? [
              { kind: 'sep' },
              { kind: 'item', ...menuAction('moveToTrash'), icon: 'delete', run: () => void ops.moveToTrash() }
            ]
          : []
        return [
          ...docGroup,
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
          { kind: 'item', label: 'Print (PDF)', icon: 'print', run: onExportPdf },
          ...trashGroup
        ]
      }
    },
    {
      id: 'edit',
      label: 'Edit',
      build: () => [
        { kind: 'item', ...menuAction('undo'), icon: 'undo', run: () => chain().undo().run(), disabled: !editor.can().undo() },
        { kind: 'item', ...menuAction('redo'), icon: 'redo', run: () => chain().redo().run(), disabled: !editor.can().redo() },
        { kind: 'sep' },
        { kind: 'item', ...menuAction('cut'), icon: 'content_cut', run: () => document.execCommand('cut') },
        { kind: 'item', ...menuAction('copy'), icon: 'content_copy', run: () => document.execCommand('copy') },
        { kind: 'item', ...menuAction('paste'), icon: 'content_paste', run: () => void paste() },
        { kind: 'sep' },
        { kind: 'item', ...menuAction('selectAll'), icon: 'select_all', run: () => chain().selectAll().run() },
        { kind: 'item', ...menuAction('find'), icon: 'search', run: onFind },
        { kind: 'item', ...menuAction('findAndReplace'), icon: 'find_replace', run: onFindReplace },
        // Save selection as snippet… belongs to Edit in every office app (SPEC §9.2; it was under Tools).
        { kind: 'sep' },
        { kind: 'item', ...menuAction('saveAsSnippet'), icon: 'bookmark_add', hint: 'Keep it for reuse in any document', run: onSaveSnippet }
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
        { kind: 'item', label: 'Link', shortcut: '⌘K', icon: 'link', run: insertLink },
        { kind: 'item', label: 'Horizontal line', icon: 'horizontal_rule', run: () => chain().setHorizontalRule().run() },
        // The shared tail (SPEC §9.2): Insert snippet… · Work widget from a desk…, then Meeting.
        { kind: 'sep' },
        { kind: 'item', ...menuAction('insertSnippet'), icon: 'bookmarks', run: onInsertSnippet },
        { kind: 'item', ...menuAction('workWidgetFromDesk'), icon: 'widgets', run: onInsertWidget },
        // A meeting is the one item here that reaches other people, so a wrong
        // id invites them to someone else's document. It went out with
        // `id: active?.id ?? ''` — the wrong document, or none at all.
        ...(documentOps
          ? ([
              { kind: 'sep' },
              { kind: 'item', ...menuAction('meeting'), icon: 'videocam', run: () => documentOps.startMeeting() }
            ] as MenuItem[])
          : [])
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
        { kind: 'item', label: 'Word count', icon: 'tag', run: () => setWordCountOpen(true) },
        { kind: 'item', label: 'Check accessibility', icon: 'accessibility_new', run: () => setA11yOpen(true) }
      ]
    },
    {
      id: 'help',
      label: 'Help',
      build: () => [
        { kind: 'item', ...menuAction('keyboardShortcuts'), icon: 'keyboard', run: () => setShortcutsOpen(true) }
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
    [menuAction('redo').label, menuAction('redo').shortcut!],
    [menuAction('find').label, menuAction('find').shortcut!],
    [menuAction('findAndReplace').label, menuAction('findAndReplace').shortcut!],
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
