import type { DocumentOps } from './documentOps'
import { documentCommands, menuItemOf } from '../../../lib/menus/officeCommand'
import { MenuBarShell, type MenuDef, type MenuItem } from './menuBarKit'

// The PlexiDiagrams menu bar. Document-level File actions come from the
// DocumentOps the host bound to the diagram on screen (never the documents
// store's `active`, which in a desk widget is some other document); the editor
// supplies everything else (import/export, Edit, View, Insert, Arrange, Help) as
// menu items wired to its real commands, so nothing here invents an action.
//
// The file name predates the PlexiDiagrams rename; PlexiDraw is now the separate
// vector + painting studio and has its own DrawStudioMenuBar.

export interface DrawMenuActions {
  // Extra File items (import / export), shown after the document actions.
  file: () => MenuItem[]
  edit: () => MenuItem[]
  view: () => MenuItem[]
  insert: () => MenuItem[]
  arrange: () => MenuItem[]
  help: () => MenuItem[]
  /**
   * The diagram on screen, bound by the host (createDocumentOps). Absent when it
   * is not a document (a diagram snippet session): then New, Make a copy,
   * Rename, Version history, Start a meeting and Move to trash are not shown at
   * all; the editor's own import/export items stay.
   */
  documentOps?: DocumentOps
}

export default function DrawMenuBar({ actions }: { actions: DrawMenuActions }): JSX.Element {
  const a = actions
  // File's document rows, built from the host-bound ops (documentCommands): absent with none.
  const doc = documentCommands(a.documentOps, 'map')

  const menus: MenuDef[] = [
    {
      id: 'file',
      label: 'File',
      build: (): MenuItem[] =>
        doc
          ? [
              menuItemOf(doc.newDocument),
              menuItemOf(doc.makeCopy),
              { kind: 'sep' },
              menuItemOf(doc.rename),
              menuItemOf(doc.versionHistory),
              { kind: 'sep' },
              ...(doc.print ? [menuItemOf(doc.print)] : []),
              ...a.file(),
              { kind: 'sep' },
              menuItemOf(doc.moveToTrash)
            ]
          : a.file()
    },
    { id: 'edit', label: 'Edit', build: a.edit },
    { id: 'view', label: 'View', build: a.view },
    // The meeting item ends Insert, as in every office app (SPEC §9.2), not File.
    { id: 'insert', label: 'Insert', build: () => [...a.insert(), ...(doc ? [{ kind: 'sep' as const }, menuItemOf(doc.meeting)] : [])] },
    { id: 'arrange', label: 'Arrange', build: a.arrange },
    { id: 'help', label: 'Help', build: a.help }
  ]

  return <MenuBarShell menus={menus} testid="draw-menubar" />
}
