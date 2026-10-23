import { useState } from 'react'
// No documents store, no view store, no meeting or history helpers here: every
// document action comes from the host through DocumentOps, bound to the
// document actually on screen (documentOps.ts, and the guard test that keeps
// this list of imports honest).
import { MenuBarShell, MenuModal, type MenuDef } from './menuBarKit'
import type { DocumentOps } from './documentOps'
import { menuAction } from '../../../lib/menus/menuAction'

// A menu bar for PlexiDesign — the free-form page designer. Its menus fit what a
// layout program does: place text frames, shapes, lines and images anywhere on
// the page; thread a story through linked frames; set margins, columns, guides
// and master pages; and send the result to print with bleed and crop marks.
// Every item is wired to a real DesignEditor op or a documents-store action.

export interface DesignMenuActions {
  title: string
  undo: () => void
  redo: () => void
  deleteSelected: () => void
  addText: () => void
  addShape: (shape: 'rect' | 'ellipse' | 'roundRect' | 'triangle') => void
  addLine: () => void
  addImageFromFile: () => void
  addWidget: () => void
  removeBgSelected: () => void
  exportAs: (format: 'png' | 'pdf') => void
  // ── Page layout ────────────────────────────────────────────────────────────
  openLayout: () => void
  addPage: () => void
  toggleFacing: () => void
  facing: boolean
  addMaster: () => void
  editMaster: (id: string | null) => void
  masters: Array<{ id: string; name: string }>
  editingMasterId: string | null
  linkFrames: () => void
  unlinkFrame: () => void
  canLink: boolean
  canUnlink: boolean
  insertPageNumber: () => void
  toggleAids: () => void
  aidsVisible: boolean
  exportPrint: () => void
  /** Open the print check: what would go wrong on press, measured. */
  openPreflight: () => void
  /** Open the named styles: the sheet the whole document sets by. */
  openStyles: () => void
  /** Open the palette: named colours and spot inks. */
  openSwatches: () => void
  // ── Clipboard ──────────────────────────────────────────────────────────────
  // The same three functions the DOM clipboard events run, so Edit › Copy and
  // ⌘C cannot drift apart.
  copySelection: () => void
  cutSelection: () => void
  pasteClipboard: () => void
  /** Whether a menu-driven paste has anything to paste. */
  canPaste: boolean
  duplicateSelection: () => void
  /** Select everything a person could click on the page being edited. */
  selectAll: () => void
  /** Open Find… (⌘F) over every piece of text in the design. */
  find: () => void
  /** Open the same panel with its Replace row showing (⇧⌘H). */
  findAndReplace: () => void
  /** Save the selected elements as a reusable snippet. */
  saveSelectionAsSnippet: () => void
  /** Open the saved-snippets library to insert one onto the page being edited. */
  insertSnippet: () => void
  /** Something is selected on the page, so the selection items are live. */
  hasSelection: boolean
  /** Copy the current page, with everything on it, and put it straight after. */
  duplicatePage: (index: number) => void
  /** Which page is showing, for the page items. */
  activePage: number
  /**
   * The print check's standing verdict ("Ready to print", "2 warnings"), shown
   * on the menu item itself. InDesign keeps preflight in the status bar for a
   * reason: a check you have to remember to run is a check nobody runs.
   */
  preflightHint?: string
}

