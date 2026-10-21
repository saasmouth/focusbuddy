import { useState } from 'react'
import { openDocHistory } from '../DocHistoryPanel'
import { confirmDialog, promptText } from '../../plexi/PromptDialog'
import type { FbDocument } from '@shared/types'
import { useDocumentsStore } from '../../../stores/documents'
import { useViewStore } from '../../../stores/view'
import { launchMeeting } from '../../../lib/startMeeting'
import { MenuBarShell, MenuModal, type MenuDef } from './menuBarKit'

// A Google-Slides-style menu bar for the deck editor. Menus reflect what a
// presentation actually does: slides, elements on a slide, layout/arrangement,
// and presenting. Every item is wired to a real SlidesEditor op or a
// documents-store action.

export interface SlideAlign {
  dir: 'left' | 'centerX' | 'right' | 'top' | 'middleY' | 'bottom'
}

export interface SlidesMenuActions {
  title: string
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  present: () => void
  checkA11y: () => void
  newSlide: () => void
  deleteSlide: () => void
  moveSlideUp: () => void
  moveSlideDown: () => void
  duplicateSelection: () => void
  /** Copy this slide, with everything on it, straight after itself. */
  duplicateSlide: () => void
  // The same three functions the DOM clipboard events run, so Edit › Copy and
  // ⌘C cannot drift apart.
  copySelection: () => void
  cutSelection: () => void
  pasteClipboard: () => void
  canPaste: boolean
  hasSelection: boolean
  deleteSelection: () => void
  insertText: () => void
  insertImage: () => void
  insertShape: (shape: 'rect' | 'ellipse' | 'roundRect' | 'triangle') => void
  insertLine: () => void
  insertWidget: () => void
  insertChart: () => void
  insertTable: () => void
  align: (dir: SlideAlign['dir']) => void
  group: () => void
  ungroup: () => void
  exportFile: (format: 'pptx' | 'pdf') => void
  importFile: () => void
}

