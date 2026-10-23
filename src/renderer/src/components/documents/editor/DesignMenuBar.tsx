import { useState } from 'react'
// No documents store, no view store, no meeting or history helpers here: every
// document action comes from the host through DocumentOps, bound to the
// document actually on screen (documentOps.ts, and the guard test that keeps
// this list of imports honest).
import { MenuBarShell, MenuModal, type MenuDef } from './menuBarKit'
import type { DocumentOps } from './documentOps'
import { menuAction } from '../../../lib/menus/menuAction'
import { documentCommands, menuItemOf } from '../../../lib/menus/officeCommand'
import type { DesignCommands } from '../design/designCommands'

// A menu bar for PlexiDesign — the free-form page designer. Its menus fit what a
// layout program does: place text frames, shapes, lines and images anywhere on
// the page; thread a story through linked frames; set margins, columns, guides
// and master pages; and send the result to print with bleed and crop marks.
// Every item is wired to a real DesignEditor op or a documents-store action.

export interface DesignMenuActions {
  /** The shared actions, defined once (design/designCommands). */
  cmds: DesignCommands
  title: string
  exportAs: (format: 'png' | 'pdf') => void
  // ── Master pages: one Edit row per master, each from cmds.editMaster ──────
  editMaster: (id: string | null) => void
  masters: Array<{ id: string; name: string }>
  editingMasterId: string | null
  exportPrint: () => void
  /** Open the print check: what would go wrong on press, measured. */
  openPreflight: () => void
  /** Save the selected elements as a reusable snippet. */
  saveSelectionAsSnippet: () => void
  /** Something is selected on the page, so the selection items are live. */
  hasSelection: boolean
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
  // File's document rows, built from the host-bound ops (documentCommands): absent with none.
  const doc = documentCommands(documentOps, 'design')

  const menus: MenuDef[] = [
    {
      id: 'file',
      label: 'File',
      build: () => [
        // Every document item acts through the host's ops, BY ID. With no
        // document bound (a snippet session) they are absent; Download stays,
        // because exporting what is on screen needs no document row.
        ...(doc
          ? ([
              menuItemOf(doc.newDocument),
              menuItemOf(doc.makeCopy),
              { kind: 'sep' },
              menuItemOf(doc.rename),
              menuItemOf(doc.versionHistory),
              ...(doc.print ? [menuItemOf(doc.print)] : [])
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
        ...(doc
          ? ([{ kind: 'sep' }, menuItemOf(doc.moveToTrash)] as MenuDef['build'] extends () => infer R ? R : never)
          : [])
      ]
    },
    {
      id: 'edit',
      label: 'Edit',
      build: () => [
        // From Design's registry (designCommands), the same definitions the
        // ribbon and the right-click menu use: one gate, so a viewer's Edit menu
        // is off where the bar is, with the shell's READ_ONLY_REASON.
        menuItemOf(a.cmds.undo, { icon: 'undo' }),
        menuItemOf(a.cmds.redo, { icon: 'redo' }),
        { kind: 'sep' },
        menuItemOf(a.cmds.cut, { icon: 'content_cut' }),
        menuItemOf(a.cmds.copy, { icon: 'content_copy' }),
        menuItemOf(a.cmds.paste, { icon: 'content_paste' }),
        menuItemOf(a.cmds.duplicate, { icon: 'file_copy' }),
        menuItemOf(a.cmds.remove, { icon: 'delete' }),
        { kind: 'sep' },
        menuItemOf(a.cmds.selectAll, { icon: 'select_all' }),
        menuItemOf(a.cmds.find),
        menuItemOf(a.cmds.findAndReplace),
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
        // Every row from Design's registry (designCommands), so a viewer's
        // Insert menu is off with the shell's READ_ONLY_REASON, as the bar is.
        menuItemOf(a.cmds.insertText),
        menuItemOf(a.cmds.insertImage),
        {
          kind: 'submenu',
          label: 'Shape',
          icon: 'category',
          items: [menuItemOf(a.cmds.insertRect), menuItemOf(a.cmds.insertRoundRect), menuItemOf(a.cmds.insertEllipse), menuItemOf(a.cmds.insertTriangle)]
        },
        menuItemOf(a.cmds.insertLine),
        { kind: 'sep' },
        // Add page lives once in the bar, with the other page actions (Layout).
        menuItemOf(a.cmds.insertPageNumber),
        { kind: 'sep' },
        menuItemOf(a.cmds.insertSnippet, { icon: 'bookmarks' }),
        menuItemOf(a.cmds.insertWidget),
        // A meeting invites other people to a document by id. With no document
        // bound there is nothing to meet about, so the item is absent rather
        // than starting a meeting about id ''.
        ...(doc
          ? ([{ kind: 'sep' }, menuItemOf(doc.meeting)] as MenuDef['build'] extends () => infer R ? R : never)
          : [])
      ]
    },
    {
      id: 'layout',
      label: 'Layout',
      build: () => [
        // From the registry too: the panels, Facing pages, the master pages and
        // the page and story rows change the design (off for a viewer); Show
        // layout guides is the viewer's own view and stays live.
        menuItemOf(a.cmds.layoutPanel),
        menuItemOf(a.cmds.stylesPanel),
        menuItemOf(a.cmds.swatchesPanel),
        menuItemOf(a.cmds.toggleGuides),
        menuItemOf(a.cmds.facing),
        { kind: 'sep' },
        {
          kind: 'submenu',
          label: 'Master pages',
          icon: 'auto_stories',
          items: [
            menuItemOf(a.cmds.newMaster),
            ...(a.masters.length ? [{ kind: 'sep' as const }] : []),
            // One row per master, each from the one Edit-master definition: its gate, this master's label and run.
            ...a.masters.map((m) =>
              menuItemOf(a.cmds.editMaster, {
                label: `Edit ${m.name}`,
                run: () => a.editMaster(a.editingMasterId === m.id ? null : m.id),
                active: a.editingMasterId === m.id
              })
            ),
            ...(a.editingMasterId ? [{ kind: 'sep' as const }, menuItemOf(a.cmds.stopEditingMaster)] : [])
          ]
        },
        { kind: 'sep' },
        menuItemOf(a.cmds.addPage),
        menuItemOf(a.cmds.duplicatePage),
        { kind: 'sep' },
        menuItemOf(a.cmds.linkFrames),
        menuItemOf(a.cmds.unlinkFrame)
      ]
    },
    {
      id: 'tools',
      label: 'Tools',
      build: () => [
        menuItemOf(a.cmds.removeBackground),
        { kind: 'sep' },
        // Before the export, because it is what you do before the export.
        { kind: 'item', label: 'Preflight for print…', icon: 'fact_check', hint: a.preflightHint, run: a.openPreflight },
        // Reads the design: live for a viewer, here and on the bar's Review tab.
        menuItemOf(a.cmds.checkA11y),
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
