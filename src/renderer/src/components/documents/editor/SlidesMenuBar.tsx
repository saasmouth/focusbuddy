import { useState } from 'react'
import type { DocumentOps } from './documentOps'
import { menuAction } from '../../../lib/menus/menuAction'
import { documentCommands, menuItemOf } from '../../../lib/menus/officeCommand'
import type { DeckCommands } from '../slides/deckCommands'
import { MenuBarShell, MenuModal, type MenuDef, type MenuItem } from './menuBarKit'

// A Google-Slides-style menu bar for the deck editor. Menus reflect what a
// presentation actually does: slides, elements on a slide, layout/arrangement,
// and presenting. Every item is wired to a real SlidesEditor op, or to the
// DocumentOps the host bound to the document on screen (never the documents
// store's `active`, which in a desk widget is some other document).

export interface SlideAlign {
  dir: 'left' | 'centerX' | 'right' | 'top' | 'middleY' | 'bottom'
}

export interface SlidesMenuActions {
  title: string
  /** The editor's commands (slides/deckCommands): every shared row renders from them. */
  cmds: DeckCommands
  /** False while editing a single-slide fragment (a slide snippet): slide-level items are disabled. */
  slideOps?: boolean
  /**
   * The document on screen, bound by the host (createDocumentOps). Absent when
   * the deck is not a document (a slide snippet session): then New, Make a copy,
   * Rename, Version history, Import, Move to Trash and Insert › Meeting are not
   * shown at all. Download (a file, no row) always stays.
   */
  documentOps?: DocumentOps
  /** The two shapes without a command of their own (Rectangle and Ellipse have one). */
  insertShape: (shape: 'rect' | 'ellipse' | 'roundRect' | 'triangle') => void
  moveSlideUp: () => void
  moveSlideDown: () => void
}

export default function SlidesMenuBar({ actions }: { actions: SlidesMenuActions }): JSX.Element {
  const a = actions
  const ops = a.documentOps
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // Every shared row is the editor's command (slides/deckCommands): the ribbon,
  // the right-click menu and the palette render the same one.
  const c = a.cmds
  const doc = documentCommands(ops, 'slides')
  // Import replaces the EDITOR's deck and goes out through onChange, so the host
  // persists it to the right document: an editor command, not a document op.
  // Hidden only on a single slide (a snippet), where a whole .pptx has no home.
  const importItem: MenuItem[] = a.slideOps === false ? [] : [menuItemOf(c.importPptx, { icon: 'upload' })]
  const download: MenuItem = {
    kind: 'submenu',
    label: menuAction('download').label,
    icon: 'download',
    items: [menuItemOf(c.downloadPptx, { inSubmenu: true, icon: undefined }), menuItemOf(c.downloadPdf, { inSubmenu: true, icon: undefined })]
  }

  const menus: MenuDef[] = [
    {
      id: 'file',
      label: 'File',
      build: () =>
        doc
          ? [
              menuItemOf(doc.newDocument),
              menuItemOf(doc.makeCopy),
              { kind: 'sep' },
              menuItemOf(doc.rename),
              menuItemOf(doc.versionHistory),
              ...importItem,
              ...(doc.print ? [menuItemOf(doc.print)] : []),
              download,
              { kind: 'sep' },
              menuItemOf(doc.moveToTrash)
            ]
          : [...importItem, download]
    },
    {
      id: 'edit',
      label: 'Edit',
      build: () => [
        menuItemOf(c.undo),
        menuItemOf(c.redo),
        { kind: 'sep' },
        menuItemOf(c.cut),
        menuItemOf(c.copy),
        menuItemOf(c.paste),
        menuItemOf(c.duplicate),
        menuItemOf(c.remove),
        { kind: 'sep' },
        menuItemOf(c.selectAll),
        { kind: 'sep' },
        menuItemOf(c.find),
        menuItemOf(c.findAndReplace),
        { kind: 'sep' },
        menuItemOf(c.saveSnippet)
      ]
    },
    {
      id: 'view',
      label: 'View',
      build: () => [menuItemOf(c.present), menuItemOf(c.checkA11y)]
    },
    {
      id: 'insert',
      label: 'Insert',
      build: () => [
        menuItemOf(c.insertText),
        menuItemOf(c.insertImage),
        {
          kind: 'submenu',
          label: 'Shape',
          icon: 'category',
          items: [
            menuItemOf(c.insertRect, { icon: undefined }),
            { kind: 'item', label: 'Rounded rectangle', run: () => a.insertShape('roundRect') },
            menuItemOf(c.insertEllipse, { icon: undefined }),
            { kind: 'item', label: 'Triangle', run: () => a.insertShape('triangle') }
          ]
        },
        menuItemOf(c.insertLine),
        menuItemOf(c.insertChart),
        menuItemOf(c.insertTable),
        { kind: 'sep' },
        menuItemOf(c.insertSnippet),
        menuItemOf(c.insertWidget),
        ...(doc ? [{ kind: 'sep' as const }, menuItemOf(doc.meeting)] : [])
      ]
    },
    {
      id: 'slide',
      label: 'Slide',
      build: () => [
        menuItemOf(c.newSlide),
        menuItemOf(c.duplicateSlide),
        menuItemOf(c.deleteSlide),
        { kind: 'sep' },
        { kind: 'item', label: 'Move slide up', icon: 'arrow_upward', run: a.moveSlideUp, disabled: a.slideOps === false, hint: a.slideOps === false ? 'Not in a single-slide snippet' : undefined },
        { kind: 'item', label: 'Move slide down', icon: 'arrow_downward', run: a.moveSlideDown, disabled: a.slideOps === false, hint: a.slideOps === false ? 'Not in a single-slide snippet' : undefined }
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
          items: [c.alignLeft, c.alignCentreX, c.alignRight, c.alignTop, c.alignMiddleY, c.alignBottom].map((x) => menuItemOf(x, { icon: undefined }))
        },
        {
          kind: 'submenu',
          label: 'Distribute',
          icon: 'horizontal_distribute',
          items: [menuItemOf(c.distributeH, { icon: undefined }), menuItemOf(c.distributeV, { icon: undefined })]
        },
        { kind: 'sep' },
        menuItemOf(c.group),
        menuItemOf(c.ungroup)
      ]
    },
    {
      id: 'help',
      label: 'Help',
      build: () => [{ kind: 'item', ...menuAction('keyboardShortcuts'), icon: 'keyboard', run: () => setShortcutsOpen(true) }]
    }
  ]

  return (
    <>
      <MenuBarShell menus={menus} testid="slides-menubar" />
      {shortcutsOpen && (
        <MenuModal title="Keyboard shortcuts" onClose={() => setShortcutsOpen(false)}>
          <div className="space-y-1.5">
            {([
              [menuAction('undo').label, menuAction('undo').shortcut!],
              [menuAction('redo').label, menuAction('redo').shortcut!],
              [menuAction('duplicate').label, menuAction('duplicate').shortcut!],
              [menuAction('find').label, menuAction('find').shortcut!],
              [menuAction('findAndReplace').label, menuAction('findAndReplace').shortcut!],
              [menuAction('group').label, menuAction('group').shortcut!],
              [menuAction('ungroup').label, menuAction('ungroup').shortcut!]
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
