import { useEffect, useRef, useState } from 'react'
import { openDocHistory } from '../DocHistoryPanel'
import { confirmDialog, promptText } from '../../plexi/PromptDialog'
import type { Editor } from '@tiptap/react'
import { useDocumentsStore } from '../../../stores/documents'
import { useViewStore } from '../../../stores/view'
import { launchMeeting } from '../../../lib/startMeeting'
import type { FbDocument } from '@shared/types'
import Icon from '../../Icon'
import { checkDocA11y } from '../../../lib/docA11y'

// A Google-Docs-style menu bar for the document editor: File / Edit / View /
// Insert / Format / Tools / Help, each a dropdown of real actions. Every item is
// wired to a genuine capability — Tiptap editor commands, the documents store, or
// the office export IPC. Nothing here is a decorative no-op; an action that the
// editor cannot do is simply not listed.

type Item =
  | { kind: 'item'; label: string; shortcut?: string; icon?: string; run: () => void; disabled?: boolean; active?: boolean }
  | { kind: 'sep' }
  | { kind: 'submenu'; label: string; icon?: string; items: Item[] }

interface MenuDef {
  id: string
  label: string
  build: () => Item[]
}

interface Props {
  editor: Editor
  title: string
  // DocEditor owns these because they touch its local state (page setup, panels,
  // the office export busy indicator). The menu just triggers them.
  onInsertImage: () => void
  onInsertWidget: () => void
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

  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [wordCountOpen, setWordCountOpen] = useState(false)
  const [a11yOpen, setA11yOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)

  // Close the open dropdown on an outside click or Escape.
  useEffect(() => {
    if (!openMenu) return
    function onDoc(e: MouseEvent): void {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpenMenu(null)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [openMenu])

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
        { kind: 'item', label: 'Check accessibility', icon: 'accessibility_new', run: () => setA11yOpen(true) }
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

  function runItem(run: () => void): void {
    setOpenMenu(null)
    run()
  }

  return (
    <div ref={barRef} className="relative flex items-center gap-0.5 select-none" data-testid="doc-menubar">
      {MENUS.map((menu) => (
        <div key={menu.id} className="relative">
          <button
            onClick={() => setOpenMenu((cur) => (cur === menu.id ? null : menu.id))}
            onMouseEnter={() => setOpenMenu((cur) => (cur ? menu.id : cur))}
            data-testid={`doc-menu-${menu.id}`}
            className={`px-2 py-0.5 rounded text-[13px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] ${
              openMenu === menu.id ? 'bg-[var(--surface-sunken)]' : ''
            }`}
          >
            {menu.label}
          </button>
          {openMenu === menu.id && (
            <MenuDropdown items={menu.build()} onRun={runItem} testid={`doc-menu-${menu.id}-list`} />
          )}
        </div>
      ))}

      {wordCountOpen && <WordCountModal editor={editor} onClose={() => setWordCountOpen(false)} />}
      {a11yOpen && <A11yModal editor={editor} onClose={() => setA11yOpen(false)} />}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
    </div>
  )
}

function MenuDropdown({
  items,
  onRun,
  testid
}: {
  items: Item[]
  onRun: (run: () => void) => void
  testid?: string
}): JSX.Element {
  return (
    <div
      className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute left-0 top-full mt-0.5 z-40 min-w-[220px] py-1"
      data-testid={testid}
    >
      {items.map((it, i) => {
        if (it.kind === 'sep') return <div key={i} className="my-1 border-t border-[var(--edge-soft)]" />
        if (it.kind === 'submenu') return <SubmenuRow key={i} label={it.label} icon={it.icon} items={it.items} onRun={onRun} />
        return (
          <button
            key={i}
            onClick={() => !it.disabled && onRun(it.run)}
            disabled={it.disabled}
            className={`flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-left ${
              it.disabled
                ? 'text-[var(--ink-30)] cursor-default'
                : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
            }`}
          >
            <span className="w-4 shrink-0 text-[var(--ink-50)]">
              {it.active ? <Icon name="check" size={15} /> : it.icon ? <Icon name={it.icon} size={15} /> : null}
            </span>
            <span className="flex-1 min-w-0 truncate">{it.label}</span>
            {it.shortcut && <span className="text-[11px] text-[var(--ink-40)] fb-tabular">{it.shortcut}</span>}
          </button>
        )
      })}
    </div>
  )
}

function SubmenuRow({
  label,
  icon,
  items,
  onRun
}: {
  label: string
  icon?: string
  items: Item[]
  onRun: (run: () => void) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-left text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]">
        <span className="w-4 shrink-0 text-[var(--ink-50)]">{icon ? <Icon name={icon} size={15} /> : null}</span>
        <span className="flex-1 min-w-0 truncate">{label}</span>
        <Icon name="chevron_right" size={15} className="text-[var(--ink-40)] shrink-0" />
      </button>
      {open && (
        <div className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute left-full top-0 -mt-1 ml-0.5 z-50 min-w-[210px] py-1">
          {items.map((it, i) => {
            if (it.kind !== 'item') return null
            return (
              <button
                key={i}
                onClick={() => onRun(it.run)}
                className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-left text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
              >
                <span className="w-4 shrink-0 text-[var(--ink-50)]">{it.active ? <Icon name="check" size={15} /> : null}</span>
                <span className="flex-1 min-w-0 truncate">{it.label}</span>
                {it.shortcut && <span className="text-[11px] text-[var(--ink-40)] fb-tabular">{it.shortcut}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
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
    <Modal title="Word count" onClose={onClose}>
      <div className="space-y-1.5">
        {rows.map(([label, n]) => (
          <div key={label} className="flex items-center justify-between text-[13px]">
            <span className="text-[var(--ink-50)]">{label}</span>
            <span className="font-medium fb-tabular text-[var(--ink-90)]">{n.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </Modal>
  )
}

function A11yModal({ editor, onClose }: { editor: Editor; onClose: () => void }): JSX.Element {
  const issues = checkDocA11y(editor.getJSON())
  return (
    <Modal title="Accessibility check" onClose={onClose}>
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
    </Modal>
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
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <div className="space-y-1.5">
        {rows.map(([label, keys]) => (
          <div key={label} className="flex items-center justify-between text-[13px]">
            <span className="text-[var(--ink-70)]">{label}</span>
            <span className="text-[var(--ink-40)] fb-tabular">{keys}</span>
          </div>
        ))}
      </div>
    </Modal>
  )
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }): JSX.Element {
  return (
    <div className="fb-scrim fixed inset-0 z-[60] flex items-center justify-center" onMouseDown={onClose}>
      <div
        className="fb-card w-[320px] p-4"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[14px] font-semibold text-[var(--ink-90)]">{title}</h3>
          <button onClick={onClose} className="icon-btn" title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