export default function SlidesMenuBar({ actions }: { actions: SlidesMenuActions }): JSX.Element {
  const a = actions
  const createBlank = useDocumentsStore((s) => s.createBlank)
  const active = useDocumentsStore((s) => s.active)
  const rename = useDocumentsStore((s) => s.rename)
  const remove = useDocumentsStore((s) => s.remove)
  const goDocument = useViewStore((s) => s.goDocument)
  const goDocuments = useViewStore((s) => s.goDocuments)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  async function newDeck(): Promise<void> {
    const doc = await createBlank('slides')
    goDocument(doc.id)
  }
  async function makeCopy(): Promise<void> {
    const body = (active?.body ?? undefined) as FbDocument['body'] | undefined
    const copy = await window.api.documents.create({
      docType: 'slides',
      title: `Copy of ${a.title || 'Untitled deck'}`,
      body
    })
    goDocument(copy.id)
  }
  async function doRename(): Promise<void> {
    const next = await promptText({ title: 'Rename presentation', initial: a.title, confirmLabel: 'Rename' })
    if (next != null && next.trim()) void rename(next.trim())
  }
  async function moveToTrash(): Promise<void> {
    if (!active) return
    const ok = await confirmDialog({
      title: `Move "${a.title || 'Untitled deck'}" to trash?`,
      body: 'You can restore it from the Documents trash.',
      confirmLabel: 'Move to trash'
    })
    if (!ok) return
    await remove(active.id)
    goDocuments()
  }

  const menus: MenuDef[] = [
    {
      id: 'file',
      label: 'File',
      build: () => [
        { kind: 'item', label: 'New presentation', icon: 'note_add', run: () => void newDeck() },
        { kind: 'item', label: 'Make a copy', icon: 'file_copy', run: () => void makeCopy() },
        { kind: 'sep' },
        { kind: 'item', label: 'Rename', icon: 'edit', run: doRename },
        { kind: 'item', label: 'Version history', icon: 'history', run: () => { if (active) openDocHistory(active.id) } },
        { kind: 'item', label: 'Import (.pptx)', icon: 'upload', run: a.importFile },
        {
          kind: 'submenu',
          label: 'Download',
          icon: 'download',
          items: [
            { kind: 'item', label: 'PowerPoint (.pptx)', run: () => a.exportFile('pptx') },
            { kind: 'item', label: 'PDF document (.pdf)', run: () => a.exportFile('pdf') }
          ]
        },
        { kind: 'sep' },
        { kind: 'item', label: 'Move to trash', icon: 'delete', run: () => void moveToTrash() }
      ]
    },
    {
      id: 'edit',
      label: 'Edit',
      build: () => [
        { kind: 'item', label: 'Undo', shortcut: '⌘Z', icon: 'undo', run: a.undo, disabled: !a.canUndo },
        { kind: 'item', label: 'Redo', shortcut: '⌘Y', icon: 'redo', run: a.redo, disabled: !a.canRedo },
        { kind: 'sep' },
        { kind: 'item', label: 'Cut', shortcut: '⌘X', icon: 'content_cut', run: a.cutSelection, disabled: !a.hasSelection },
        { kind: 'item', label: 'Copy', shortcut: '⌘C', icon: 'content_copy', run: a.copySelection, disabled: !a.hasSelection },
        { kind: 'item', label: 'Paste', shortcut: '⌘V', icon: 'content_paste', run: a.pasteClipboard, disabled: !a.canPaste },
        { kind: 'item', label: 'Duplicate selection', shortcut: '⌘D', icon: 'file_copy', run: a.duplicateSelection, disabled: !a.hasSelection },
        { kind: 'item', label: 'Delete selection', shortcut: '⌫', icon: 'delete', run: a.deleteSelection }
      ]
    },
    {
      id: 'view',
      label: 'View',
      build: () => [
        { kind: 'item', label: 'Present', shortcut: '▶', icon: 'play_arrow', run: a.present },
        { kind: 'item', label: 'Check accessibility', icon: 'accessibility_new', run: a.checkA11y }
      ]
    },
    {
      id: 'insert',
      label: 'Insert',
      build: () => [
        { kind: 'item', label: 'Text box', icon: 'title', run: a.insertText },
        { kind: 'item', label: 'Image', icon: 'image', run: a.insertImage },
        {
          kind: 'submenu',
          label: 'Shape',
          icon: 'category',
          items: [
            { kind: 'item', label: 'Rectangle', run: () => a.insertShape('rect') },
            { kind: 'item', label: 'Rounded rectangle', run: () => a.insertShape('roundRect') },
            { kind: 'item', label: 'Ellipse', run: () => a.insertShape('ellipse') },
            { kind: 'item', label: 'Triangle', run: () => a.insertShape('triangle') }
          ]
        },
        { kind: 'item', label: 'Line', icon: 'horizontal_rule', run: a.insertLine },
        { kind: 'item', label: 'Chart', icon: 'bar_chart', run: a.insertChart },
        { kind: 'item', label: 'Table', icon: 'table_chart', run: a.insertTable },
        { kind: 'item', label: 'Work widget from a desk', icon: 'widgets', run: a.insertWidget },
        { kind: 'sep' },
        { kind: 'item', label: 'Meeting', icon: 'videocam', run: () => void launchMeeting({ kind: 'slides', id: active?.id ?? '', title: a.title || 'Presentation meeting' }) }
      ]
    },
    {
      id: 'slide',
      label: 'Slide',
      build: () => [
        { kind: 'item', label: 'New slide', icon: 'add', run: a.newSlide },
        { kind: 'item', label: 'Duplicate slide', icon: 'file_copy', run: a.duplicateSlide },
        { kind: 'item', label: 'Delete slide', icon: 'delete', run: a.deleteSlide },
        { kind: 'sep' },
        { kind: 'item', label: 'Move slide up', icon: 'arrow_upward', run: a.moveSlideUp },
        { kind: 'item', label: 'Move slide down', icon: 'arrow_downward', run: a.moveSlideDown }
      ]
    },
    {
      id: 'format',
      label: 'Format',
      build: () => [
        {
          kind: 'submenu',
          label: 'Align',
          icon: 'format_align_left',
          items: [
            { kind: 'item', label: 'Left', run: () => a.align('left') },
            { kind: 'item', label: 'Center', run: () => a.align('centerX') },
            { kind: 'item', label: 'Right', run: () => a.align('right') },
            { kind: 'item', label: 'Top', run: () => a.align('top') },
            { kind: 'item', label: 'Middle', run: () => a.align('middleY') },
            { kind: 'item', label: 'Bottom', run: () => a.align('bottom') }
          ]
        },
        { kind: 'sep' },
        { kind: 'item', label: 'Group', shortcut: '⌘G', icon: 'group_work', run: a.group },
        { kind: 'item', label: 'Ungroup', shortcut: '⌘⇧G', icon: 'category', run: a.ungroup }
      ]
    },
    {
      id: 'help',
      label: 'Help',
      build: () => [{ kind: 'item', label: 'Keyboard shortcuts', shortcut: '⌘/', icon: 'keyboard', run: () => setShortcutsOpen(true) }]
    }
  ]

  return (
    <>
      <MenuBarShell menus={menus} testid="slides-menubar" />
      {shortcutsOpen && (
        <MenuModal title="Keyboard shortcuts" onClose={() => setShortcutsOpen(false)}>
          <div className="space-y-1.5">
            {([
              ['Undo', '⌘Z'],
              ['Redo', '⌘⇧Z'],
              ['Duplicate', '⌘D'],
              ['Group', '⌘G'],
              ['Ungroup', '⌘⇧G'],
              ['Present', '▶']
            ] as [string, string][]).map(([label, keys]) => (
              <div key={label} className="flex items-center justify-between text-[13px]">
                <span className="text-[var(--ink-70)]">{label}</span>
                <span className="text-[var(--ink-40)] fb-tabular">{keys}</span>
              </div>
            ))}
          </div>
        </MenuModal>
      )}
    </>
  )
}