export default function DesignMenuBar({
  actions,
  documentOps
}: {
  actions: DesignMenuActions
  /**
   * The document on screen, bound BY THE HOST (documentOps.ts). This menu bar
   * reads no store: it used to act on the documents store's `active`, which in
   * a desk widget is whatever Documents last opened — so Move to trash trashed
   * a DIFFERENT document, silently, in public 4.3.33.
   *
   * Absent (a snippet session, which has no document) means the document items
   * are not offered at all. Absent, not disabled: there is nothing for them to
   * act on, and a greyed Move to trash invites a second look for a reason that
   * does not exist.
   */
  documentOps?: DocumentOps
}): JSX.Element {
  const a = actions
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  const menus: MenuDef[] = [
    {
      id: 'file',
      label: 'File',
      build: () => [
        // Every document item acts through the host's ops, BY ID. With no
        // document bound (a snippet session) they are absent; Download stays,
        // because exporting what is on screen needs no document row.
        ...(documentOps
          ? ([
              { kind: 'item', label: 'New design', icon: 'note_add', run: () => void documentOps.newDocument() },
              { kind: 'item', label: 'Make a copy', icon: 'file_copy', run: () => void documentOps.makeCopy() },
              { kind: 'sep' },
              { kind: 'item', label: 'Rename', icon: 'edit', run: () => void documentOps.rename() },
              { kind: 'item', label: 'Version history', icon: 'history', run: () => documentOps.openHistory() }
            ] as MenuDef['build'] extends () => infer R ? R : never)
          : []),
        {
          kind: 'submenu',
          label: 'Download',
          icon: 'download',
          items: [
            { kind: 'item', label: 'Image (.png)', run: () => a.exportAs('png') },
            { kind: 'item', label: 'PDF document (.pdf)', run: () => a.exportAs('pdf') }
          ]
        },
        ...(documentOps
          ? ([
              { kind: 'sep' },
              { kind: 'item', ...menuAction('moveToTrash'), icon: 'delete', run: () => void documentOps.moveToTrash() }
            ] as MenuDef['build'] extends () => infer R ? R : never)
          : [])
      ]
    },
    {
      id: 'edit',
      label: 'Edit',
      build: () => [
        { kind: 'item', ...menuAction('undo'), icon: 'undo', run: a.undo },
        { kind: 'item', ...menuAction('redo'), icon: 'redo', run: a.redo },
        { kind: 'sep' },
        { kind: 'item', ...menuAction('cut'), icon: 'content_cut', run: a.cutSelection, disabled: !a.hasSelection, hint: a.hasSelection ? undefined : 'Select something first' },
        { kind: 'item', ...menuAction('copy'), icon: 'content_copy', run: a.copySelection, disabled: !a.hasSelection, hint: a.hasSelection ? undefined : 'Select something first' },
        { kind: 'item', ...menuAction('paste'), icon: 'content_paste', run: a.pasteClipboard, disabled: !a.canPaste },
        { kind: 'item', ...menuAction('duplicate'), icon: 'file_copy', run: a.duplicateSelection, disabled: !a.hasSelection, hint: a.hasSelection ? undefined : 'Select something first' },
        { kind: 'item', ...menuAction('delete'), icon: 'delete', run: a.deleteSelected, disabled: !a.hasSelection, hint: a.hasSelection ? undefined : 'Select something first' },
        { kind: 'sep' },
        { kind: 'item', ...menuAction('selectAll'), icon: 'select_all', run: a.selectAll },
        { kind: 'item', ...menuAction('find'), icon: 'search', run: a.find },
        { kind: 'item', ...menuAction('findAndReplace'), icon: 'find_replace', run: a.findAndReplace },
        { kind: 'sep' },
        {
          kind: 'item',
          ...menuAction('saveAsSnippet'),
          icon: 'bookmark_add',
          hint: 'Keep it for reuse in any design',
          run: a.saveSelectionAsSnippet,
          disabled: !a.hasSelection
        }
      ]
    },
    {
      id: 'insert',
      label: 'Insert',
      build: () => [
        { kind: 'item', label: 'Text', icon: 'title', run: a.addText },
        { kind: 'item', label: 'Image', icon: 'image', run: a.addImageFromFile },
        {
          kind: 'submenu',
          label: 'Shape',
          icon: 'category',
          items: [
            { kind: 'item', label: 'Rectangle', run: () => a.addShape('rect') },
            { kind: 'item', label: 'Rounded rectangle', run: () => a.addShape('roundRect') },
            { kind: 'item', label: 'Ellipse', run: () => a.addShape('ellipse') },
            { kind: 'item', label: 'Triangle', run: () => a.addShape('triangle') }
          ]
        },
        { kind: 'item', label: 'Line', icon: 'horizontal_rule', run: a.addLine },
        { kind: 'sep' },
        { kind: 'item', label: 'Add page', icon: 'note_add', run: a.addPage },
        { kind: 'item', label: 'Page-number frame', icon: 'tag', run: a.insertPageNumber },
        { kind: 'sep' },
        { kind: 'item', ...menuAction('insertSnippet'), icon: 'bookmarks', run: a.insertSnippet },
        { kind: 'item', ...menuAction('workWidgetFromDesk'), icon: 'widgets', run: a.addWidget },
        // A meeting invites other people to a document by id. With no document
        // bound there is nothing to meet about, so the item is absent rather
        // than starting a meeting about id ''.
        ...(documentOps
          ? ([{ kind: 'sep' }, { kind: 'item', ...menuAction('meeting'), icon: 'videocam', run: () => documentOps.startMeeting() }] as MenuDef['build'] extends () => infer R ? R : never)
          : [])
      ]
    },
    {
      id: 'layout',
      label: 'Layout',
      build: () => [
        { kind: 'item', label: 'Margins, columns & layers…', icon: 'grid_on', run: a.openLayout },
        { kind: 'item', label: 'Paragraph styles…', icon: 'format_paint', run: a.openStyles },
        { kind: 'item', label: 'Swatches & spot inks…', icon: 'palette', run: a.openSwatches },
        { kind: 'item', label: 'Show layout guides', icon: a.aidsVisible ? 'visibility' : 'visibility_off', run: a.toggleAids, active: a.aidsVisible },
        { kind: 'item', label: 'Facing pages', icon: 'auto_stories', run: a.toggleFacing, active: a.facing },
        { kind: 'sep' },
        {
          kind: 'submenu',
          label: 'Master pages',
          icon: 'auto_stories',
          items: [
            { kind: 'item', label: 'New master page', icon: 'add', run: a.addMaster },
            ...(a.masters.length ? [{ kind: 'sep' as const }] : []),
            ...a.masters.map((m) => ({
              kind: 'item' as const,
              label: `Edit ${m.name}`,
              run: () => a.editMaster(a.editingMasterId === m.id ? null : m.id),
              active: a.editingMasterId === m.id
            })),
            ...(a.editingMasterId ? [{ kind: 'sep' as const }, { kind: 'item' as const, label: 'Stop editing master', run: () => a.editMaster(null) }] : [])
          ]
        },
        { kind: 'sep' },
        { kind: 'item', label: 'Add page', icon: 'note_add', run: a.addPage },
        { kind: 'item', label: 'Duplicate this page', icon: 'file_copy', run: () => a.duplicatePage(a.activePage) },
        { kind: 'sep' },
        { kind: 'item', label: 'Link text frames into one story', icon: 'link', run: a.linkFrames, disabled: !a.canLink },
        { kind: 'item', label: 'Unlink frame from its story', icon: 'link_off', run: a.unlinkFrame, disabled: !a.canUnlink }
      ]
    },
    {
      id: 'tools',
      label: 'Tools',
      build: () => [
        { kind: 'item', label: 'Remove image background', icon: 'auto_awesome', run: a.removeBgSelected },
        { kind: 'sep' },
        // Before the export, because it is what you do before the export.
        { kind: 'item', label: 'Preflight for print…', icon: 'fact_check', hint: a.preflightHint, run: a.openPreflight },
        { kind: 'item', label: 'Print PDF (bleed + crop marks)', icon: 'print', run: a.exportPrint }
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
      <MenuBarShell menus={menus} testid="design-menubar" />
      {shortcutsOpen && (
        <MenuModal title="Keyboard shortcuts" onClose={() => setShortcutsOpen(false)}>
          <div className="space-y-1.5">
            {([
              ['Undo', '⌘Z'],
              [menuAction('redo').label, menuAction('redo').shortcut!],
              [menuAction('duplicate').label, menuAction('duplicate').shortcut!],
              [menuAction('delete').label, menuAction('delete').shortcut!],
              [menuAction('selectAll').label, menuAction('selectAll').shortcut!],
              ['Drag from a ruler', 'adds a guide'],
              ['Click a guide', 'removes it'],
              ['Page number in a master', '{#}'],
              ['Total page count', '{pages}']
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
